// Instagram deauthorize + data-deletion callbacks (0078). Synthetic data only:
// no real Meta secret, account, token or Production database is used.
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test, { before, after } from 'node:test';
import { createSupabaseLite } from './helpers/pglite-supabase.mjs';
import { verifyLifecycleRequest, handleLifecycle, lifecycleConfig } from '../lib/instagram/lifecycle.ts';
import { deletionStatusMessage, renderDeletionStatus } from '../lib/instagram/deletion-status-page.ts';

const config = { appId: '1798088134709951', appSecret: 'synthetic-test-secret-only', publicOrigin: 'https://review.example.invalid' };
const now = Date.now();
const nowSec = Math.floor(now / 1000);
const without = (value, key) => { const copy = { ...value }; delete copy[key]; return copy; };
const payload = (o = {}) => ({ algorithm: 'HMAC-SHA256', user_id: '17841400000000001', issued_at: nowSec, ...o });
function signed(value = payload(), secret = config.appSecret) {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  return createHmac('sha256', secret).update(encoded).digest('base64url') + '.' + encoded;
}
const form = (body, type = 'application/x-www-form-urlencoded') =>
  new Request('https://callback.example.invalid/', { method: 'POST', headers: { 'Content-Type': type }, body });
const request = (value = signed()) => form(new URLSearchParams({ signed_request: value }));
const mustNotRun = async () => { throw Error('database must not be called'); };

// ---------- 1. Request verification and HTTP contract ----------

test('valid signature with the Instagram app secret is accepted; documented fields are read exactly', () => {
  const e = verifyLifecycleRequest(signed(), config, 'deletion', now);
  assert.equal(e.subjectId, '17841400000000001'); assert.equal(e.issuedAt, nowSec); assert.equal(e.appId, config.appId);
  assert.match(e.eventKey, /^[a-f0-9]{64}$/);
  // Delayed Meta retries stay actionable.
  assert.equal(verifyLifecycleRequest(signed(payload({ issued_at: 1000 })), config, 'deletion', now).issuedAt, 1000);
  // issued_at is not documented as always present: accepted as null (SQL then never treats a connection as superseded).
  assert.equal(verifyLifecycleRequest(signed(without(payload(), 'issued_at')), config, 'deauthorize', now).issuedAt, null);
});

test('event fingerprint ignores encoding/field order/extra fields but separates kind, subject and time', () => {
  const a = verifyLifecycleRequest(signed(payload()), config, 'deletion', now).eventKey;
  const reordered = signed({ issued_at: nowSec, user_id: '17841400000000001', algorithm: 'HMAC-SHA256', expires: 0 });
  assert.equal(verifyLifecycleRequest(reordered, config, 'deletion', now).eventKey, a);
  assert.notEqual(verifyLifecycleRequest(signed(payload()), config, 'deauthorize', now).eventKey, a);
  assert.notEqual(verifyLifecycleRequest(signed(payload({ user_id: '2' })), config, 'deletion', now).eventKey, a);
  assert.notEqual(verifyLifecycleRequest(signed(payload({ issued_at: nowSec - 1 })), config, 'deletion', now).eventKey, a);
});

const rejected = {
  wrongSecret: signed(payload(), 'wrong-secret'),
  parentSecretNotConfigured: signed(payload(), 'synthetic-parent-secret'),
  wrongAlgorithm: signed(payload({ algorithm: 'none' })),
  missingAlgorithm: signed(without(payload(), 'algorithm')),
  missingUserId: signed(without(payload(), 'user_id')),
  numericUserId: signed(payload({ user_id: 17841400000000001 })),
  nonDigitUserId: signed(payload({ user_id: 'owner@example.invalid' })),
  futureIssuedAt: signed(payload({ issued_at: nowSec + 900 })),
  fractionalIssuedAt: signed(payload({ issued_at: 1.5 })),
  wrongApp: signed(payload({ app_id: '99' })),
  threeParts: 'a.b.c',
  onePart: 'abc',
  badBase64: '!!!.???',
  nonCanonicalBase64: signed().replace(/^(.)/, (c) => c) + '=',
  emptyString: '',
};
for (const [name, value] of Object.entries(rejected)) {
  test(`rejects ${name} with 400 before any database action and leaks nothing`, async () => {
    let calls = 0;
    const res = await handleLifecycle(request(value), 'deletion', config, async () => { calls++; throw Error('secret detail'); });
    assert.equal(res.status, 400); assert.equal(calls, 0);
    const text = await res.text();
    assert.doesNotMatch(text, /secret|17841400000000001|stack/i);
  });
}

