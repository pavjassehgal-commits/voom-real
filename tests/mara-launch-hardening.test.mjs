import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const { instagramPublishReadiness } = await import('../lib/instagram/publish-readiness.ts');
const { loadWorkflowSnapshot, todaySummary } = await import('../lib/voom/workflow/read.ts');
const { loadTodayScheduledItems } = await import('../lib/voom/today-schedule.ts');
const { buildTodayView } = await import('../lib/voom/today-view.ts');
const { planItemActions } = await import('../lib/voom/workflow/next-actions.ts');
const { postApprovalMessage } = await import('../lib/post/approval-message.ts');
const { runPublishFlow } = await import('../lib/instagram/publish-flow.ts');
const OWNER = 'synthetic-owner', NOW = new Date('2026-11-01T10:00:00Z');
const connection = { owner_user_id: OWNER, status: 'connected', scopes: ['instagram_business_content_publish'], token_expires_at: '2026-12-01T00:00:00Z' };

// No credentials, HTTP, RPC or write methods. Selected-column projection makes
// forgetting to query token_expires_at fail, rather than masking the bug.
function fixture(conn = connection) {
  const draft = { id: 'draft', owner_user_id: OWNER, source_plan_id: 'plan', source_plan_item_key: '2026-11-01|instagram_post',
    kind: 'instagram_post', social_channel: 'instagram', social_format: 'post', title: 'Synthetic original', content: 'Original caption #Test',
    status: 'approved', content_version: 2, approved_content_version: 2, proposed_publish_at: '2026-11-01T14:30:00Z' };
  const job = { id: 'job', owner_user_id: OWNER, draft_id: draft.id, status: 'scheduled', scheduled_at: draft.proposed_publish_at };
  const tables = new Map(Object.entries({
    businesses: [{ owner_user_id: OWNER, plan: 'pro', automation_level: 'assisted', content_frequency: 'Daily', timezone: 'Asia/Dubai' }],
    marketing_plans: [{ id: 'plan', owner_user_id: OWNER, status: 'active', valid_from: '2026-11-01', valid_until: '2026-11-07' }],
    mara_drafts: [draft], instagram_publish_queue: [job], instagram_connections: conn ? [structuredClone(conn)] : [],
    post_draft_assets: [{ draft_id: draft.id, owner_user_id: OWNER, status: 'uploaded', storage_path: OWNER + '/original.png', mime_type: 'image/png' }],
  }));
  const db = { from(table) {
    const filters = []; let fields = null, max = Infinity;
    const q = {
      select(value) { fields = value.split(','); return q; },
      eq(k, v) { filters.push(r => r[k] === v); return q; },
      in(k, values) { filters.push(r => values.includes(r[k])); return q; },
      gte(k, v) { filters.push(r => r[k] >= v); return q; },
      lt(k, v) { filters.push(r => r[k] < v); return q; },
      order() { return q; }, limit(n) { max = n; return q; },
      result() { const data = (tables.get(table) || []).filter(r => filters.every(f => f(r))).slice(0, max)
        .map(r => Object.fromEntries(fields.map(k => [k, r[k]]))); return { data, error: null }; },
      async maybeSingle() { const r = q.result(); return { ...r, data: r.data[0] || null }; },
      then(ok, bad) { return Promise.resolve(q.result()).then(ok, bad); },
    }; return q;
  }, storage: { from: () => ({ createSignedUrls: async paths => ({ data: paths.map(() => ({ signedUrl: 'https://synthetic.invalid/preview' })) }) }) } };
  return { db, tables, draft, job };
}

test('PR branch opts out of automatic shared-credential Previews without altering Production, TikTok or schedules', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.git.deploymentEnabled['codex/mara-launch-readiness'], false);
  assert.equal(config.git.deploymentEnabled.main, undefined);
  assert.equal(config.git.deploymentEnabled['tiktok-sandbox'], undefined);
  assert.equal(Object.keys(config.git.deploymentEnabled).length, 13);
  assert(Object.values(config.git.deploymentEnabled).every(value => value === false));
  assert.deepEqual(config.crons, [
    { path: '/api/cron/weekly-plans', schedule: '0 3 * * *' },
    { path: '/api/cron/trend-collection', schedule: '0 4 * * *' },
    { path: '/api/cron/linkedin-publish', schedule: '*/5 * * * *' },
  ]);
});

