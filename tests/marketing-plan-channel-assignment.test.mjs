/**
 * Multi-channel rolling Marketing Plan acceptance matrix.
 *
 * Drives the deterministic slot planner and real workflow service against an
 * in-memory Supabase-shaped store. No provider credentials, production data,
 * paid media, publishing, email sends, or real content generation are used.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const channels = await import("../lib/social/channels.ts");
const planningChannels = await import("../lib/voom/workflow/channels.ts");
const channelPlanner = await import("../lib/voom/workflow/channel-planner.ts");
const rolling = await import("../lib/voom/workflow/rolling-plan.ts");
const prompt = await import("../lib/voom/workflow/prompt.ts");
const service = await import("../lib/voom/workflow/service.ts");
const socialDrafts = await import("../lib/social/server-drafts.ts");
const workflowRead = await import("../lib/voom/workflow/read.ts");
const coordinator = await import("../lib/coordinator/service.ts");
const timezone = await import("../lib/voom/timezone.ts");
const discovery = await import("../lib/trends/discovery.ts");

const OWNER = "owner-channel-plan";
const BUSINESS = "business-channel-plan";
const TZ = "Asia/Dubai";
const NOW = new Date("2026-09-12T05:00:00.000Z");
const DATE = "2026-09-12";

function baseInput(overrides = {}) {
  return {
    now: NOW,
    timeZone: TZ,
    cadence: "daily",
    mode: "assisted",
    goal: "Grow useful awareness",
    selectedChannels: ["instagram"],
    ...overrides,
  };
}

function createPlannerStore() {
  const store = { plans: new Map(), drafts: new Map(), calls: { generate: 0, media: 0 } };
  let nextPlan = 0;
  let nextDraft = 0;
  const ports = {
    async ensurePlan(input) {
      let plan = [...store.plans.values()][0];
      if (!plan) {
        plan = { id: `plan-${++nextPlan}`, selectedChannels: [], items: [] };
        store.plans.set(plan.id, plan);
      }
      Object.assign(plan, { ...input, selectedChannels: [...input.selectedChannels] });
      return plan.id;
    },
    async getActivePlan() {
      return [...store.plans.keys()][0] ?? null;
    },
    async listItems(planId) {
      return [...store.drafts.values()].filter((item) => item.planId === planId);
    },
    async detachDrafts(planId, draftIds) {
      for (const draftId of draftIds) {
        const item = store.drafts.get(draftId);
        if (item?.planId === planId && item.status === "draft") {
          item.planId = null;
          item.slotKey = null;
          item.detached = true;
        }
      }
    },
    async generateContent(slot) {
      store.calls.generate += 1;
      return {
        concept: `${slot.channel} ${slot.format} concept ${slot.date}`,
        hook: "A clear, native opening hook.",
        caption: `A concise ${slot.channel} caption for ${slot.date}.`,
        cta: "Learn more.",
        hashtags: ["localbusiness"],
        description: slot.channel === "youtube" ? "A useful description for this YouTube video." : "",
        script: slot.channel === "instagram" && slot.format === "post"
          ? []
          : ["Open with the idea", "Show one useful detail", "Share the payoff", "Close with a next step"],
        visualBrief: "Native format, clear subject, no invented claims.",
      };
    },
    async createDraft({ planId, slot, content }) {
      const existing = [...store.drafts.values()].find((item) => item.planId === planId && item.slotKey === slot.slotKey);
      if (existing) return existing;
      const item = {
        draftId: `draft-${++nextDraft}`,
        planId,
        slotKey: slot.slotKey,
        channel: slot.channel,
        format: slot.format,
        contentType: slot.contentType,
        concept: content.concept,
        caption: content.caption,
        publishAt: slot.publishAt,
        status: "draft",
        protected: false,
      };
      store.drafts.set(item.draftId, item);
      return item;
    },
    async ensureMedia() { store.calls.media += 1; return { ok: true }; },
    async requestApproval() {},
    async autoApproveAndSchedule() { return { approved: false }; },
    async savePlanItems(planId, items) {
      const plan = store.plans.get(planId);
      plan.items = items.map((item) => ({ draftId: item.draftId, slotKey: item.slotKey, channel: item.channel, format: item.format }));
    },
  };
  return { store, ports };
}

/** Minimal thenable Supabase admin for real service/read/coordinator tests. */
function createMemoryAdmin(seed = {}) {
  const tables = new Map(Object.entries(seed).map(([name, rows]) => [name, rows.map((row) => ({ ...row }))]));
  const reads = [];
  const writes = [];
  let sequence = 0;
  const nowIso = NOW.toISOString();

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.ordering = [];
      this.limitCount = null;
      this.insertRows = null;
      this.upsertOptions = null;
      this.patch = null;
      this.deleting = false;
      this.head = false;
    }
    select(_columns, options = {}) { this.head = options.head === true; return this; }
    insert(rows) { this.insertRows = Array.isArray(rows) ? rows : [rows]; return this; }
    upsert(rows, options = {}) { this.insertRows = Array.isArray(rows) ? rows : [rows]; this.upsertOptions = options; return this; }
    update(patch) { this.patch = patch; return this; }
    delete() { this.deleting = true; return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
    in(column, values) {
      const selected = new Set((values ?? []).map(String));
      this.filters.push((row) => selected.has(String(row[column])));
      return this;
    }
    gte(column, value) { this.filters.push((row) => String(row[column] ?? "") >= String(value)); return this; }
    lte(column, value) { this.filters.push((row) => String(row[column] ?? "") <= String(value)); return this; }
    not(column, operator, value) {
      this.filters.push((row) => operator === "is" && value === null ? row[column] !== null && row[column] !== undefined : row[column] !== value);
      return this;
    }
    contains(column, value) {
      this.filters.push((row) => {
        const actual = row[column];
        if (Array.isArray(actual)) return Array.isArray(value) ? value.every((entry) => actual.includes(entry)) : actual.includes(value);
        if (actual && value && typeof actual === "object" && typeof value === "object") {
          return Object.entries(value).every(([key, expected]) => actual[key] === expected);
        }
        return false;
      });
      return this;
    }
    order(column, options = {}) { this.ordering.push({ column, ascending: options.ascending !== false }); return this; }
    limit(count) { this.limitCount = count; return this; }
    _table() {
      if (!tables.has(this.table)) tables.set(this.table, []);
      return tables.get(this.table);
    }
    _selected() {
      let rows = this._table().filter((row) => this.filters.every((filter) => filter(row)));
      for (const { column, ascending } of this.ordering) {
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return (left === right ? 0 : left < right ? -1 : 1) * (ascending ? 1 : -1);
        });
      }
      if (this.limitCount !== null) rows = rows.slice(0, this.limitCount);
      return rows;
    }
    _execute() {
      const table = this._table();
      if (this.insertRows) {
        const output = [];
        for (const incoming of this.insertRows) {
          const row = { id: `${this.table}-${++sequence}`, created_at: nowIso, updated_at: nowIso, ...incoming };
          if (this.upsertOptions?.onConflict) {
            const keys = this.upsertOptions.onConflict.split(",").map((key) => key.trim());
            const existing = table.find((candidate) => keys.every((key) => candidate[key] === row[key]));
            if (existing) {
              if (this.upsertOptions.ignoreDuplicates) continue;
              Object.assign(existing, incoming, { updated_at: nowIso });
              output.push(existing);
              continue;
            }
          }
          table.push(row);
          output.push(row);
        }
        writes.push({ table: this.table, operation: this.upsertOptions ? "upsert" : "insert", count: output.length });
        return { data: output, error: null, count: output.length };
      }
      if (this.patch) {
        const rows = this._selected();
        for (const row of rows) Object.assign(row, this.patch, { updated_at: nowIso });
        writes.push({ table: this.table, operation: "update", count: rows.length });
        return { data: rows, error: null, count: rows.length };
      }
      if (this.deleting) {
        const rows = this._selected();
        for (const row of rows) table.splice(table.indexOf(row), 1);
        writes.push({ table: this.table, operation: "delete", count: rows.length });
        return { data: rows, error: null, count: rows.length };
      }
      const rows = this._selected();
      reads.push(this.table);
      return { data: this.head ? null : rows, error: null, count: rows.length };
    }
    then(resolve, reject) { return Promise.resolve(this._execute()).then(resolve, reject); }
    async maybeSingle() {
      const result = this._execute();
      return { data: result.data?.[0] ?? null, error: result.error };
    }
    async single() {
      const result = this._execute();
      if (result.error) return { data: null, error: result.error };
      if (!result.data?.[0]) return { data: null, error: { code: "PGRST116", message: "No row returned" } };
      return { data: result.data[0], error: null };
    }
  }

  return {
    tables,
    reads,
    writes,
    from: (table) => new Query(table),
    async rpc() { return { data: null, error: { message: "RPC not configured in this test" } }; },
    storage: { from: () => ({
      createSignedUrl: async () => ({ data: null, error: null }),
      createSignedUrls: async (paths) => ({ data: paths.map((path) => ({ signedUrl: null, path })) }),
    }) },
  };
}

