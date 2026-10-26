/** Real plan server actions, synthetic owner-scoped storage, mocked side effects.
 * The paid-generation stub uses the REAL entitlement guard and credit ledger.
 * No network, provider credentials, customer data or publishing is used.
 */
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';
import { createFakeCreditLedger } from './helpers/credit-ledger-fake.mjs';

const actionUrl = new URL('../lib/voom/workflow/actions-server.ts', import.meta.url).href;
const linkedInListUrl = new URL('../app/api/integrations/linkedin/drafts/route.ts', import.meta.url).href;
const modules = {
  'next/cache': 'export function revalidatePath() {}',
  '@/lib/voom/server-data': 'export async function getCurrentUser() { return globalThis.__planActionTest.user; }',
  '@/utils/supabase/admin': 'export function createAdminClient() { return globalThis.__planActionTest.db; }',
  '@/lib/post/server-data': `
    export async function getPostDraft(...a) { return globalThis.__planActionTest.post(...a); }
    export async function approvePostDraft(...a) { return globalThis.__planActionTest.approve(...a); }
    export async function syncPostToCalendar(...a) { return globalThis.__planActionTest.sync(...a); }
    export async function cancelPostSchedule(...a) { return globalThis.__planActionTest.cancel(...a); }
  `,
  '@/lib/instagram/publish-queue': 'export async function enqueuePublishItem(...a) { return globalThis.__planActionTest.enqueue(...a); }',
  './media': `
    export async function produceWorkflowMedia(...a) { return globalThis.__planActionTest.produce(...a); }
    export function mediaOutcomeMessage(state) { return state; }
  `,
  './service': 'export async function ensureWorkflowApprovalCard(...a) { return globalThis.__planActionTest.card(...a); }',
};
registerHooks({ resolve(specifier, context, nextResolve) {
  const nativeAuth = context.parentURL === linkedInListUrl
    && ['@/lib/voom/server-data', '@/utils/supabase/admin'].includes(specifier);
  if ((context.parentURL === actionUrl || nativeAuth) && modules[specifier]) {
    return { url: `data:text/javascript,${encodeURIComponent(modules[specifier])}`, shortCircuit: true };
  }
  return nextResolve(specifier, context);
} });
const actions = await import('../lib/voom/workflow/actions-server.ts');
const { getSocialDraft } = await import('../lib/social/server-drafts.ts');
const { GET: getLinkedInDrafts } = await import('../app/api/integrations/linkedin/drafts/route.ts');
const { guardAndReserveMedia, confirmReservation } = await import('../lib/billing/entitlement-guard.ts');
const OWNER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const DATE = '2099-10-27';
const kinds = [
  ['instagram_post', 'instagram', 'post'], ['reel', 'instagram', 'reel'],
  ['story', 'instagram', 'story'], ['tiktok_video', 'tiktok', 'video'],
  ['youtube_short', 'youtube', 'short'], ['youtube_video', 'youtube', 'video'],
  ['linkedin_text', 'linkedin', 'text'],
];
const idFor = (index) => `33333333-3333-4333-8333-${String(index + 1).padStart(12, '0')}`;
function fixture({ plan = 'pro', legacy = false } = {}) {
  const rows = kinds.map(([kind, channel, format], index) => ({
    id: idFor(index), owner_user_id: OWNER, kind, channel,
    social_channel: channel, social_format: format,
    source_plan_item_key: legacy ? DATE : `${DATE}|${channel}_${format}`,
    title: `${channel} ${format}`, content: 'Approved only by the owner',
    proposed_publish_at: `${DATE}T14:30:00.000Z`, status: 'draft', conversation_id: 'conversation',
  }));
  const tables = new Map([
    ['mara_drafts', rows], ['mara_pending_actions', rows.map((row) => ({
      owner_user_id: OWNER, tool_name: 'propose_calendar_item', status: 'pending',
      sanitized_arguments: { sourceDraftId: row.id },
    }))],
    ['businesses', [{ owner_user_id: OWNER, plan, timezone: 'UTC' }]],
  ]);
  const calls = [], reads = [], writes = [], jobs = new Map(), generated = new Set();
  const ledger = createFakeCreditLedger(tables);
  class Query {
    constructor(table) { this.table = table; this.filters = []; this.patch = null; }
    select() { return this; }
    order() { return this; }
    limit() { return this; }
    eq(key, value) { this.filters.push((row) => row[key] === value); reads.push([this.table, key, value]); return this; }
    in(key, values) { this.filters.push((row) => values.includes(row[key])); return this; }
    contains(key, value) { this.filters.push((row) => Object.entries(value).every(([k, v]) => row[key]?.[k] === v)); return this; }
    update(patch) { this.patch = patch; return this; }
    execute() {
      if (state.readError && this.table === 'mara_drafts') return { data: null, error: { code: 'unavailable' } };
      const found = (tables.get(this.table) ?? []).filter((row) => this.filters.every((f) => f(row)));
      if (this.patch) for (const row of found) { Object.assign(row, this.patch); writes.push(row.id ?? row.sanitized_arguments.sourceDraftId); }
      return { data: found, error: null };
    }
    async maybeSingle() { const { data, error } = this.execute(); return { data: data?.[0] ?? null, error }; }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
  }
  const db = { from: (table) => new Query(table), rpc: ledger.rpc };
  const post = async (_db, owner, id) => {
    const row = rows.find((row) => row.owner_user_id === owner && row.id === id);
    if (!row) return null;
    return { ...row, visualReady: true, visual: { mimeType: row.kind === 'reel' ? 'video/mp4' : 'image/png' }, composedCaption: row.content, calendarItemId: `calendar-${id}` };
  };
  const state = {
    user: { id: OWNER }, db, rows, tables, calls, reads, writes, jobs, ledger,
    post,
    async approve(_db, owner, id) {
      calls.push(['approve', owner, id]);
      const row = rows.find((row) => row.id === id && row.owner_user_id === owner);
      row.status = 'approved'; jobs.set(id, { owner, id }); return post(db, owner, id);
    },
    async sync(_db, owner, id) { calls.push(['sync', owner, id]); },
    async cancel(_db, owner, id) { calls.push(['cancel', owner, id]); jobs.delete(id); },
    async enqueue(_db, input) { calls.push(['enqueue', input.ownerId, input.draftId]); jobs.set(input.draftId, input); },
    async card(_db, owner, input) { calls.push(['card', owner, input.draftId]); },
    async produce(_db, request, options) {
      calls.push(['produce', request.ownerId, request.draftId]);
      assert.equal(options.explicit, true);
      if (generated.has(request.draftId)) return { ok: true, state: 'exists' };
      const generationId = `generation-${request.draftId}`;
      const guard = await guardAndReserveMedia(db, {
        ownerId: request.ownerId, planId: plan, mode: 'manual', allowAutomaticPaidMedia: false,
        mediaType: request.contentType === 'reel' ? 'video' : 'image', source: 'user_request', generationId,
      });
      if (!guard.allow) return { ok: false, code: guard.code };
      generated.add(request.draftId);
      await confirmReservation(db, request.ownerId, generationId);
      return { ok: true, state: 'completed' };
    },
  };
  globalThis.__planActionTest = state;
  return state;
}
const operations = [
  ['Generate', (id) => actions.producePlanItemMedia(id)],
  ['Approve', (id) => actions.approvePlanItem(id)],
  ['Reschedule', (id) => actions.reschedulePlanItem(id, DATE, '15:30')],
  ['Post now', (id) => actions.postPlanItemNow(id)],
  ['Cancel', (id) => actions.cancelPlanItemSchedule(id)],
  ['Production choice', (id) => actions.choosePlanItemProduction(id, 'upload_asset')],
];