for (const scenario of [
  { name: 'valid', conn: connection, readiness: 'ready' },
  { name: 'expired but still connected', conn: { ...connection, token_expires_at: '2026-10-31T00:00:00Z' }, readiness: 'expired' },
  { name: 'expiry exactly now', conn: { ...connection, token_expires_at: NOW.toISOString() }, readiness: 'expired' },
  { name: 'explicit expired status', conn: { ...connection, status: 'expired' }, readiness: 'expired' },
  { name: 'invalid explicit expiry', conn: { ...connection, token_expires_at: 'not-a-date' }, readiness: 'expired' },
  { name: 'disconnected', conn: { ...connection, status: 'disconnected' }, readiness: 'disconnected' },
  { name: 'missing', conn: null, readiness: 'missing' },
  { name: 'missing publish scope', conn: { ...connection, scopes: [] }, readiness: 'permission_required' },
]) test(`${scenario.name}: Plan, Today and approval agree, preserving drafts/jobs`, async () => {
  const f = fixture(scenario.conn), before = JSON.stringify([...f.tables]);
  const ready = scenario.readiness === 'ready';
  assert.equal(instagramPublishReadiness(scenario.conn && { status: scenario.conn.status, scopes: scenario.conn.scopes, tokenExpiresAt: scenario.conn.token_expires_at }, NOW), scenario.readiness);
  const snapshot = await loadWorkflowSnapshot(f.db, OWNER, { now: NOW });
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0];
  assert.equal(item.status, ready ? 'scheduled' : 'needs_connection');
  assert.equal(item.connectionReady, ready);
  assert.equal(item.connectionIssue, ready ? null : scenario.readiness);
  assert.equal(item.approvalGranted, true);
  assert.equal(item.queueStatus, 'scheduled', 'persisted job is distinct from current eligibility');
  const items = await loadTodayScheduledItems(f.db, OWNER, snapshot.today, snapshot.timeZone, NOW);
  assert.equal(items.length, ready ? 1 : 0);
  const view = buildTodayView(snapshot, todaySummary(snapshot), null, items);
  assert.equal(view.days[0].scheduledItems.length, ready ? 1 : 0);
  const message = await postApprovalMessage(f.db, OWNER, { id: f.draft.id, status: 'approved', visualReady: true }, NOW);
  const actions = planItemActions({ contentType: 'post', stage: item.status, mode: 'assisted', failedStage: null,
    hasMedia: true, publishAt: item.publishAt, connectionReady: item.connectionReady, connectionIssue: item.connectionIssue, queueStatus: item.queueStatus });
  if (ready) assert.match(message, /Approved and scheduled/);
  else {
    assert.doesNotMatch(message, /Approved and scheduled|will publish/);
    assert(!actions.actions.some(a => ['approve_schedule', 'post_now'].includes(a.id)));
    assert.equal(actions.actions[0].id, 'connect_channel');
  }
  if (scenario.readiness === 'expired') {
    assert.equal(item.statusLabel, 'Connection expired');
    assert.match(message, /Reconnect Instagram/);
    assert.match(message, /unchanged/);
    assert.equal(actions.actions[0].label, 'Reconnect Instagram');
    assert.match(actions.headline, /saved publishing job/);
    assert.equal(view.attention.title, 'Instagram connection expired');
    assert.equal(view.attention.href, '/app/instagram');
  }
  assert.equal(JSON.stringify([...f.tables]), before, 'approval, caption, media and queue preserved');
});