test('malformed requests fail closed: body cap, duplicate field, missing field, wrong content type, JSON body', async () => {
  const cases = [
    form('x'.repeat(8193)),
    form('signed_request=a&signed_request=b'),
    form('other=1'),
    form(new URLSearchParams({ signed_request: signed() }).toString(), 'application/json'),
    form('{"signed_request":"x"}', 'application/json'),
    new Request('https://callback.example.invalid/', { method: 'POST' }),
  ];
  for (const req of cases) assert.equal((await handleLifecycle(req, 'deletion', config, mustNotRun)).status, 400);
});

test('deletion answers Meta with {url, confirmation_code}; deauthorize with a plain acknowledgement; no identity echoed', async () => {
  let event; const code = 'b'.repeat(32);
  const res = await handleLifecycle(request(), 'deletion', config, async (e) => { event = e; return { confirmation_code: code }; });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { url: `${config.publicOrigin}/data-deletion/status?code=${code}`, confirmation_code: code });
  assert.equal(res.headers.get('cache-control'), 'no-store'); assert.equal(event.kind, 'deletion');
  const de = await handleLifecycle(request(), 'deauthorize', config, async () => ({ confirmation_code: code }));
  assert.equal(de.status, 200); assert.deepEqual(await de.json(), { received: true });
});

test('operational failures return 503 so Meta retries; a malformed receipt code is never acknowledged', async () => {
  assert.equal((await handleLifecycle(request(), 'deletion', config, async () => { throw Error('db down'); })).status, 503);
  assert.equal((await handleLifecycle(request(), 'deletion', config, async () => ({ confirmation_code: 'not-a-code' }))).status, 503);
  assert.equal((await handleLifecycle(request(), 'deletion', null, mustNotRun)).status, 503);
});

test('configuration: off by default, Production-only, app id must match, https origin only; optional fallback secret/parent id', async () => {
  const env = { INSTAGRAM_LIFECYCLE_ENABLED: 'on', INSTAGRAM_LIFECYCLE_APP_ID: config.appId, META_APP_ID: config.appId,
    META_APP_SECRET: config.appSecret, INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN: config.publicOrigin };
  const ok = lifecycleConfig(env);
  assert.deepEqual(ok, config);
  for (const change of [{ INSTAGRAM_LIFECYCLE_ENABLED: '' }, { INSTAGRAM_LIFECYCLE_ENABLED: 'true' }, { META_APP_ID: '42' }, { META_APP_SECRET: '' },
    { VERCEL_ENV: 'preview' }, { VERCEL_ENV: 'development' }, { INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN: 'http://review.example.invalid' },
    { INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN: 'https://user:pass@review.example.invalid' }, { INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN: 'https://review.example.invalid/path' },
    { INSTAGRAM_LIFECYCLE_PARENT_APP_ID: 'abc' }]) {
    assert.equal(lifecycleConfig({ ...env, ...change }), null, JSON.stringify(change));
  }
  assert.ok(lifecycleConfig({ ...env, VERCEL_ENV: 'production' }));
  // Fallback: verification-only, used if Meta turns out to sign with the parent Meta app secret.
  const fb = lifecycleConfig({ ...env, INSTAGRAM_LIFECYCLE_FALLBACK_APP_SECRET: 'synthetic-parent-secret', INSTAGRAM_LIFECYCLE_PARENT_APP_ID: '2118000000000000' });
  const viaParent = verifyLifecycleRequest(signed(payload({ app_id: '2118000000000000' }), 'synthetic-parent-secret'), fb, 'deletion', now);
  // Same event fingerprint regardless of which secret signed it (it is keyed with the primary secret).
  assert.equal(viaParent.eventKey, verifyLifecycleRequest(signed(payload()), config, 'deletion', now).eventKey);
  assert.throws(() => verifyLifecycleRequest(signed(payload(), 'other'), fb, 'deletion', now), /invalid_request/);
  assert.throws(() => verifyLifecycleRequest(signed(payload({ app_id: '2118000000000000' })), config, 'deletion', now), /invalid_request/);
});