for (const legacy of [false, true]) for (const [index, [kind, channel]] of kinds.entries()) {
  test(`${legacy ? 'legacy' : 'composite'} ${kind}: actions never select another same-day recommendation`, async () => {
    for (const [name, invoke] of operations) {
      const state = fixture({ legacy });
      const target = state.rows[index];
      if (name === 'Post now' || name === 'Cancel') target.status = 'approved';
      const siblings = structuredClone(state.rows.filter((row) => row.id !== target.id));
      const result = await invoke(target.id);
      if (channel === 'instagram') {
        assert.equal(result.ok, true, `${name}: ${JSON.stringify(result)}`);
        for (const [, owner, id] of state.calls) { assert.equal(owner, OWNER); assert.equal(id, target.id); }
        assert.ok(state.writes.every((id) => id === target.id));
        assert.ok([...state.jobs.keys()].every((id) => id === target.id));
      } else {
        // These recommendations already have native, consent-aware editors.
        // They must NEVER be coerced into Instagram generation or approval.
        assert.equal(result.ok, false, name);
        assert.deepEqual(state.calls, []); assert.deepEqual(state.writes, []);
        assert.equal(state.ledger.rows().length, 0);
      }
      assert.deepEqual(state.rows.filter((row) => row.id !== target.id), siblings);
    }
  });
}

test('legacy Instagram rows without social columns remain actionable by exact draft ID', async () => {
  const state = fixture({ legacy: true });
  delete state.rows[1].social_channel; delete state.rows[1].social_format;
  assert.equal((await actions.producePlanItemMedia(state.rows[1].id)).ok, true);
  assert.equal(state.ledger.live(OWNER)[0].credits, 40);
});