function businessRow(preferredChannels, overrides = {}) {
  return {
    id: BUSINESS,
    owner_user_id: OWNER,
    brand_name: "Demo Studio",
    brand_description: "A small, practical business.",
    industry: "Services",
    target_customer: ["Local teams"],
    main_goal: "Grow useful awareness",
    brand_personality: ["Clear", "Practical"],
    preferred_channels: preferredChannels,
    content_frequency: "daily",
    automation_level: "assisted",
    timezone: TZ,
    plan: "pro",
    allow_automatic_paid_media: false,
    onboarding_completed: true,
    ...overrides,
  };
}

function structuredProvider(captured = []) {
  return {
    async structured(request) {
      const payload = JSON.parse(request.messages[1].content);
      captured.push(payload);
      return request.parse({
        concept: `${payload.assignedSocialSlot.channel} ${payload.assignedSocialSlot.format} ${payload.scheduledFor.date}`,
        hook: "A concise native hook.",
        caption: `A native caption for ${payload.assignedSocialSlot.label}.`,
        cta: "Learn more.",
        hashtags: ["useful"],
        description: payload.assignedSocialSlot.channel === "youtube"
          ? "A clear YouTube description with useful context."
          : "",
        script: payload.assignedSocialSlot.channel === "instagram" && payload.assignedSocialSlot.format === "post"
          ? []
          : ["Open", "Explain", "Show a useful detail", "Close"],
        visualBrief: `Production notes for ${payload.assignedSocialSlot.label}.`,
      });
    },
  };
}

function adminSeed({ preferredChannels, drafts = [], plans = [], businessOverrides = {} }) {
  return {
    businesses: [businessRow(preferredChannels, businessOverrides)],
    marketing_plans: plans,
    mara_drafts: drafts,
    mara_conversations: [],
    mara_pending_actions: [],
    mara_media_generations: [],
    post_draft_assets: [],
    instagram_publish_queue: [],
    tiktok_publish_queue: [],
    youtube_publish_queue: [],
    content_calendar_items: [],
    voom_campaigns: [],
    voom_campaign_actions: [],
    campaign_sends: [],
    contacts: [],
    voom_email_flows: [],
    voom_credit_ledger: [],
  };
}

test("supported-channel normalization excludes email, unsupported channels and duplicates", () => {
  assert.deepEqual(
    channelPlanner.normalizeSelectedSocialChannels([" YouTube ", "email", "Instagram", "tiktok", "Threads", "youtube"]),
    ["instagram", "tiktok", "youtube"],
  );
  assert.deepEqual(channelPlanner.normalizeSelectedSocialChannels(["email", "Threads"]), []);
  assert.deepEqual(channelPlanner.normalizeSelectedSocialChannels(["Instagram Reel", "TikTok Video", "YouTube Video"]), ["instagram", "tiktok", "youtube"]);
  assert.deepEqual(channelPlanner.normalizeSelectedSocialChannels(null), []);
});

test("LinkedIn is a selectable text-only planning preference, never a new media format", async () => {
  const { Q_CHANNELS } = await import("../lib/voom/onboardingData.ts");
  assert.ok(Q_CHANNELS.includes("LinkedIn"));
  assert.deepEqual(channelPlanner.normalizeSelectedSocialChannels(["LinkedIn", "linkedin_text", "email", "linkedin video"]), ["linkedin"]);
  assert.deepEqual(channelPlanner.parseWorkflowSlotIdentity(`${DATE}|linkedin_text`), {date:DATE,channel:"linkedin",format:"text",legacy:false});
  assert.equal(channelPlanner.parseWorkflowSlotIdentity(`${DATE}|linkedin_video`), null);
  assert.equal(planningChannels.isPlanChannelFormat("linkedin", "post"), false);
  assert.equal(channels.isSocialMediaChannel("linkedin"), false, "no media-generation eligibility added");
});

const linkedinContent = (overrides = {}) => ({
  concept:"A practical lesson for business owners", hook:"",
  caption:"A useful professional lesson from running a small business.\n\nExplain the trade-off and offer an actionable takeaway.",
  cta:"What has worked for your team?", hashtags:["SmallBusiness"], description:"", script:[], visualBrief:"", ...overrides,
});
const linkedinProvider = { async structured(request) {
  assert.match(request.messages[0].content, /LinkedIn Text Post:.*professional\/business/);
  return request.parse(linkedinContent());
} };

test("LinkedIn plans are owner-scoped, idempotent and never auto-approved or queued in any automation mode", async () => {
  for (const mode of ["manual","assisted","autopilot"]) {
    const admin = createMemoryAdmin(adminSeed({preferredChannels:["LinkedIn","Email"],businessOverrides:{automation_level:mode,plan:"max"}}));
    admin.tables.get("mara_drafts").push({id:"other-owner",owner_user_id:"someone-else",kind:"linkedin_text",content:"Private text",source_plan_id:"another-plan"});
    const input = {ownerId:OWNER,now:NOW,trigger:"replenish",planningDeps:{provider:linkedinProvider}};
    const first = await service.runOwnerWorkflow(admin,input);
    assert.equal(first.created,7,mode);
    assert.equal(first.failures.length,0,mode);
    const drafts = admin.tables.get("mara_drafts").filter(d=>d.owner_user_id===OWNER);
    assert.equal(drafts.length,7);
    for (const draft of drafts) {
      assert.equal(draft.kind,"linkedin_text");assert.equal(draft.social_channel,"linkedin");assert.equal(draft.social_format,"text");
      assert.equal(draft.status,"draft");assert.equal(draft.media_brief,null);assert.doesNotMatch(draft.content,/CTA:/);
      assert.ok(draft.content.length<=3000);
    }
    const again = await service.runOwnerWorkflow(admin,input);
    assert.equal(again.created,0);assert.equal(again.reused,7);
    assert.ok(!admin.reads.includes("linkedin_connections"),"connection is not planning eligibility");
    assert.ok(!admin.writes.some(w=>/publish_queue|media_generations|pending_actions|content_calendar/.test(w.table)),"no execution side effects");
    const snapshot = await workflowRead.loadWorkflowSnapshot(admin,OWNER,{now:NOW});
    assert.equal(snapshot.items.length,7);
    assert.ok(snapshot.items.every(item=>item.channel==="linkedin"&&item.contentType==="text"&&item.status==="planned"&&!item.hasMedia));
    assert.ok(snapshot.items.every(item=>item.statusLabel.includes("explicit LinkedIn approval")));
    assert.equal(admin.tables.get("mara_drafts").find(d=>d.id==="other-owner").content,"Private text");
    const state = await (await import("../lib/coordinator/state.ts")).buildMarketingState(admin,OWNER,BUSINESS,NOW);
    assert.ok(state.commitments.filter(c=>c.channel==="linkedin_text").length===7,"LinkedIn is not misclassified as Instagram coverage");
    assert.equal((await import("../lib/coordinator/engine.ts")).identifyCalendarGaps(state).length,0);
    if (mode==="manual") {
      const scheduled = await service.runOwnerWorkflow(admin,{...input,trigger:"scheduled"});
      assert.equal(scheduled.created,0);
    }
  }
});

test("LinkedIn generation rejects media, long text and platform reassignment before any persistence", async () => {
  const input = {business:{brand_name:"Demo"},goal:"Awareness",cadence:"daily",timeZone:TZ,
    slot:{date:DATE,slotKey:`${DATE}|linkedin_text`,channel:"linkedin",format:"text",contentType:"text",publishAt:timezone.localToUtcIso(DATE,1110,TZ)},plannedConcepts:[]};
  const valid = await service.generateWorkflowPlannedContent({...input,provider:linkedinProvider});
  assert.equal(valid.visualBrief,"");assert.deepEqual(valid.script,[]);
  for (const invalid of [{caption:"x".repeat(2990)}, {script:["Upload a video"]},{visualBrief:"Generate an image"},
    {description:"Company Page"},{hook:"Video hook"},{hashtags:["a","b","c","d"]},{channel:"instagram"},{caption:"   "}]) {
    await assert.rejects(()=>service.generateWorkflowPlannedContent({...input,provider:{async structured(request){return request.parse(linkedinContent(invalid));}}}),/content_generation_failed/);
  }
  let calls=0;
  await assert.rejects(()=>service.generateWorkflowPlannedContent({...input,slot:{...input.slot,format:"video"},provider:{async structured(){calls++;}}}),/content_generation_failed/);
  assert.equal(calls,0);
});