// ---------- 2. Database behaviour (real migrations on embedded PostgreSQL) ----------

let db; let seq = 0;
before(async () => { ({ db } = await createSupabaseLite()); });
after(() => db?.close());
const q = async (sql, args = []) => (await db.query(sql, args)).rows;
const accept = async (subject, kind, issuedAt = new Date(), key = null) =>
  (await q('select public.accept_instagram_callback($1,$2,$3,$4,$5) as code',
    [config.appId, subject, kind, issuedAt, key ?? createHmac('sha256', 'k').update(`${kind}:${subject}:${issuedAt?.toISOString?.()}:${++seq}`).digest('hex')]))[0].code;
const receipt = async (code) => (await q('select * from public.instagram_callback_receipts where confirmation_code=$1', [code]))[0];
const conn = async (owner) => (await q('select * from public.instagram_connections where owner_user_id=$1', [owner]))[0];
const secretCount = async (owner) => Number((await q('select count(*) n from public.instagram_connection_secrets where owner_user_id=$1', [owner]))[0].n);

async function owner(subject, { username = 'same_username', connectedAgo = '2 days' } = {}) {
  const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
  await q('insert into auth.users(id) values($1)', [id]);
  await q(`select public.save_instagram_connection($1,$2,$3,null,'BUSINESS',null,array['instagram_business_basic','instagram_business_content_publish'],now()+interval '50 days','cipher','iv','tag',1::smallint)`, [id, subject, username]);
  await q(`update public.instagram_connections set connected_at=now()-$2::interval where owner_user_id=$1`, [id, connectedAgo]);
  return id;
}
async function seedData(id) {
  const conv = (await q('insert into public.mara_conversations (owner_user_id) values ($1) returning id', [id]))[0].id;
  const draft = async (title) => (await q(`insert into public.mara_drafts (owner_user_id, conversation_id, kind, channel, title, content, status) values ($1,$2,'instagram_post','instagram',$3,'My own caption','approved') returning id`, [id, conv, title]))[0].id;
  const d1 = await draft('published one'), d2 = await draft('failed one');
  await q(`insert into public.instagram_publish_queue (owner_user_id, draft_id, media_kind, caption, scheduled_at, status, idempotency_key, container_id, instagram_media_id, published_at)
           values ($1,$2,'image','c',now(),'published',$3,$6,$7,now()), ($1,$4,'image','c',now(),'failed',$5,$8,null,null)`,
    [id, d1, `idem-published-${id}`, d2, `idem-failed-${id}`, `cont-1-${id}`, `media-${id}`, `cont-2-${id}`]);
  await q(`insert into public.instagram_insight_snapshots (owner_user_id, instagram_media_id, period_start, period_end, metrics) values ($1,$2,now()-interval '1 day',now(),'{"reach":5}')`, [id, `media-${id}`]);
  await q(`insert into public.instagram_performance_snapshots (owner_user_id, instagram_media_id, content_type, published_at, collected_at, metrics) values ($1,$2,'post',now(),now(),'{"reach":5}')`, [id, `media-${id}`]);
  await q(`insert into public.instagram_oauth_states (state_hash, owner_user_id, expires_at) values ($1,$2,now()+interval '5 minutes')`, [`state-${id}`, id]);
  return { d1, d2 };
}
const counts = async (id) => Object.fromEntries(await Promise.all(
  ['instagram_connection_secrets', 'instagram_insight_snapshots', 'instagram_performance_snapshots', 'instagram_oauth_states', 'mara_drafts', 'instagram_publish_queue']
    .map(async (t) => [t, Number((await q(`select count(*) n from public.${t} where owner_user_id=$1`, [id]))[0].n)])));