test('authentication, ownership, malformed identities and conflicting platform/format fail closed before side effects', async () => {
  const invalidRows = [
    { source_plan_item_key: null }, { source_plan_item_key: '2099-02-30|instagram_post' },
    { source_plan_item_key: `${DATE}|email` }, { source_plan_item_key: `${DATE}|instagram_short` },
    { source_plan_item_key: `${DATE}|tiktok_video` }, { source_plan_item_key: `${DATE}|instagram_reel` },
    { social_channel: 'tiktok' }, { social_format: 'reel' }, { kind: 'campaign_plan' },
    { owner_user_id: OTHER },
  ];
  for (const patch of invalidRows) for (const [, invoke] of operations) {
    const state = fixture(); Object.assign(state.rows[0], patch);
    assert.equal((await invoke(state.rows[0].id)).ok, false, JSON.stringify(patch));
    assert.deepEqual(state.calls, []); assert.deepEqual(state.writes, []);
    assert.equal(state.ledger.rows().length, 0);
  }
  for (const [, invoke] of operations) {
    const state = fixture(); state.user = null;
    assert.equal((await invoke(state.rows[0].id)).ok, false); assert.deepEqual(state.reads, []);
    state.user = { id: OWNER };
    assert.equal((await invoke('not-a-uuid')).ok, false); assert.deepEqual(state.reads, []);
    assert.equal((await invoke(idFor(99))).ok, false, 'missing selection never falls back to a same-day sibling');
    assert.deepEqual(state.calls, []);
    state.readError = true;
    assert.equal((await invoke(state.rows[0].id)).ok, false);
    assert.deepEqual(state.calls, []); assert.deepEqual(state.writes, []);
  }
});

for (const legacy of [false, true]) test(`${legacy ? 'legacy' : 'composite'} native editor handoffs resolve the selected TikTok, YouTube and LinkedIn draft`, async () => {
  const state = fixture({ legacy });
  const before = structuredClone(state.rows);
  for (const index of [3, 4, 5]) {
    const target = state.rows[index];
    const draft = await getSocialDraft(state.db, OWNER, target.id);
    assert.equal(draft.id, target.id); assert.equal(draft.channel, target.social_channel);
    assert.equal(draft.format, target.social_format);
    assert.equal(await getSocialDraft(state.db, OTHER, target.id), null);
  }
  const target = state.rows[6];
  const response = await getLinkedInDrafts(new Request(`https://voom.test/api/integrations/linkedin/drafts?draft=${target.id}`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.drafts.map((draft) => draft.id), [target.id]);
  assert.ok(state.reads.some(([table, key, value]) => table === 'mara_drafts' && key === 'id' && value === target.id));
  state.user = { id: OTHER };
  const foreign = await getLinkedInDrafts(new Request(`https://voom.test/api/integrations/linkedin/drafts?draft=${target.id}`));
  assert.deepEqual((await foreign.json()).drafts, []);
  assert.deepEqual(state.rows, before); assert.deepEqual(state.writes, []); assert.deepEqual(state.calls, []);
});

for (const plan of ['free', 'pro', 'max']) test(`${plan}: eligibility, image/video prices and duplicate-click credit compatibility`, async () => {
  for (const [index, price] of [[0, 5], [1, 40]]) {
    const state = fixture({ plan }), target = state.rows[index];
    assert.equal((await actions.producePlanItemMedia(target.id)).ok, plan !== 'free');
    assert.equal((await actions.producePlanItemMedia(target.id)).ok, plan !== 'free');
    assert.equal(state.ledger.live(OWNER).length, plan === 'free' ? 0 : 1);
    assert.equal(state.ledger.usage(OWNER).used, plan === 'free' ? 0 : price);
    assert.equal(target.status, 'draft'); assert.equal(state.jobs.size, 0);
  }
});

test('insufficient credits block generation and repeated approval retains one queue identity', async () => {
  const state = fixture();
  state.tables.get('voom_credit_ledger').push({
    owner_user_id: OWNER, generation_id: 'prior', source: 'user_request', status: 'settled',
    credits: 150, created_at: new Date().toISOString(),
  });
  assert.equal((await actions.producePlanItemMedia(state.rows[0].id)).ok, false);
  assert.equal(state.ledger.usage(OWNER).used, 150);
  assert.equal((await actions.postPlanItemNow(state.rows[0].id)).ok, false, 'generation does not confer approval');
  assert.equal((await actions.approvePlanItem(state.rows[0].id)).ok, true);
  assert.equal((await actions.approvePlanItem(state.rows[0].id)).ok, true);
  assert.equal(state.jobs.size, 1); assert.equal(state.calls.filter(([name]) => name === 'approve').length, 1);
});
