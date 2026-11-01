-- VOOM independent YouTube deletion register (Cloudflare D1 / SQLite).
-- Minimal restore evidence only: VOOM event/owner UUIDs, scope, timestamps,
-- payload fingerprints and receipts. NEVER Google tokens, channel/video IDs,
-- email addresses, names, titles or media.

create table if not exists register_records (
  record_id text primary key,              -- VOOM event id, or "<event id>:active-erasure"
  kind text not null check (kind in ('intent', 'completion')),
  request_id text not null,                -- the VOOM deletion event id
  owner_id text not null,                  -- VOOM auth user UUID (pseudonymous)
  scope text not null check (scope in ('erase', 'retention')),
  received_at text not null,               -- original VOOM receipt; never reset by retries
  deadline_at text,                        -- erase: received_at + 7 days
  cutoff_at text,                          -- retention cutoff
  applied_at text,                         -- completion only
  payload_sha256 text not null,            -- fingerprint of the exact delivered body
  receipt_id text not null unique,         -- deterministic from record_id + fingerprint
  stored_at text not null,
  check ((kind = 'completion') = (applied_at is not null)),
  check ((scope = 'retention') = (cutoff_at is not null)),
  check ((scope = 'erase') = (deadline_at is not null))
);
create index if not exists register_by_request on register_records (request_id);
create index if not exists register_by_owner on register_records (owner_id);
create index if not exists register_by_received on register_records (received_at);

create table if not exists register_alerts (
  alert_id text primary key,               -- "<request id>:<code>" (VOOM) or watchdog key
  request_id text not null,
  code text not null,
  source text not null check (source in ('voom', 'watchdog')),
  received_at text,
  urgent integer not null default 0 check (urgent in (0, 1)),
  payload_sha256 text not null,
  receipt_id text not null unique,
  stored_at text not null,
  email_status text not null default 'pending' check (email_status in ('pending', 'sent')),
  email_attempts integer not null default 0,
  email_sent_at text,
  next_email_at text not null
);
create index if not exists register_alerts_pending on register_alerts (next_email_at) where email_status = 'pending';

create table if not exists register_heartbeats (
  source text primary key check (source in ('voom', 'watchdog')),
  last_seen_at text not null
);

create table if not exists register_usage (
  day text primary key,                    -- UTC YYYY-MM-DD
  writes integer not null default 0
);

-- Purges are only possible inside the same transaction that opens this gate.
create table if not exists register_control (
  id integer primary key check (id = 1),
  purge_open integer not null default 0 check (purge_open in (0, 1))
);
insert into register_control (id) values (1) on conflict (id) do nothing;

-- Records are append-only: no update ever, delete only through the approved
-- retention purge. Defends against application bugs and accidental edits;
-- cross-checked weekly against VOOM's own receipts (tamper evidence).
create trigger if not exists register_records_no_update before update on register_records
begin select raise(abort, 'register_append_only'); end;
create trigger if not exists register_records_no_delete before delete on register_records
when (select purge_open from register_control where id = 1) = 0
begin select raise(abort, 'register_append_only'); end;

-- Alert identity/evidence is immutable; only delivery bookkeeping may change.
create trigger if not exists register_alerts_immutable before update on register_alerts
when new.alert_id is not old.alert_id or new.request_id is not old.request_id or new.code is not old.code
  or new.source is not old.source or new.received_at is not old.received_at or new.urgent is not old.urgent
  or new.payload_sha256 is not old.payload_sha256 or new.receipt_id is not old.receipt_id or new.stored_at is not old.stored_at
  or (old.email_status = 'sent' and new.email_status is not 'sent')
begin select raise(abort, 'register_alert_immutable'); end;
create trigger if not exists register_alerts_no_delete before delete on register_alerts
when (select purge_open from register_control where id = 1) = 0
begin select raise(abort, 'register_append_only'); end;