test("LinkedIn queue truth and owner isolation survive readback and preference changes", async () => {
  const admin=createMemoryAdmin(adminSeed({preferredChannels:["LinkedIn"]}));
  const input={ownerId:OWNER,now:NOW,trigger:"replenish",planningDeps:{provider:linkedinProvider}};
  await service.runOwnerWorkflow(admin,input);
  const drafts=admin.tables.get("mara_drafts");
  const states=["scheduled","claimed","submitting","uncertain","published","failed","permission_required"];
  admin.tables.set("linkedin_publish_queue",states.map((status,i)=>({draft_id:drafts[i].id,owner_user_id:OWNER,status})));
  admin.tables.get("linkedin_publish_queue").unshift({draft_id:drafts[0].id,owner_user_id:"other-owner",status:"published"});
  const snapshot=await workflowRead.loadWorkflowSnapshot(admin,OWNER,{now:NOW});
  assert.deepEqual(snapshot.items.map(i=>i.status),["scheduled","publishing","publishing","failed","published","failed","failed"]);
  assert.equal(snapshot.items.find(i=>i.queueStatus==="uncertain").statusLabel,"Check LinkedIn — result unknown");
  assert.equal(snapshot.items[0].queueStatus,"scheduled","another owner's row cannot override status");
  admin.tables.get("businesses")[0].preferred_channels=["YouTube"];
  const before=drafts.map(d=>[d.id,d.content,d.source_plan_item_key]);
  const rerun=await service.runOwnerWorkflow(admin,{...input,planningDeps:{provider:structuredProvider()}});
  assert.equal(rerun.created,0,"provider-owned LinkedIn work is retained even when preferences change");
  assert.deepEqual(drafts.map(d=>[d.id,d.content,d.source_plan_item_key]),before);
});

test("every supported channel combination assigns one valid native item per date and balances deterministically", () => {
  const combinations = [
    ["instagram"], ["tiktok"], ["youtube"],
    ["instagram", "tiktok"], ["instagram", "youtube"], ["tiktok", "youtube"],
    ["instagram", "tiktok", "youtube"],
    ["linkedin"], ["instagram", "linkedin"], ["tiktok", "linkedin"], ["youtube", "linkedin"],
    ["instagram", "tiktok", "linkedin"], ["instagram", "youtube", "linkedin"], ["tiktok", "youtube", "linkedin"],
    ["instagram", "tiktok", "youtube", "linkedin"],
  ];
  for (const selectedChannels of combinations) {
    const input = baseInput({ selectedChannels });
    const slots = rolling.buildSlots(input);
    const again = rolling.buildSlots(input);
    assert.equal(slots.length, 7, `${selectedChannels.join("+")}: one item per daily cadence slot`);
    assert.deepEqual(slots.map(({ date, channel, format, slotKey }) => [date, channel, format, slotKey]),
      again.map(({ date, channel, format, slotKey }) => [date, channel, format, slotKey]), "same inputs have the same assignment");
    assert.equal(new Set(slots.map((slot) => slot.date)).size, 7, "no date is cloned across platforms");
    for (const slot of slots) {
      assert.ok(selectedChannels.includes(slot.channel), `unselected ${slot.channel} leaked into ${selectedChannels}`);
      assert.ok(planningChannels.isPlanChannelFormat(slot.channel, slot.format), `${slot.channel}/${slot.format} is native`);
      assert.equal(slot.slotKey, channelPlanner.workflowSlotKey(slot.date, slot.channel, slot.format));
      if (slot.channel === "instagram") assert.equal(slot.contentType, slot.format);
      if (slot.channel === "tiktok") assert.equal(slot.contentType, "video");
      if (slot.channel === "youtube") assert.equal(slot.contentType, slot.format === "short" ? "short" : "video");
      if (slot.channel === "linkedin") assert.equal(slot.contentType, "text");
    }
    const channelCounts = selectedChannels.map((channel) => slots.filter((slot) => slot.channel === channel).length);
    assert.ok(Math.max(...channelCounts) - Math.min(...channelCounts) <= 1, `channel balance: ${channelCounts}`);
    for (const channel of selectedChannels) {
      const formats = planningChannels.PLAN_FORMATS[channel];
      const counts = formats.map((format) => slots.filter((slot) => slot.channel === channel && slot.format === format).length);
      if (counts.length > 1) assert.ok(Math.max(...counts) - Math.min(...counts) <= 1, `${channel} format balance: ${counts}`);
    }
  }
});

test("Instagram rotation and YouTube Short/Video distribution stay native", () => {
  const instagram = rolling.buildSlots(baseInput({ selectedChannels: ["Instagram"] }));
  assert.deepEqual(instagram.slice(0, 3).map((slot) => slot.format), ["post", "reel", "story"]);
  assert.ok(instagram.every((slot) => slot.channel === "instagram"));

  const youtube = rolling.buildSlots(baseInput({ selectedChannels: ["YouTube"] }));
  assert.deepEqual(new Set(youtube.map((slot) => slot.format)), new Set(["short", "video"]));
  assert.equal(youtube.filter((slot) => slot.format === "short").length, 4);
  assert.equal(youtube.filter((slot) => slot.format === "video").length, 3);
  assert.ok(youtube.every((slot) => slot.channel === "youtube"));
});

test("no selection never falls back to Instagram and returns an actionable blocked result", async () => {
  assert.deepEqual(rolling.buildSlots(baseInput({ selectedChannels: [] })), []);
  assert.deepEqual(rolling.buildSlots(baseInput({ selectedChannels: undefined })), []);
  const { ports, store } = createPlannerStore();
  const result = await rolling.ensureRollingPlan(ports, baseInput({ selectedChannels: [] }));
  assert.equal(result.blockedReason, "no_supported_social_channels_selected");
  assert.equal(result.planId, null);
  assert.equal(result.plan, null);
  assert.equal(result.created, 0);
  assert.equal(store.calls.generate, 0);
  assert.equal(store.calls.media, 0);
});