test('deauthorize disconnects every connection for that exact Instagram id and nothing else', async () => {
  const subject = '17841400000000101';
  const a = await owner(subject), b = await owner(subject), other = await owner('17841400000000102'); // same username, other account
  const code = await accept(subject, 'deauthorize');
  const r = await receipt(code);
  assert.equal(r.status, 'disconnected'); assert.deepEqual(new Set(r.matched_owner_ids), new Set([a, b])); assert.ok(r.credentials_revoked_at);
  for (const id of [a, b]) { assert.equal((await conn(id)).status, 'disconnected'); assert.equal(await secretCount(id), 0); assert.equal((await conn(id)).token_expires_at, null); }
  assert.equal((await conn(other)).status, 'connected'); assert.equal(await secretCount(other), 1);
  // Future actions are blocked through the EXISTING paths: publishing reads credentials via
  // get_instagram_connection_secret (needs a secret row + 'connected'); renewal claims only 'connected' rows.
  assert.equal((await q('select * from public.get_instagram_connection_secret($1)', [a])).length, 0);
  const claimable = await q(`select owner_user_id from public.claim_instagram_token_refreshes(50, interval '55 days', interval '5 minutes')`);
  assert.ok(!claimable.some((row) => row.owner_user_id === a || row.owner_user_id === b));
  assert.ok(claimable.some((row) => row.owner_user_id === other));
});

test('a connection re-authorised after Meta signed the event is not revoked (superseded), and is recorded', async () => {
  const subject = '17841400000000201';
  const fresh = await owner(subject, { connectedAgo: '1 minute' });
  const code = await accept(subject, 'deauthorize', new Date(Date.now() - 3600_000));
  const r = await receipt(code);
  assert.equal(r.status, 'no_match'); assert.deepEqual(r.superseded_owner_ids, [fresh]);
  assert.equal((await conn(fresh)).status, 'connected'); assert.equal(await secretCount(fresh), 1);
});

test('missing issued_at: authenticated request still disconnects (fail toward stopping actions)', async () => {
  const subject = '17841400000000251'; const id = await owner(subject, { connectedAgo: '1 minute' });
  const r = await receipt(await accept(subject, 'deauthorize', null));
  assert.equal(r.status, 'disconnected'); assert.equal((await conn(id)).status, 'disconnected');
});

test('duplicate delivery returns the same code and takes no second action', async () => {
  const subject = '17841400000000301'; const id = await owner(subject);
  const key = 'a'.repeat(64);
  const first = await accept(subject, 'deauthorize', new Date(Date.now() - 60_000), key);
  // The person reconnects; a late duplicate of the OLD event must not disconnect the new authorisation.
  await q(`select public.save_instagram_connection($1,$2,'u',null,'BUSINESS',null,array['instagram_business_basic'],now()+interval '50 days','c2','iv2','tag2',1::smallint)`, [id, subject]);
  const second = await accept(subject, 'deauthorize', new Date(Date.now() - 60_000), key);
  assert.equal(second, first);
  assert.equal(Number((await q('select count(*) n from public.instagram_callback_receipts where event_key=$1', [key]))[0].n), 1);
  assert.equal((await conn(id)).status, 'connected'); assert.equal(await secretCount(id), 1);
});

test('unmatched callbacks are kept for review, never guessed onto another account', async () => {
  const bystander = await owner('17841400000000401');
  const de = await receipt(await accept('17841400000000499', 'deauthorize'));
  assert.equal(de.status, 'no_match'); assert.deepEqual(de.matched_owner_ids, []);
  const del = await receipt(await accept('17841400000000498', 'deletion'));
  assert.equal(del.status, 'awaiting_erasure'); assert.equal(del.credentials_revoked_at, null);
  assert.equal((await conn(bystander)).status, 'connected');
});

test('invalid database inputs are refused', async () => {
  for (const args of [[config.appId, 'abc', 'deletion'], [config.appId, '1', 'delete'], ['x', '1', 'deletion']]) {
    await assert.rejects(q('select public.accept_instagram_callback($1,$2,$3,now(),$4)', [...args, 'c'.repeat(64)]), /invalid_callback/);
  }
  await assert.rejects(q('select public.accept_instagram_callback($1,$2,$3,now(),$4)', [config.appId, '1', 'deletion', 'short']), /invalid_callback/);
});