test('expired readiness matches the real worker refusal without any provider call', async () => {
  let failed, providerCalls = 0;
  const outcome = await runPublishFlow({ id: 'job', ownerUserId: OWNER, draftId: 'draft', mediaKind: 'image', caption: 'Original', attempts: 0,
    containerId: null, instagramMediaId: null }, {
    now: () => NOW.getTime(), loadDraft: async () => ({ status: 'approved', content: 'Original', contentVersion: 2 }),
    loadConnection: async () => ({ status: 'connected', scopes: connection.scopes, tokenExpiresAt: '2026-10-31T00:00:00Z' }),
    markFailed: async (_item, result) => { failed = result; },
    loadCredentials: async () => { providerCalls++; throw Error('Provider access forbidden'); },
  });
  assert.equal(outcome.code, 'instagram_token_expired');
  assert.equal(failed.code, 'instagram_token_expired');
  assert.equal(providerCalls, 0);
});

test('reconnect restores only still-approved persisted eligibility, with no rescheduling', async () => {
  const f = fixture({ ...connection, token_expires_at: '2026-10-31T00:00:00Z' });
  assert.equal((await loadTodayScheduledItems(f.db, OWNER, '2026-11-01', 'Asia/Dubai', NOW)).length, 0);
  assert.equal(f.job.status, 'scheduled');
  f.tables.get('instagram_connections')[0].token_expires_at = connection.token_expires_at;
  assert.equal((await loadTodayScheduledItems(f.db, OWNER, '2026-11-01', 'Asia/Dubai', NOW)).length, 1);
  f.draft.content_version++;
  assert.equal((await loadTodayScheduledItems(f.db, OWNER, '2026-11-01', 'Asia/Dubai', NOW)).length, 0);
  assert.equal(f.job.status, 'scheduled');
});

test('real Plan and Today components render reconnect links, not executable schedule claims', async () => {
  const { importApp, react, renderToStaticMarkup } = await import('./helpers/rendered-surface.mjs');
  const { PlanItemCard, readinessSteps } = await importApp('components/voom/operating/PlanItemCard.tsx');
  const { TodayDashboard } = await importApp('components/voom/today/TodayDashboard.tsx');
  const { ModalProvider } = await importApp('lib/voom/modal.tsx');
  const { buildTodayMetrics } = await importApp('lib/voom/today-metrics.ts');
  const { createElement: h } = react;
  const f = fixture({ ...connection, token_expires_at: '2026-10-31T00:00:00Z' });
  const snapshot = await loadWorkflowSnapshot(f.db, OWNER, { now: NOW });
  const item = { ...snapshot.items[0], mediaPreviewUrl: null };
  assert.equal(readinessSteps(item).find(step => step.label === 'Scheduled').done, false);
  const wrap = child => h(ModalProvider, null, child);
  const plan = renderToStaticMarkup(wrap(h('ul', null, h(PlanItemCard, {
    item, mode: 'assisted', timeZone: snapshot.timeZone, onChanged() { throw Error('No writes permitted'); },
  }))));
  assert.match(plan, /href="\/app\/instagram"[^>]*>Reconnect Instagram<\/a>/);
  assert.match(plan, /Connection expired/);
  assert.doesNotMatch(plan, />Approve &amp; schedule<|>Post now<|Voom will publish/);
  const view = buildTodayView({ ...snapshot, items: [item] }, todaySummary({ ...snapshot, items: [item] }), null, []);
  const today = renderToStaticMarkup(wrap(h(TodayDashboard, {
    firstName: 'Alex', greeting: 'Hello', dateLabel: 'Sunday, 1 Nov 2026', weekNumber: 44, view,
    performance: { headline: null, measuredItems: 0, trend: null }, metrics: buildTodayMetrics([], NOW, snapshot.timeZone),
    ideas: [], ideaCount: 0, channels: [], recent: [], automationMode: 'assisted', automationPlan: 'pro',
  })));
  assert.match(today, /0<!-- --> post<!-- -->s<!-- --> scheduled today|0 posts scheduled today/);
  assert.match(today, /href="\/app\/instagram"[^>]*>Reconnect Instagram/);
  assert.match(today, /Instagram connection expired/);
});