test("no selection clears stale active-plan cards but keeps protected work untouched", async () => {
  const draft = {
    id: "unselected-instagram", owner_user_id: OWNER, conversation_id: "workflow", source_plan_id: "active-plan",
    source_plan_item_key: `${DATE}|instagram_post`, kind: "instagram_post", channel: "Instagram",
    title: "Old Instagram draft", content: "Existing draft text.", proposed_publish_at: timezone.localToUtcIso(DATE, 18 * 60 + 30, TZ),
    status: "draft", social_channel: "instagram", social_format: "post", content_meta: {},
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  const plan = {
    id: "active-plan", owner_user_id: OWNER, business_id: BUSINESS, status: "active",
    business_goal: "Awareness", selected_channels: ["Instagram"], content_frequency: "Daily",
    valid_from: DATE, valid_until: DATE,
    planned_posts: [{ draftId: draft.id, slotKey: draft.source_plan_item_key, channel: "Instagram", format: "post" }],
    created_at: NOW.toISOString(),
  };
  const admin = createMemoryAdmin(adminSeed({ preferredChannels: [], plans: [plan], drafts: [draft] }));
  const result = await service.runOwnerWorkflow(admin, {
    ownerId: OWNER, now: NOW, trigger: "replenish",
    planningDeps: { provider: structuredProvider(), performanceContext: async () => null },
  });
  assert.equal(result.blockedReason, "no_supported_social_channels_selected");
  assert.equal(admin.tables.get("mara_drafts")[0].source_plan_id, null);
  assert.equal(admin.tables.get("mara_drafts")[0].source_plan_item_key, null);
  assert.equal(admin.tables.get("marketing_plans")[0].selected_channels.length, 0);
  assert.deepEqual(admin.tables.get("marketing_plans")[0].planned_posts, []);
  assert.equal(admin.tables.get("mara_drafts").length, 1, "detaching never deletes draft history");
});

test("Build/Replenish and scheduled Assisted runs share the same server assignment and repeat idempotently", async () => {
  const selectedChannels = ["YouTube", "TikTok"];
  const first = createPlannerStore();
  const build = await rolling.ensureRollingPlan(first.ports, baseInput({ selectedChannels, trigger: "replenish" }));
  const buildKeys = build.plan.items.map((item) => [item.slotKey, item.channel, item.format]);
  assert.equal(build.created, 7);

  const second = createPlannerStore();
  const replenish = await rolling.ensureRollingPlan(second.ports, baseInput({ selectedChannels, trigger: "replenish" }));
  assert.deepEqual(replenish.plan.items.map((item) => [item.slotKey, item.channel, item.format]), buildKeys);

  const rerun = await rolling.ensureRollingPlan(first.ports, baseInput({ selectedChannels, trigger: "replenish" }));
  assert.equal(rerun.created, 0);
  assert.equal(rerun.reused, 7);
  assert.equal(first.store.calls.generate, 7, "retry generates no duplicate content");
  assert.deepEqual(rerun.plan.items.map((item) => [item.slotKey, item.channel, item.format]), buildKeys);
});

test("coordinator channel coverage biases balance without filling already-covered dates or counting email", () => {
  const dates = ["2026-09-12", "2026-09-13", "2026-09-14", "2026-09-15"];
  const uncoveredDates = dates.slice(1);
  const assigned = channelPlanner.planChannelAssignments({
    dates: uncoveredDates,
    today: DATE,
    selectedChannels: ["tiktok", "youtube"],
    coverage: [
      { date: "2026-09-12", channel: "tiktok_video" },
      { date: "2026-09-12", channel: "tiktok_video" },
      { date: "2026-09-13", channel: "email" },
    ],
  });
  const withoutDuplicate = channelPlanner.planChannelAssignments({
    dates: uncoveredDates,
    today: DATE,
    selectedChannels: ["tiktok", "youtube"],
    coverage: [{ date: "2026-09-12", channel: "tiktok_video" }],
  });
  assert.deepEqual(assigned.assignments.map((slot) => slot.date), uncoveredDates, "only coordinator-supplied gap dates are assigned");
  assert.deepEqual(assigned.assignments.map((slot) => [slot.date, slot.channel, slot.format]),
    withoutDuplicate.assignments.map((slot) => [slot.date, slot.channel, slot.format]), "duplicate commitments count once and email is ignored");
  assert.equal(assigned.assignments.filter((slot) => slot.channel === "tiktok").length, 1);
  assert.equal(assigned.assignments.filter((slot) => slot.channel === "youtube").length, 2);
});

test("real workflow persists actual selected channels and native keys, plans while disconnected, and reads back idempotently", async () => {
  const captured = [];
  const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["YouTube", "TikTok"] }));
  const planningDeps = { provider: structuredProvider(captured), performanceContext: async () => null };
  const input = { ownerId: OWNER, now: NOW, trigger: "replenish", planningDeps };

  const first = await service.runOwnerWorkflow(admin, input);
  assert.equal(first.created, 7);
  assert.equal(first.blockedReason, null);
  assert.equal(admin.tables.get("mara_drafts").length, 7);
  assert.equal(admin.tables.get("marketing_plans")[0].selected_channels.join(","), "TikTok,YouTube");
  assert.equal(captured.length, 7);
  assert.ok(captured.every((payload) => channels.isValidChannelFormat(payload.assignedSocialSlot.channel, payload.assignedSocialSlot.format)));
  assert.ok(captured.every((payload) => payload.assignedSocialSlot.channel !== "instagram"));
  assert.equal(admin.tables.has("tiktok_connections"), false, "planning does not require a TikTok connection");
  assert.equal(admin.tables.has("youtube_connections"), false, "planning does not require a YouTube connection");
  assert.equal(admin.tables.get("tiktok_publish_queue").length, 0);
  assert.equal(admin.tables.get("youtube_publish_queue").length, 0);

  for (const draft of admin.tables.get("mara_drafts")) {
    const identity = channelPlanner.parseWorkflowSlotIdentity(draft.source_plan_item_key);
    assert.equal(identity.date, timezone.isoToLocalDate(draft.proposed_publish_at, TZ));
    assert.equal(identity.channel, draft.social_channel);
    assert.equal(identity.format, draft.social_format);
    assert.ok(channels.isValidChannelFormat(draft.social_channel, draft.social_format));
    assert.equal(draft.kind, draft.social_channel === "tiktok"
      ? "tiktok_video"
      : draft.social_format === "short" ? "youtube_short" : "youtube_video");
  }
  const planned = admin.tables.get("marketing_plans")[0].planned_posts;
  assert.equal(planned.length, 7);
  assert.ok(planned.every((item) => item.channelFormat === `${item.channel === "TikTok" ? "tiktok" : "youtube"}_${item.format}`));

  const snapshot = await workflowRead.loadWorkflowSnapshot(admin, OWNER, { now: NOW });
  assert.deepEqual(snapshot.selectedChannels, ["tiktok", "youtube"]);
  assert.equal(snapshot.items.length, 7);
  assert.ok(snapshot.items.every((item) => item.channel === "tiktok" || item.channel === "youtube"));
  assert.ok(snapshot.items.every((item) => item.sourcePlanItemKey.includes("|")));
  assert.ok(snapshot.items.every((item) => item.status === "planned"));

  const rerun = await service.runOwnerWorkflow(admin, input);
  assert.equal(rerun.created, 0);
  assert.equal(rerun.reused, 7);
  assert.equal(admin.tables.get("mara_drafts").length, 7);
  assert.equal(captured.length, 7, "same channel/format slot identities are reused across retries");
});

test("preference changes detach only unexecuted drafts and never relabel protected work", async () => {
  const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["TikTok", "YouTube"] }));
  const planningDeps = { provider: structuredProvider(), performanceContext: async () => null };
  const first = await service.runOwnerWorkflow(admin, { ownerId: OWNER, now: NOW, trigger: "replenish", planningDeps });
  assert.equal(first.created, 7);

  const tikTokDrafts = admin.tables.get("mara_drafts").filter((draft) => draft.social_channel === "tiktok");
  assert.equal(tikTokDrafts.length, 4);
  const protectedDraft = tikTokDrafts[0];
  const protectedIdentity = protectedDraft.source_plan_item_key;
  protectedDraft.status = "approved";
  const detachedCandidates = tikTokDrafts.slice(1);

  admin.tables.get("businesses")[0].preferred_channels = ["YouTube"];
  const changed = await service.runOwnerWorkflow(admin, { ownerId: OWNER, now: NOW, trigger: "replenish", planningDeps });
  assert.equal(changed.blockedReason, null);
  assert.equal(admin.tables.get("marketing_plans")[0].selected_channels.join(","), "YouTube");
  assert.equal(protectedDraft.source_plan_id, first.planId);
  assert.equal(protectedDraft.source_plan_item_key, protectedIdentity);
  assert.equal(protectedDraft.social_channel, "tiktok");
  assert.equal(protectedDraft.status, "approved");
  assert.ok(detachedCandidates.every((draft) => draft.source_plan_id === null && draft.source_plan_item_key === null));
  assert.ok(detachedCandidates.every((draft) => draft.social_channel === "tiktok" && draft.status === "draft"));

  const active = admin.tables.get("mara_drafts").filter((draft) => draft.source_plan_id === first.planId);
  assert.equal(active.length, 7);
  assert.equal(new Set(active.map((draft) => timezone.isoToLocalDate(draft.proposed_publish_at, TZ))).size, 7);
  assert.equal(active.filter((draft) => draft.social_channel === "tiktok").length, 1, "only protected TikTok work remains on its original channel");
  assert.equal(active.filter((draft) => draft.social_channel === "youtube").length, 6);
  const snapshot = await workflowRead.loadWorkflowSnapshot(admin, OWNER, { now: NOW });
  assert.deepEqual(snapshot.selectedChannels, ["youtube"]);
  assert.equal(snapshot.items.length, 7);
  const retained = snapshot.items.find((item) => item.draftId === protectedDraft.id);
  assert.equal(retained.channel, "tiktok");
  assert.equal(retained.sourcePlanItemKey, protectedIdentity);
  assert.equal(retained.status, "needs_content", "approved without durable queue sync is still actionable, not queued");
});