test('deletion: revoke on receipt -> operator erasure -> human review -> completed; never early', async () => {
  const subject = '17841400000000501';
  const id = await owner(subject); const { d1, d2 } = await seedData(id);
  const other = await owner('17841400000000502'); await seedData(other);
  const before = await counts(other);
  const code = await accept(subject, 'deletion');
  let r = await receipt(code);
  assert.equal(r.status, 'awaiting_erasure'); assert.deepEqual(r.matched_owner_ids, [id]); assert.ok(r.credentials_revoked_at);
  assert.equal(await secretCount(id), 0);
  assert.equal((await q('select status from public.instagram_deletion_status($1)', [code]))[0].status, 'awaiting_erasure');

  const review = (o = {}) => q('select public.complete_instagram_deletion($1,$2,$3,$4,$5,$6,$7)',
    [code, o.by ?? 'VOOM owner', o.ref ?? 'CASE-2026-0001', 'identity' in o ? o.identity : true, 'history' in o ? o.history : true, 'processors' in o ? o.processors : true, o.backups === undefined ? new Date(Date.now() + 8 * 86400_000) : o.backups]);
  await assert.rejects(review(), /erasure_not_finished/);

  const summary = (await q('select public.erase_instagram_deletion_data($1) as s', [code]))[0].s;
  assert.deepEqual({ ...summary }, { owners: 1, secrets: 0, profiles_scrubbed: 1, insight_snapshots: 1, performance_snapshots: 1, oauth_states: 1, unpublished_provider_ids: 1, published_items_for_review: 1 });
  const c = await conn(id);
  assert.equal(c.username, 'erased'); assert.equal(c.instagram_user_id, 'erased'); assert.deepEqual(c.scopes, []); assert.equal(c.status, 'disconnected');
  const after = await counts(id);
  assert.equal(after.instagram_insight_snapshots, 0); assert.equal(after.instagram_performance_snapshots, 0); assert.equal(after.instagram_oauth_states, 0);
  assert.equal(after.mara_drafts, 2, 'user-authored drafts are kept'); assert.equal(after.instagram_publish_queue, 2);
  const failed = (await q('select container_id, instagram_media_id from public.instagram_publish_queue where draft_id=$1', [d2]))[0];
  assert.deepEqual(failed, { container_id: null, instagram_media_id: null });
  const published = (await q('select instagram_media_id from public.instagram_publish_queue where draft_id=$1', [d1]))[0];
  assert.equal(published.instagram_media_id, `media-${id}`, 'published history kept for the explicit review step');
  assert.deepEqual(await counts(other), before, 'another tenant is untouched');
  r = await receipt(code); assert.equal(r.status, 'awaiting_review'); assert.ok(r.data_erased_at);
  await assert.rejects(q('select public.erase_instagram_deletion_data($1)', [code]), /receipt_not_awaiting_erasure/);

  // Every review is required; partial attestations are refused.
  await assert.rejects(review({ identity: false }), /review_incomplete/);
  await assert.rejects(review({ history: false }), /review_incomplete/);
  await assert.rejects(review({ processors: null }), /review_incomplete/);
  await assert.rejects(review({ backups: null }), /backup_date_required/);
  await assert.rejects(review({ backups: new Date(Date.now() - 10 * 86400_000) }), /backup_date_required/);
  await assert.rejects(review({ by: ' ' }), /reviewer_required/);
  await assert.rejects(review({ ref: 'has spaces and an email a@b.c' }), /reviewer_required/);
  assert.equal((await q('select status from public.instagram_deletion_status($1)', [code]))[0].status, 'awaiting_review');

  assert.equal((await review())[0].complete_instagram_deletion, true);
  r = await receipt(code);
  assert.equal(r.status, 'completed'); assert.equal(r.subject_id, null, 'identity minimised after completion'); assert.ok(r.completed_at);
  await assert.rejects(review(), /erasure_not_finished/);
  // A later callback for the erased account can no longer match the scrubbed row.
  assert.equal((await receipt(await accept(subject, 'deauthorize'))).status, 'no_match');
});

test('erasure refuses when the owner reconnected after the request, or a newer authorisation was superseded', async () => {
  const s1 = '17841400000000601'; const id = await owner(s1);
  const code = await accept(s1, 'deletion');
  await q(`select public.save_instagram_connection($1,$2,'u',null,'BUSINESS',null,array['instagram_business_basic'],now()+interval '50 days','c','i','t',1::smallint)`, [id, s1]);
  await q(`update public.instagram_connections set connected_at=now()+interval '1 second' where owner_user_id=$1`, [id]);
  await assert.rejects(q('select public.erase_instagram_deletion_data($1)', [code]), /reconnected_after_request/);
  assert.equal((await receipt(code)).status, 'awaiting_erasure'); assert.equal(await secretCount(id), 1, 'refusal rolled back; nothing half-erased');

  const s2 = '17841400000000602'; await owner(s2, { connectedAgo: '1 minute' });
  const code2 = await accept(s2, 'deletion', new Date(Date.now() - 3600_000));
  await assert.rejects(q('select public.erase_instagram_deletion_data($1)', [code2]), /superseded_connection_requires_manual_review/);
});

