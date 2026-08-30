import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("email/sms delivery migration keeps voom_campaigns canonical and makes approval server-verified", async () => {
  const sql = await read("supabase/migrations/0018_email_sms_delivery.sql");

  assert.match(sql, /Prepared for review; do not apply without explicit approval/);
  assert.match(sql, /alter table public\.voom_campaigns\s+add column if not exists approved_at timestamptz/i);
  assert.match(sql, /add constraint voom_campaigns_approved_at_requires_approved_status\s+check \(approved_at is null or status = 'approved'\)/i);
  assert.match(sql, /update public\.voom_campaigns\s+set approved_at = coalesce\(approved_at, updated_at, created_at, now\(\)\)\s+where status = 'approved' and approved_at is null/i);
  assert.match(sql, /Backwards?-compatible for the existing create\/edit\/approve\/reject flow/i);
  assert.match(sql, /grant select, insert, update on table public\.voom_campaigns to authenticated/i);
  assert.match(sql, /create or replace function public\.set_voom_campaign_approval\(/i);
  assert.match(sql, /security definer[\s\S]+set search_path = ''/i);
  assert.match(sql, /approved_at = case when v_action = 'approve' then coalesce\(approved_at, now\(\)\) else null end/i);
  assert.match(sql, /revoke all on function public\.set_voom_campaign_approval\(uuid, uuid, text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.set_voom_campaign_approval\(uuid, uuid, text\) to service_role/i);
});

test("campaign recipients are owner-scoped, validated by kind, and not browser-writable", async () => {
  const sql = await read("supabase/migrations/0018_email_sms_delivery.sql");

  assert.match(sql, /create table if not exists public\.campaign_recipients/i);
  assert.match(sql, /kind text not null check \(kind in \('email', 'sms'\)\)/i);
  assert.match(sql, /contact text not null check \([\s\S]*kind = 'email'[\s\S]*contact ~\*[\s\S]*kind = 'sms'[\s\S]*contact ~ '\^\\\+\[1-9\]\[0-9\]\{7,14\}\$'/i);
  assert.match(sql, /unique \(owner_user_id, campaign_id, contact\)/i);
  assert.match(sql, /foreign key \(campaign_id, owner_user_id\)[\s\S]*references public\.voom_campaigns \(id, owner_user_id\) on delete cascade/i);
  assert.match(sql, /alter table public\.campaign_recipients enable row level security/i);
  assert.match(sql, /grant select on table public\.campaign_recipients to authenticated/i);
  assert.doesNotMatch(sql, /grant[^;]+campaign_recipients[^;]+to authenticated[^;]*(insert|update|delete)/i);
  assert.match(sql, /create policy "campaign_recipients_select_own" on public\.campaign_recipients[\s\S]+auth\.uid\(\)[\s\S]+owner_user_id/i);
  assert.match(sql, /create or replace function public\.add_campaign_recipient\(/i);
  assert.match(sql, /invalid_email_contact/);
  assert.match(sql, /invalid_sms_contact/);
  assert.match(sql, /revoke all on function public\.add_campaign_recipient\(uuid, uuid, text, text, timestamptz, text\) from public, anon, authenticated/i);
  assert.match(sql, /grant execute on function public\.add_campaign_recipient\(uuid, uuid, text, text, timestamptz, text\) to service_role/i);
});

test("campaign sends and delivery events preserve truthful states and dedupe delivery", async () => {
  const sql = await read("supabase/migrations/0018_email_sms_delivery.sql");

  assert.match(sql, /create table if not exists public\.campaign_sends/i);
  assert.match(sql, /internal_status text not null default 'queued' check \(internal_status in \('queued', 'sending', 'accepted', 'delivered', 'failed', 'skipped'\)\)/i);
  assert.doesNotMatch(sql, /internal_status[\s\S]*'sent'/i);
  assert.match(sql, /check \(claimed_at is not null or internal_status not in \('sending', 'accepted', 'delivered'\)\)/i);
  assert.match(sql, /check \(accepted_at is not null or internal_status not in \('accepted', 'delivered'\)\)/i);
  assert.match(sql, /check \(delivered_at is not null or internal_status <> 'delivered'\)/i);
  assert.match(sql, /create unique index if not exists campaign_sends_idempotency_idx[\s\S]+\(owner_user_id, idempotency_key\)/i);
  assert.match(sql, /create unique index if not exists campaign_sends_campaign_recipient_idx[\s\S]+\(owner_user_id, campaign_id, recipient_id\)/i);
  assert.match(sql, /create unique index if not exists campaign_sends_provider_message_idx[\s\S]+\(provider, provider_message_id\)[\s\S]+where provider_message_id is not null/i);
  assert.match(sql, /grant select on table public\.campaign_sends to authenticated/i);
  assert.doesNotMatch(sql, /grant[^;]+campaign_sends[^;]+to authenticated[^;]*(insert|update|delete)/i);
  assert.match(sql, /create policy "campaign_sends_select_own" on public\.campaign_sends[\s\S]+auth\.uid\(\)[\s\S]+owner_user_id/i);

  assert.match(sql, /create or replace function public\.claim_campaign_send\(/i);
  assert.match(sql, /pg_catalog\.pg_advisory_xact_lock/i);
  assert.match(sql, /campaign_not_approved/);
  assert.match(sql, /recipient_opted_out/);
  assert.match(sql, /internal_status = 'failed'[\s\S]+internal_status = 'sending'/i);
  assert.match(sql, /create or replace function public\.record_campaign_send_provider_result\(/i);
  assert.match(sql, /v_outcome not in \('accepted', 'failed'\)/i);
  assert.match(sql, /internal_status = 'accepted'/i);
  assert.doesNotMatch(sql.match(/create or replace function public\.record_campaign_send_provider_result\([\s\S]+?\$\$;/i)?.[0] ?? "", /update public\.campaign_sends[\s\S]+internal_status = 'delivered'/i);

  assert.match(sql, /create table if not exists public\.campaign_delivery_events/i);
  assert.match(sql, /create unique index if not exists campaign_delivery_events_dedupe_idx[\s\S]+\(owner_user_id, provider, event_id\)/i);
  assert.match(sql, /grant select, insert on table public\.campaign_delivery_events to service_role/i);
  assert.doesNotMatch(sql, /grant[^;]+campaign_delivery_events[^;]+to authenticated/i);
  assert.match(sql, /create or replace function public\.record_campaign_delivery_event\(/i);
  assert.match(sql, /on conflict \(owner_user_id, provider, event_id\) do nothing/i);
  assert.match(sql, /internal_status = 'delivered'/i);
  assert.match(sql, /internal_status = 'accepted'/i);
  assert.match(sql, /internal_status = 'failed'/i);
  assert.match(sql, /The provider reported that delivery failed\./i);
});

test("delivery RPCs remain privileged and service-role-only", async () => {
  const sql = await read("supabase/migrations/0018_email_sms_delivery.sql");

  for (const name of [
    "set_voom_campaign_approval",
    "add_campaign_recipient",
    "claim_campaign_send",
    "record_campaign_send_provider_result",
    "record_campaign_delivery_event",
  ]) {
    assert.match(sql, new RegExp(`create or replace function public\\.${name}\\([\\s\\S]+?security definer[\\s\\S]+?set search_path = ''`, "i"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${name}\\([^\\)]*\\) from public, anon, authenticated`, "i"));
    assert.match(sql, new RegExp(`grant execute on function public\\.${name}\\([^\\)]*\\) to service_role`, "i"));
  }
});