test("legacy Instagram date-keyed plan items remain readable and reusable", async () => {
  const legacyPlan = {
    id: "legacy-plan",
    owner_user_id: OWNER,
    business_id: BUSINESS,
    status: "active",
    business_goal: "Legacy awareness plan",
    valid_from: DATE,
    valid_until: "2026-09-18",
    selected_channels: ["Instagram"],
    created_at: "2026-09-01T00:00:00.000Z",
    planned_posts: [],
  };
  const legacyDraft = {
    id: "legacy-instagram-draft",
    owner_user_id: OWNER,
    conversation_id: "legacy-conversation",
    source_plan_id: "legacy-plan",
    source_plan_item_key: DATE,
    kind: "instagram_post",
    channel: "Instagram",
    title: "Legacy Instagram Post",
    content: "An existing Instagram plan item.",
    proposed_publish_at: timezone.localToUtcIso(DATE, 18 * 60 + 30, TZ),
    status: "draft",
    created_at: "2026-09-01T00:00:00.000Z",
  };
  const admin = createMemoryAdmin(adminSeed({
    preferredChannels: ["Instagram"],
    plans: [legacyPlan],
    drafts: [legacyDraft],
  }));
  const planningDeps = { provider: structuredProvider(), performanceContext: async () => null };
  const result = await service.runOwnerWorkflow(admin, { ownerId: OWNER, now: NOW, trigger: "replenish", planningDeps });
  assert.equal(result.reused, 1);
  assert.equal(result.created, 6);
  assert.equal(admin.tables.get("mara_drafts").find((draft) => draft.id === legacyDraft.id).source_plan_item_key, DATE);

  const snapshot = await workflowRead.loadWorkflowSnapshot(admin, OWNER, { now: NOW });
  const item = snapshot.items.find((entry) => entry.draftId === legacyDraft.id);
  assert.ok(item);
  assert.equal(item.channel, "instagram");
  assert.equal(item.format, "post");
  assert.equal(item.status, "planned");
  assert.equal(snapshot.items.length, 7);
});

function installLocalAiFetch() {
  process.env.AI_PROVIDER = "local";
  process.env.AI_BASE_URL = "http://ai.test.invalid/v1";
  process.env.AI_MODEL = "marketing-plan-test";
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const href = String(url);
    if (!href.endsWith("/chat/completions")) throw new Error(`Unexpected outbound test request: ${href}`);
    const request = JSON.parse(String(init.body ?? "{}"));
    const payload = JSON.parse(request.messages.find((message) => message.role === "user")?.content ?? "{}");
    requests.push(payload);
    const channel = payload.assignedSocialSlot?.channel ?? "instagram";
    const format = payload.assignedSocialSlot?.format ?? "post";
    const content = {
      concept: `${channel} ${format} coordinator item ${payload.scheduledFor?.date ?? "date"}`,
      hook: "A simple opening hook.",
      caption: `A useful ${channel} update for the community.`,
      cta: "Learn more.",
      hashtags: ["local"],
      description: channel === "youtube" ? "A useful YouTube description with context." : "",
      script: channel === "instagram" && format === "post"
        ? []
        : ["Open", "Explain the topic", "Share a practical detail", "Close clearly"],
      visualBrief: `Production direction for ${channel} ${format}.`,
    };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  return { requests, restore: () => { globalThis.fetch = originalFetch; } };
}

test("native generation enforces TikTok caption and YouTube title limits before persistence", async () => {
  const generate = (channel, format, content) => service.generateWorkflowPlannedContent({
    business: { brand_name: "Demo" },
    goal: "Grow awareness",
    cadence: "daily",
    timeZone: TZ,
    slot: {
      date: DATE,
      slotKey: `${DATE}|${channel}_${format}`,
      index: 0,
      channel,
      format,
      contentType: channel === "youtube" && format === "short" ? "short" : "video",
      publishAt: timezone.localToUtcIso(DATE, 18 * 60 + 30, TZ),
    },
    plannedConcepts: [],
    performance: null,
    provider: { async structured(request) { return request.parse(content); } },
  });
  const base = {
    concept: "Native format",
    hook: "A clear hook.",
    caption: "A useful native caption.",
    cta: "Learn more.",
    hashtags: ["useful"],
    description: "A useful YouTube description with context.",
    script: ["Open", "Explain", "Payoff"],
    visualBrief: "Native production direction.",
  };
  await assert.rejects(() => generate("tiktok", "video", { ...base, caption: "x".repeat(2100), cta: "y".repeat(160) }), /content_generation_failed/);
  await assert.rejects(() => generate("youtube", "short", { ...base, concept: "x".repeat(101) }), /content_generation_failed/);
});

test("TikTok/YouTube approval never reports queued success when durable queue sync fails", async () => {
  for (const [kind, channel, format, id] of [
    ["tiktok_video", "tiktok", "video", "failed-tiktok-approval"],
    ["youtube_short", "youtube", "short", "failed-youtube-approval"],
  ]) {
    const draft = {
      id,
      owner_user_id: OWNER,
      conversation_id: "social-studio",
      kind,
      channel: `${channel} native video`,
      title: `${channel} video concept`,
      content: "A native caption.",
      proposed_publish_at: timezone.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ),
      status: "draft",
      social_channel: channel,
      social_format: format,
      content_meta: channel === "youtube"
        ? { description: "A useful description for this YouTube Short.", madeForKids: false, privacy: "unlisted", script: ["Open", "Explain", "Payoff"] }
        : { tiktokPrivacy: "SELF_ONLY", script: ["Open", "Explain", "Payoff"] },
      created_at: NOW.toISOString(),
      updated_at: NOW.toISOString(),
    };
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: [channel], drafts: [draft] }));
    await assert.rejects(
      () => socialDrafts.updateSocialDraft(admin, OWNER, id, { decision: "approved" }),
      new RegExp(`${channel}_publish_enqueue_failed`),
    );
    assert.equal(admin.tables.get("mara_drafts")[0].status, "approved", "approval is durable even when queue sync needs retry");
    assert.equal(admin.tables.get("content_calendar_items")[0].status, "scheduled", "calendar state is only a mirror, not publication");
    assert.equal(admin.tables.get(`${channel}_publish_queue`).length, 0, "failed sync never invents a queue row");
    const visible = await socialDrafts.getSocialDraft(admin, OWNER, id);
    assert.equal(visible.publishState, "approved", "approval alone never means published");
    assert.equal(visible.publishStateLabel, "Approved — queue sync not confirmed");
  }
});

test("queue cancellation errors leave draft and Calendar unchanged, and provider-owned video history cannot be edited", async () => {
  for (const [kind, channel, format, queueStatus, id] of [
    ["tiktok_video", "tiktok", "video", "scheduled", "cancel-error-tiktok"],
    ["youtube_video", "youtube", "video", "scheduled", "cancel-error-youtube"],
  ]) {
    const draft = {
      id, owner_user_id: OWNER, conversation_id: "social-studio", kind,
      channel: `${channel} native video`, title: "Current video", content: "Current caption",
      proposed_publish_at: timezone.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ), status: "approved",
      social_channel: channel, social_format: format, content_meta: {},
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: [channel], drafts: [draft] }));
    admin.tables.get(`${channel}_publish_queue`).push({ owner_user_id: OWNER, draft_id: id, status: queueStatus });
    admin.tables.get("content_calendar_items").push({ owner_user_id: OWNER, source_draft_id: id, status: "scheduled" });

    await assert.rejects(
      () => socialDrafts.updateSocialDraft(admin, OWNER, id, { decision: "draft" }),
      new RegExp(`${channel}_publish_cancel_failed`),
    );
    assert.equal(admin.tables.get("mara_drafts")[0].status, "approved", "a failed cancel cannot mutate approval state");
    assert.equal(admin.tables.get("content_calendar_items")[0].status, "scheduled", "a failed cancel cannot remove the calendar mirror");
    assert.equal(admin.tables.get(`${channel}_publish_queue`)[0].status, "scheduled");
  }

  for (const [kind, channel, format, queueStatus, id] of [
    ["tiktok_video", "tiktok", "video", "posting", "owned-tiktok"],
    ["youtube_video", "youtube", "video", "uploading", "owned-youtube"],
  ]) {
    const draft = {
      id, owner_user_id: OWNER, conversation_id: "social-studio", kind,
      channel: `${channel} native video`, title: "Provider-owned video", content: "Published history",
      proposed_publish_at: timezone.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ), status: "approved",
      social_channel: channel, social_format: format, content_meta: {},
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    };
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: [channel], drafts: [draft] }));
    admin.tables.get(`${channel}_publish_queue`).push({ owner_user_id: OWNER, draft_id: id, status: queueStatus });

    await assert.rejects(
      () => socialDrafts.updateSocialDraft(admin, OWNER, id, { title: "Must not rewrite provider-owned history" }),
      /social_draft_provider_owned/,
    );
    assert.equal(admin.tables.get("mara_drafts")[0].title, "Provider-owned video");
    assert.equal(admin.tables.get(`${channel}_publish_queue`)[0].status, queueStatus);
  }

  const racedDraft = {
    id: "cancel-race-tiktok", owner_user_id: OWNER, conversation_id: "social-studio", kind: "tiktok_video",
    channel: "TikTok · 9:16", title: "Concurrent video", content: "Concurrent caption",
    proposed_publish_at: timezone.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ), status: "approved",
    social_channel: "tiktok", social_format: "video", content_meta: {},
    created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
  };
  const racedAdmin = createMemoryAdmin(adminSeed({ preferredChannels: ["TikTok"], drafts: [racedDraft] }));
  racedAdmin.tables.get("tiktok_publish_queue").push({
    owner_user_id: OWNER, draft_id: racedDraft.id, status: "scheduled",
  });
  racedAdmin.rpc = async (name) => {
    if (name === "cancel_tiktok_publish_queue_item") {
      racedAdmin.tables.get("tiktok_publish_queue")[0].status = "posting";
      return { data: false, error: null };
    }
    return { data: null, error: { message: "RPC not configured in this test" } };
  };
  await assert.rejects(
    () => socialDrafts.updateSocialDraft(racedAdmin, OWNER, racedDraft.id, { decision: "draft" }),
    /social_draft_provider_owned/,
  );
  assert.equal(racedAdmin.tables.get("mara_drafts")[0].status, "approved", "a raced provider claim cannot be reported as cancelled");
});