test('deletion with no matching connection can only complete after the identity review', async () => {
  const code = await accept('17841400000000701', 'deletion');
  const s = (await q('select public.erase_instagram_deletion_data($1) as s', [code]))[0].s;
  assert.equal(s.owners, 0);
  await assert.rejects(q('select public.complete_instagram_deletion($1,$2,$3,false,true,true,current_date+7)', [code, 'VOOM owner', 'CASE-7']), /review_incomplete/);
  assert.equal((await q('select public.complete_instagram_deletion($1,$2,$3,true,true,true,current_date+7) as ok', [code, 'VOOM owner', 'CASE-7']))[0].ok, true);
});

test('completed deletion clears the id from related receipts, but not from an in-progress deletion; Meta retries stay idempotent', async () => {
  const subject = '17841400000000901'; await owner(subject);
  const t0 = new Date(Date.now() - 120_000), t1 = new Date(Date.now() - 60_000), t2 = new Date(Date.now() - 30_000);
  const deauthKey = 'd'.repeat(64), del1Key = 'e'.repeat(64), del2Key = 'f'.repeat(64);
  const deauth = await accept(subject, 'deauthorize', t0, deauthKey);
  const del1 = await accept(subject, 'deletion', t1, del1Key);
  const del2 = await accept(subject, 'deletion', t2, del2Key); // a second, separate deletion request
  const unrelated = await accept('17841400000000902', 'deauthorize');
  await q('select public.erase_instagram_deletion_data($1)', [del1]);
  await q('select public.complete_instagram_deletion($1,$2,$3,true,true,true,current_date+7)', [del1, 'VOOM owner', 'CASE-901']);

  assert.equal((await receipt(del1)).subject_id, null);
  assert.equal((await receipt(deauth)).subject_id, null, 'related deauthorize receipt no longer holds the id');
  assert.equal((await receipt(deauth)).status, 'disconnected', 'only the id is cleared; the record stays');
  assert.equal((await receipt(del2)).subject_id, subject, 'in-progress deletion keeps the id until its own completion');
  assert.equal((await receipt(del2)).status, 'awaiting_erasure');
  assert.equal((await receipt(unrelated)).subject_id, '17841400000000902', 'other people are untouched');

  // Meta retries of already-processed events: same code, no error, no second action.
  const before = Number((await q('select count(*) n from public.instagram_callback_receipts'))[0].n);
  assert.equal(await accept(subject, 'deauthorize', t0, deauthKey), deauth);
  assert.equal(await accept(subject, 'deletion', t1, del1Key), del1);
  assert.equal(await accept(subject, 'deletion', t2, del2Key), del2);
  assert.equal(Number((await q('select count(*) n from public.instagram_callback_receipts'))[0].n), before);
  assert.equal((await receipt(del1)).status, 'completed');
  // A fingerprint reused for a different person is still refused.
  await assert.rejects(accept('17841400000000903', 'deletion', t2, del2Key), /event_key_conflict/);
  await assert.rejects(accept(subject, 'deletion', t0, deauthKey), /event_key_conflict/);

  // The second deletion can still complete; afterwards no receipt holds the id.
  await q('select public.erase_instagram_deletion_data($1)', [del2]);
  await q('select public.complete_instagram_deletion($1,$2,$3,true,true,true,current_date+7)', [del2, 'VOOM owner', 'CASE-902']);
  assert.equal(Number((await q('select count(*) n from public.instagram_callback_receipts where subject_id=$1', [subject]))[0].n), 0);
});