test("Calendar labels TikTok/YouTube from their durable queues and exposes only safe asset metadata", async () => {
  const scheduledAt = timezone.localToUtcIso("2026-09-14", 18 * 60 + 30, TZ);
  const drafts = [
    {
      id: "calendar-tiktok", owner_user_id: OWNER, conversation_id: "studio", kind: "tiktok_video",
      channel: "TikTok · 9:16", title: "TikTok item", content: "Caption", proposed_publish_at: scheduledAt,
      status: "approved", social_channel: "tiktok", social_format: "video", content_meta: {},
      source_plan_id: "plan-calendar", source_plan_item_key: "2026-09-14|tiktok_video",
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    },
    {
      id: "calendar-youtube", owner_user_id: OWNER, conversation_id: "studio", kind: "youtube_short",
      channel: "YouTube Short · 9:16", title: "YouTube item", content: "Caption", proposed_publish_at: scheduledAt,
      status: "approved", social_channel: "youtube", social_format: "short", content_meta: {},
      source_plan_id: null, source_plan_item_key: null,
      created_at: NOW.toISOString(), updated_at: NOW.toISOString(),
    },
  ];
  const admin = createMemoryAdmin(adminSeed({
    preferredChannels: ["TikTok", "YouTube"],
    drafts,
  }));
  admin.tables.get("tiktok_publish_queue").push({
    owner_user_id: OWNER, draft_id: "calendar-tiktok", status: "scheduled", failure_message: null,
  });
  admin.tables.get("youtube_publish_queue").push({
    owner_user_id: OWNER, draft_id: "calendar-youtube", status: "published", provider_privacy_status: "private", failure_message: null,
  });
  admin.tables.get("post_draft_assets").push({
    owner_user_id: OWNER, draft_id: "calendar-tiktok", status: "uploaded", display_name: "clip.mp4", mime_type: "video/mp4",
  });
  const items = await socialDrafts.listSocialCalendarItems(admin, OWNER, NOW);
  const tiktok = items.find((item) => item.draftId === "calendar-tiktok");
  const youtube = items.find((item) => item.draftId === "calendar-youtube");
  assert.equal(tiktok.statusLabel, "Scheduled — publishes through the TikTok queue");
  assert.equal(tiktok.sourceLabel, "Marketing Plan");
  assert.deepEqual(tiktok.media, { displayName: "clip.mp4", mimeType: "video/mp4" });
  assert.equal(youtube.statusLabel, "Published on YouTube (private — see the connection's audit note)");
  assert.equal(youtube.sourceLabel, "Studio");
  assert.equal(youtube.queueStatus, "published", "Published follows only provider-confirmed queue state");
});

test("coordinator fills only uncovered social gap dates and reports actual outcomes", async (t) => {
  const network = installLocalAiFetch();
  t.after(network.restore);
  const committedDate = "2026-09-14";
  const commitment = {
    id: "standalone-tiktok",
    owner_user_id: OWNER,
    source_plan_id: null,
    source_plan_item_key: null,
    kind: "tiktok_video",
    social_channel: "tiktok",
    social_format: "video",
    channel: "TikTok · 9:16",
    title: "Existing TikTok commitment",
    content: "A standalone draft already covers this date.",
    proposed_publish_at: timezone.localToUtcIso(committedDate, 18 * 60 + 30, TZ),
    status: "draft",
    created_at: NOW.toISOString(),
  };
  const admin = createMemoryAdmin(adminSeed({
    preferredChannels: ["TikTok", "YouTube"],
    drafts: [commitment],
    businessOverrides: { content_frequency: "3x per week" },
  }));
  const result = await coordinator.runCoordinatorForOwner(admin, OWNER, BUSINESS, { now: NOW, trigger: "scheduled" });
  const gapAction = result.actionsTaken.find((action) => action.type.startsWith("gap_filling") || action.type === "fill_calendar_gaps");
  assert.ok(gapAction);
  const gapDates = result.evaluation.gaps.map((gap) => gap.date);
  assert.deepEqual(gapDates, ["2026-09-12", "2026-09-17"]);
  assert.equal(gapAction.details.gapsRequested, 2);
  assert.equal(gapAction.details.gapsFilled, 2);
  assert.equal(gapAction.details.gapsRemaining, 0);
  assert.equal(gapAction.details.blockedReason, undefined);
  assert.equal(gapAction.details.slotsAttempted, 2);
  const newDrafts = admin.tables.get("mara_drafts").filter((draft) => draft.source_plan_id);
  assert.equal(newDrafts.length, 2);
  assert.deepEqual(newDrafts.map((draft) => timezone.isoToLocalDate(draft.proposed_publish_at, TZ)).sort(), gapDates);
  assert.ok(newDrafts.every((draft) => draft.source_plan_item_key.includes("|")));
  assert.equal(admin.tables.get("mara_drafts").find((draft) => draft.id === "standalone-tiktok").source_plan_id, null);
  assert.equal(network.requests.length, 2);
  assert.ok(network.requests.every((payload) => payload.assignedSocialSlot.channel === "tiktok" || payload.assignedSocialSlot.channel === "youtube"));
});

test("coordinator reports missing selected channels as a blocked gap fill, not success", async () => {
  const admin = createMemoryAdmin(adminSeed({ preferredChannels: [], businessOverrides: { content_frequency: "3x per week" } }));
  const result = await coordinator.runCoordinatorForOwner(admin, OWNER, BUSINESS, { now: NOW, trigger: "scheduled" });
  const action = result.actionsTaken.find((entry) => entry.type === "gap_filling_blocked");
  assert.ok(action);
  assert.equal(action.details.gapsRequested, 3);
  assert.equal(action.details.gapsFilled, 0);
  assert.equal(action.details.gapsRemaining, 3);
  assert.equal(action.details.blockedReason, "no_supported_social_channels_selected");
  assert.equal(admin.tables.get("mara_drafts").length, 0);
});

test("MARA receives the immutable channel/format assignment and cannot return a replacement", async () => {
  const payload = prompt.buildPlannedContentPayload({
    business: { name: "Demo" },
    goal: "Grow awareness",
    cadenceLabel: "Daily",
    channel: "youtube",
    format: "short",
    localDate: DATE,
    localTime: "6:30 pm",
    timezone: TZ,
    recentConcepts: [],
  });
  assert.deepEqual(payload.assignedSocialSlot, { channel: "youtube", format: "short", label: "YouTube Short" });
  assert.equal(payload.contentType, "youtube_short");
  assert.equal("channel" in prompt.plannedContentJsonSchema.schema.properties, false);
  assert.equal("format" in prompt.plannedContentJsonSchema.schema.properties, false);

  await assert.rejects(
    () => service.generateWorkflowPlannedContent({
      business: { brand_name: "Demo" },
      goal: "Grow awareness",
      cadence: "daily",
      timeZone: TZ,
      slot: { date: DATE, slotKey: `${DATE}|youtube_short`, index: 0, channel: "youtube", format: "short", contentType: "short", publishAt: timezone.localToUtcIso(DATE, 18 * 60 + 30, TZ) },
      plannedConcepts: [],
      performance: null,
      provider: {
        async structured(request) {
          return request.parse({
            concept: "Attempted reassignment",
            hook: "Hook",
            caption: "Native caption.",
            cta: "Learn more.",
            hashtags: [],
            description: "A useful description for this YouTube Short.",
            script: ["Open", "Explain", "Payoff"],
            visualBrief: "Vertical video direction.",
            channel: "instagram",
            format: "post",
          });
        },
      },
    }),
    /content_generation_failed/,
  );
});

const VERIFIED_TREND_CONTEXT = {
  topic: "Dubai Fitness Challenge",
  market: { country: "AE", language: "en" },
  eventWindow: { start: "2026-11-01", end: "2026-11-30" },
  facts: [{
    statement: "Dubai Fitness Challenge runs during November 2026.",
    sources: ["Dubai Fitness Challenge official website"],
  }],
  observedAt: "2026-09-10T00:00:00.000Z",
  confidence: "low",
  caveats: ["Do not imply an official partnership."],
};

test("real runOwnerWorkflow entry carries verified trend evidence into grounded MARA drafts", async () => {
  const previous = process.env.VOOM_TREND_CONTEXT_ENABLED;
  process.env.VOOM_TREND_CONTEXT_ENABLED = "true";
  try {
    const captured = [];
    let trendReads = 0;
    const provider = {
      async structured(request) {
        const payload = JSON.parse(request.messages[1].content);
        captured.push(payload);
        return request.parse({
          concept: `Dubai Fitness Challenge ${payload.assignedSocialSlot.label}`,
          hook: "Make the Dubai Fitness Challenge fit your daily routine.",
          caption: "Palm Fuel can support your routine during Dubai Fitness Challenge with its existing smoothie menu.",
          cta: "Build your Dubai Fitness Challenge routine.",
          hashtags: ["DubaiFitnessChallenge"],
          description: payload.assignedSocialSlot.channel === "youtube"
            ? "A practical Dubai Fitness Challenge routine using Palm Fuel's existing menu."
            : "",
          script: payload.assignedSocialSlot.channel === "instagram" && payload.assignedSocialSlot.format === "post"
            ? []
            : ["Name Dubai Fitness Challenge", "Show the existing menu", "Connect it to a daily routine", "Close without unsupported claims"],
          visualBrief: "Show an active Dubai routine and Palm Fuel's existing smoothies without event logos or partnership claims.",
        });
      },
    };
    const admin = createMemoryAdmin(adminSeed({
      preferredChannels: ["Instagram"],
      businessOverrides: {
        brand_name: "Palm Fuel Smoothie Bar",
        brand_description: "Smoothies for active routines in Dubai.",
        industry: "Food and beverage",
      },
    }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER,
      now: NOW,
      trigger: "replenish",
      stage: "planning_only",
      planningDeps: {
        provider,
        performanceContext: async () => null,
        trendContext: async () => { trendReads += 1; return VERIFIED_TREND_CONTEXT; },
      },
    });
    assert.equal(result.created, 7);
    assert.equal(trendReads, 1, "verified context is loaded at most once per workflow run");
    assert.equal(captured.length, 7);
    assert.ok(captured.every((payload) => payload.trendOpportunity?.topic === "Dubai Fitness Challenge"));
    assert.ok(admin.tables.get("mara_drafts").every((draft) => /Dubai Fitness Challenge/i.test(`${draft.title} ${draft.content}`)));
  } finally {
    if (previous === undefined) delete process.env.VOOM_TREND_CONTEXT_ENABLED;
    else process.env.VOOM_TREND_CONTEXT_ENABLED = previous;
  }
});

test("automatic event discovery can feed a reviewed context through Replenish into grounded Reel/video ideas", async () => {
  const previous = process.env.VOOM_TREND_CONTEXT_ENABLED;
  process.env.VOOM_TREND_CONTEXT_ENABLED = "true";
  try {
    const sourcePayload = { results: { bindings: [{
      event: { value: "https://www.wikidata.org/entity/Q999999" },
      label: { value: "Dubai Fitness Challenge" },
      starts: { value: "2026-11-01T00:00:00Z|11" },
      ends: { value: "2026-11-30T00:00:00Z|11" },
      website: { value: "https://www.dubaifitnesschallenge.com/" },
    }] } };
    const collected = await discovery.runWikidataEventDiscovery({
      now: NOW,
      fetch: async () => ({ ok: true, async json() { return sourcePayload; } }),
      client: { async rpc() { return { data: {
        status: "stored", observation_id: "22222222-2222-4222-8222-222222222222", revision: 1,
        item_key: null, topic_key: "topic|web|AE|en|topic|dubai fitness challenge",
        trend_key: "topic|web|AE|en|topic|dubai fitness challenge",
        expires_at: "2026-09-26T05:00:00Z", delete_after: "2026-10-12T05:00:00Z",
      }, error: null }; } },
    });
    assert.equal(collected.status, "completed");
    assert.equal(collected.storage.counts.stored, 1);
    const candidate = collected.reviewCandidates[0];
    const reviewedContext = {
      topic: candidate.observation.subject.text,
      market: candidate.observation.market,
      eventWindow: candidate.eventWindow,
      facts: candidate.facts.map((fact) => ({ statement: fact.statement, sources: ["Wikidata (CC0)"] })),
      observedAt: candidate.observation.retrievedAt,
      confidence: "low",
      caveats: ["Community-maintained event record; verify details before publishing.", "Do not imply an official partnership."],
    };
    const captured = [];
    const admin = createMemoryAdmin(adminSeed({
      preferredChannels: ["Instagram", "TikTok", "YouTube"],
      businessOverrides: { brand_name: "Palm Fuel Smoothie Bar", brand_description: "Smoothies for active routines in Dubai.", industry: "Food and beverage" },
    }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER, now: NOW, trigger: "replenish", stage: "planning_only",
      planningDeps: {
        performanceContext: async () => null,
        trendContext: async () => reviewedContext,
        provider: { async structured(request) {
          const payload = JSON.parse(request.messages[1].content);
          captured.push(payload);
          const video = payload.assignedSocialSlot.format !== "post";
          return request.parse({
            concept: `Dubai Fitness Challenge ${video ? "vertical video" : "post"}`,
            hook: "Build a Dubai Fitness Challenge routine that feels achievable.",
            caption: "Use Palm Fuel's existing smoothie menu as part of your Dubai Fitness Challenge routine.",
            cta: "Plan your Dubai Fitness Challenge routine.", hashtags: ["DubaiFitnessChallenge"],
            description: payload.assignedSocialSlot.channel === "youtube" ? "A practical Dubai Fitness Challenge routine with Palm Fuel's existing menu." : "",
            script: video ? ["Name Dubai Fitness Challenge", "Show the existing menu", "Offer a practical routine", "Avoid partnership claims"] : [],
            visualBrief: "Vertical active-routine visuals with Palm Fuel products; no event logos or partnership claims.",
          });
        } },
      },
    });
    assert.equal(result.created, 7);
    const videos = captured.filter((payload) => payload.assignedSocialSlot.format !== "post");
    assert.ok(videos.length > 0, "the real planner requested Reel/video ideas");
    assert.ok(videos.every((payload) => payload.trendOpportunity.topic === "Dubai Fitness Challenge"));
    assert.ok(admin.tables.get("mara_drafts").every((draft) => /Dubai Fitness Challenge/i.test(`${draft.title} ${draft.content}`)));
  } finally {
    if (previous === undefined) delete process.env.VOOM_TREND_CONTEXT_ENABLED;
    else process.env.VOOM_TREND_CONTEXT_ENABLED = previous;
  }
});

test("trend-aware generation rejects generic output and unsupported claims", async () => {
  const input = {
    business: {
      brand_name: "Palm Fuel Smoothie Bar",
      brand_description: "Smoothies for active routines in Dubai.",
      industry: "Food and beverage",
      target_customer: ["Active Dubai residents"],
    },
    goal: "Grow awareness",
    cadence: "daily",
    timeZone: TZ,
    slot: { date: DATE, slotKey: `${DATE}|instagram_post`, index: 0, channel: "instagram", format: "post", contentType: "post", publishAt: timezone.localToUtcIso(DATE, 18 * 60 + 30, TZ) },
    plannedConcepts: [],
    performance: null,
    trendOpportunity: VERIFIED_TREND_CONTEXT,
  };
  const result = (caption) => ({
    concept: "Active routine", hook: "", caption, cta: "Visit Palm Fuel.", hashtags: [],
    description: "", script: [], visualBrief: "Show an existing smoothie beside running shoes.",
  });
  await assert.rejects(
    () => service.generateWorkflowPlannedContent({ ...input, provider: { async structured(request) { return request.parse(result("Fuel your active routine with Palm Fuel.")); } } }),
    /content_generation_failed/,
  );
  await assert.rejects(
    () => service.generateWorkflowPlannedContent({ ...input, provider: { async structured(request) { return request.parse(result("Dubai Fitness Challenge participants get 20% off.")); } } }),
    /content_generation_failed/,
  );
});