test('authorization boundary: browsers can neither read receipts nor call any callback function', async () => {
  for (const role of ['anon', 'authenticated']) {
    for (const priv of ['select', 'insert', 'update', 'delete']) {
      assert.equal((await q(`select has_table_privilege($1,'public.instagram_callback_receipts',$2) ok`, [role, priv]))[0].ok, false, `${role} ${priv}`);
    }
    for (const fn of ['public.accept_instagram_callback(text,text,text,timestamptz,text)', 'public.erase_instagram_deletion_data(text)',
      'public.complete_instagram_deletion(text,text,text,boolean,boolean,boolean,date)', 'public.instagram_deletion_status(text)']) {
      assert.equal((await q(`select has_function_privilege($1,$2,'execute') ok`, [role, fn]))[0].ok, false, `${role} ${fn}`);
    }
  }
  assert.equal((await q(`select has_function_privilege('service_role','public.accept_instagram_callback(text,text,text,timestamptz,text)','execute') ok`))[0].ok, true);
  assert.equal((await q(`select relrowsecurity from pg_class where oid='public.instagram_callback_receipts'::regclass`))[0].relrowsecurity, true);
  // Real role switch: authenticated cannot read even with RLS context set.
  await q('set role authenticated');
  try { await assert.rejects(q('select * from public.instagram_callback_receipts'), /permission denied/); }
  finally { await q('reset role'); }
});

test('existing user disconnect and reconnect keep working after callbacks', async () => {
  const subject = '17841400000000801'; const id = await owner(subject);
  await accept(subject, 'deauthorize');
  await q(`select public.save_instagram_connection($1,$2,'back',null,'BUSINESS',null,array['instagram_business_basic'],now()+interval '50 days','c','i','t',1::smallint)`, [id, subject]);
  assert.equal((await conn(id)).status, 'connected'); assert.equal(await secretCount(id), 1);
  assert.equal((await q('select public.disconnect_instagram_connection($1) ok', [id]))[0].ok, true);
  assert.equal((await conn(id)).status, 'disconnected');
});

test('rollback refuses once a receipt exists; on an empty table it removes everything and 0078 re-applies', async () => {
  const { readFileSync } = await import('node:fs');
  const rollback = readFileSync(new URL('../supabase/rollbacks/0078_instagram_callback_receipts.sql', import.meta.url), 'utf8');
  await assert.rejects(db.exec(rollback), /not empty/);
  await db.exec('rollback'); // the refusal aborts its own transaction, exactly as in the SQL editor
  assert.ok((await q(`select to_regclass('public.instagram_callback_receipts') t`))[0].t);
  const fresh = (await createSupabaseLite()).db;
  try {
    await fresh.exec(rollback);
    assert.equal((await fresh.query(`select to_regclass('public.instagram_callback_receipts') t`)).rows[0].t, null);
    assert.equal((await fresh.query(`select count(*) n from pg_proc where proname in ('accept_instagram_callback','erase_instagram_deletion_data','complete_instagram_deletion','instagram_deletion_status')`)).rows[0].n, 0);
    const { migrationSql } = await import('./helpers/pglite-supabase.mjs');
    await fresh.exec(migrationSql('0078_instagram_callback_receipts.sql'));
    assert.ok((await fresh.query(`select to_regclass('public.instagram_callback_receipts') t`)).rows[0].t);
  } finally { await fresh.close(); }
});

// ---------- 3. Status page truthfulness ----------

test('status page reflects actual progress and never claims completion early', async () => {
  const base = { receivedAt: '2026-11-23T10:00:00Z', completedAt: null, backupsClearBy: null };
  for (const status of ['awaiting_erasure', 'awaiting_review']) {
    const m = deletionStatusMessage({ ...base, status });
    assert.match(m, /not complete yet/); assert.doesNotMatch(m, /was completed/);
  }
  const done = deletionStatusMessage({ ...base, status: 'completed', completedAt: '2026-11-25T10:00:00Z', backupsClearBy: '2026-12-02' });
  assert.match(done, /completed on 2026-11-25/); assert.match(done, /by 2026-12-02/);
  // Inconsistent row (completed without a date) is shown as in progress, not complete.
  assert.match(deletionStatusMessage({ ...base, status: 'completed' }), /not complete yet/);

  const code = 'c'.repeat(32);
  assert.equal((await renderDeletionStatus(code, false, mustNotRun)).status, 503);
  assert.equal((await renderDeletionStatus('<script>', true, mustNotRun)).status, 404);
  assert.equal((await renderDeletionStatus(code, true, async () => null)).status, 404);
  assert.equal((await renderDeletionStatus(code, true, async () => { throw Error('db'); })).status, 503);
  const ok = await renderDeletionStatus(code, true, async () => ({ ...base, status: 'awaiting_review' }));
  assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'no-store');
  assert.match(ok.headers.get('content-security-policy'), /default-src 'none'/);
  assert.match(await ok.text(), /not complete yet/);
});