test("feature flag off leaves the existing workflow payload and loader behavior unchanged", async () => {
  const previous = process.env.VOOM_TREND_CONTEXT_ENABLED;
  delete process.env.VOOM_TREND_CONTEXT_ENABLED;
  try {
    const captured = [];
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["Instagram"] }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER,
      now: NOW,
      trigger: "replenish",
      stage: "planning_only",
      planningDeps: {
        provider: structuredProvider(captured),
        performanceContext: async () => null,
        trendContext: async () => { throw new Error("flag-off loader must not run"); },
      },
    });
    assert.equal(result.created, 7);
    assert.ok(captured.every((payload) => !("trendOpportunity" in payload)));
  } finally {
    if (previous !== undefined) process.env.VOOM_TREND_CONTEXT_ENABLED = previous;
  }
});

/* ── Universal Trend Intelligence: automatic per-business matching in Replenish ── */

const MATCHED_IDEAS = [
  {
    topic: "Pumpkin spice",
    market: { country: "ZZ", language: "en" },
    eventWindow: null,
    facts: [{ statement: "\"Pumpkin spice\" was among the most-viewed English Wikipedia articles on 2026-09-11, with 51234 views, according to Wikimedia pageview statistics.", sources: ["Wikimedia pageviews"] }],
    observedAt: "2026-09-12T03:00:00.000Z",
    confidence: "medium",
    caveats: ["Do not imply that the business is an official partner, sponsor or participant of Pumpkin spice.", "Worldwide signal; it is not specific to the business's location."],
  },
  {
    topic: "Summer Bank Holiday",
    market: { country: "GB", language: "en" },
    eventWindow: { start: "2026-09-28", end: "2026-09-28" },
    facts: [{ statement: "Summer Bank Holiday is a public holiday in the United Kingdom on 2026-09-28, according to the Nager.Date public holiday calendar.", sources: ["Nager.Date"] }],
    observedAt: "2026-09-12T03:00:00.000Z",
    confidence: "high",
    caveats: ["Treat this as a calendar moment only; do not claim any official link to the holiday."],
  },
];

/** Names the trend topic when one is supplied (no digits, so no unsupported numbers), otherwise generic evergreen copy. */
function trendAwareProvider(captured = []) {
  return {
    async structured(request) {
      const payload = JSON.parse(request.messages[1].content);
      captured.push(payload);
      const topic = payload.trendOpportunity?.topic ?? null;
      const video = !(payload.assignedSocialSlot.channel === "instagram" && payload.assignedSocialSlot.format === "post");
      return request.parse({
        concept: topic ? `${topic} at our cafe` : "Behind the counter at our cafe",
        hook: topic ? `Make ${topic} part of your week.` : "A simple idea for your week.",
        caption: topic ? `Our cafe has a simple way to enjoy ${topic}.` : "A simple everyday idea from our cafe.",
        cta: "Visit us.",
        hashtags: ["cafe"],
        description: payload.assignedSocialSlot.channel === "youtube" ? "A short, practical idea from our cafe team." : "",
        script: video ? ["Open on the counter", "Show the idea", "Explain why it works", "Invite viewers in"] : [],
        visualBrief: "Warm cafe visuals with the team; no third-party logos.",
      });
    },
  };
}

async function withTrendFlag(value, run) {
  const previous = process.env.VOOM_TREND_CONTEXT_ENABLED;
  if (value === undefined) delete process.env.VOOM_TREND_CONTEXT_ENABLED;
  else process.env.VOOM_TREND_CONTEXT_ENABLED = value;
  try {
    return await run();
  } finally {
    if (previous === undefined) delete process.env.VOOM_TREND_CONTEXT_ENABLED;
    else process.env.VOOM_TREND_CONTEXT_ENABLED = previous;
  }
}

const basisOf = (draft) => draft.content_meta?.idea_basis ?? draft.content_meta?.ideaBasis ?? null;

test("Replenish without a reviewed context uses at most two automatically matched trends and labels every idea", async () => {
  await withTrendFlag("true", async () => {
    const captured = [];
    let ideaReads = 0;
    const admin = createMemoryAdmin(adminSeed({
      preferredChannels: ["Instagram", "TikTok", "YouTube"],
      businessOverrides: { brand_name: "Copper Kettle Cafe", brand_description: "Neighbourhood cafe and bakery in London.", industry: "Restaurant" },
    }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER, now: NOW, trigger: "replenish", stage: "planning_only",
      planningDeps: {
        provider: trendAwareProvider(captured),
        performanceContext: async () => null,
        trendContext: async () => null,
        trendIdeas: async (_db, business) => {
          ideaReads += 1;
          assert.equal(business.brand_name, "Copper Kettle Cafe", "matching sees the business's own profile");
          return MATCHED_IDEAS;
        },
      },
    });
    assert.equal(result.created, 7);
    assert.equal(result.failures.length, 0);
    assert.equal(ideaReads, 1, "matching runs at most once per Replenish run");
    const withTrend = captured.filter((payload) => payload.trendOpportunity);
    assert.deepEqual(withTrend.map((payload) => payload.trendOpportunity.topic), ["Pumpkin spice", "Summer Bank Holiday"]);
    assert.ok(captured.slice(2).every((payload) => !("trendOpportunity" in payload)), "remaining slots are evergreen");
    const drafts = admin.tables.get("mara_drafts");
    const bases = drafts.map(basisOf);
    assert.ok(bases.every(Boolean), "every planned idea records its basis");
    assert.deepEqual(bases.filter((b) => b.kind === "verified_trend").map((b) => b.topic).sort(), ["Pumpkin spice", "Summer Bank Holiday"]);
    assert.equal(bases.filter((b) => b.kind === "evergreen").length, 5);
    const trendDraft = drafts.find((draft) => basisOf(draft).topic === "Summer Bank Holiday");
    assert.deepEqual(basisOf(trendDraft).sources, ["Nager.Date"]);
  });
});

test("a matched trend idea that cannot stay within its evidence falls back to an evergreen idea, not a failure", async () => {
  await withTrendFlag("true", async () => {
    const captured = [];
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["Instagram"] }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER, now: NOW, trigger: "replenish", stage: "planning_only",
      planningDeps: {
        // Generic copy never names the topic, so the grounding check rejects it.
        provider: structuredProvider(captured),
        performanceContext: async () => null,
        trendContext: async () => null,
        trendIdeas: async () => MATCHED_IDEAS,
      },
    });
    assert.equal(result.created, 7);
    assert.equal(result.failures.length, 0);
    assert.ok(admin.tables.get("mara_drafts").every((draft) => basisOf(draft)?.kind === "evergreen"));
    assert.equal(captured.filter((payload) => payload.trendOpportunity).length, 2, "each matched idea was attempted once");
  });
});

test("with no relevant evidence every Replenish idea is evergreen and clearly labelled", async () => {
  await withTrendFlag("true", async () => {
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["Instagram", "TikTok"] }));
    const captured = [];
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER, now: NOW, trigger: "replenish", stage: "planning_only",
      // No injected loaders: the production loaders read the (unavailable) RPC and fail closed.
      planningDeps: { provider: structuredProvider(captured), performanceContext: async () => null },
    });
    assert.equal(result.created, 7);
    assert.ok(captured.every((payload) => !("trendOpportunity" in payload)));
    assert.ok(admin.tables.get("mara_drafts").every((draft) => basisOf(draft)?.kind === "evergreen"));
  });
});

test("with the flag off no idea basis is recorded and no matcher runs", async () => {
  await withTrendFlag(undefined, async () => {
    const admin = createMemoryAdmin(adminSeed({ preferredChannels: ["Instagram", "TikTok"] }));
    const result = await service.runOwnerWorkflow(admin, {
      ownerId: OWNER, now: NOW, trigger: "replenish", stage: "planning_only",
      planningDeps: {
        provider: structuredProvider(),
        performanceContext: async () => null,
        trendIdeas: async () => { throw new Error("flag-off matcher must not run"); },
      },
    });
    assert.equal(result.created, 7);
    assert.ok(admin.tables.get("mara_drafts").every((draft) => basisOf(draft) === null));
  });
});
