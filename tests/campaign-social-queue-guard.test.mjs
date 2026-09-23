/**
 * Campaign content edits/regeneration must withdraw social-video queue work
 * before the campaign RPC changes the action, linked draft, Calendar or review.
 * All providers and AI are local deterministic fakes; no external calls occur.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const campaigns = await import("../lib/campaign/server.ts");
const socialDrafts = await import("../lib/social/server-drafts.ts");

const OWNER = "campaign-queue-guard-owner";
const CAMPAIGN = "campaign-queue-guard-campaign";
const ACTION = "campaign-queue-guard-action";
const DRAFT = "campaign-queue-guard-draft";
const NOW = new Date();
const SCHEDULED_AT = new Date(NOW.getTime() + 7 * 86_400_000).toISOString();
const PUBLISH_QUEUE = { tiktok: "tiktok_publish_queue", youtube: "youtube_publish_queue" };
const CANCEL_RPC = { tiktok: "cancel_tiktok_publish_queue_item", youtube: "cancel_youtube_publish_queue_item" };
const ENQUEUE_RPC = { tiktok: "upsert_tiktok_publish_queue_item", youtube: "upsert_youtube_publish_queue_item" };

function channelKind(channel) {
  return channel === "tiktok" ? "tiktok_video" : "youtube_video";
}

function queueStatusForOwner(channel) {
  return channel === "tiktok" ? "posting" : "uploading";
}

function createCampaignRows(channel) {
  const kind = channelKind(channel);
  const queueTable = PUBLISH_QUEUE[channel];
  const calendarId = `calendar-${channel}`;
  const action = {
    id: ACTION,
    owner_user_id: OWNER,
    campaign_id: CAMPAIGN,
    slot: 0,
    channel: kind,
    stage: "awareness",
    title: "Current campaign concept",
    purpose: "Current purpose",
    scheduled_for: SCHEDULED_AT,
    status: "approved",
    email_campaign_id: null,
    draft_id: DRAFT,
    safety_blockers: [],
    mara_content: {
      format: "video",
      concept: "Current campaign concept",
      ...(channel === "youtube" ? { description: "Current YouTube description." } : {}),
      script: ["Current hook", "Current point", "Current close"],
    },
    content_source: "mara",
    approved_at: NOW.toISOString(),
    review_marker: "reviewed-current-copy",
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const draft = {
    id: DRAFT,
    owner_user_id: OWNER,
    conversation_id: "studio-conversation",
    kind,
    channel: channel === "tiktok" ? "TikTok · 9:16" : "YouTube Video · 16:9",
    title: "Current campaign concept",
    content: "Current caption",
    proposed_publish_at: SCHEDULED_AT,
    status: "approved",
    social_channel: channel,
    social_format: "video",
    content_meta: channel === "tiktok"
      ? { concept: "Current campaign concept", tiktokPrivacy: "SELF_ONLY", script: ["Current hook", "Current point", "Current close"] }
      : { concept: "Current campaign concept", description: "Current YouTube description.", privacy: "unlisted", madeForKids: false, script: ["Current hook", "Current point", "Current close"] },
    source_plan_id: null,
    source_plan_item_key: null,
    provider_ref: null,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  };
  const queue = channel === "tiktok"
    ? {
        id: `queue-${channel}`,
        owner_user_id: OWNER,
        draft_id: DRAFT,
        calendar_item_id: calendarId,
        title: "Current caption",
        privacy_level: "SELF_ONLY",
        scheduled_at: SCHEDULED_AT,
        status: "scheduled",
        failure_message: null,
      }
    : {
        id: `queue-${channel}`,
        owner_user_id: OWNER,
        draft_id: DRAFT,
        calendar_item_id: calendarId,
        youtube_format: "video",
        title: "Current campaign concept",
        description: "Current YouTube description.",
        privacy_status: "unlisted",
        made_for_kids: false,
        scheduled_at: SCHEDULED_AT,
        status: "scheduled",
        failure_message: null,
      };
  const calendar = {
    id: calendarId,
    owner_user_id: OWNER,
    source_draft_id: DRAFT,
    title: "Current campaign concept",
    content: "Current caption",
    channel: channel === "tiktok" ? "TikTok" : "YouTube",
    social_channel: channel,
    social_format: "video",
    publish_at: SCHEDULED_AT,
    status: "scheduled",
  };
  const business = {
    id: "business-queue-guard",
    owner_user_id: OWNER,
    brand_name: "Queue Guard Studio",
    brand_description: "A test business.",
    industry: "Services",
    target_customer: ["Local teams"],
    main_goal: "Build awareness",
    brand_personality: ["Clear"],
    preferred_channels: [channel],
    content_frequency: "daily",
    automation_level: "manual",
    timezone: "Asia/Dubai",
    plan: "pro",
  };
  return {
    voom_campaign_actions: [action],
    voom_campaigns: [{
      id: CAMPAIGN,
      owner_user_id: OWNER,
      kind: "self_campaign",
      is_automated: true,
      name: "Queue guard campaign",
      goal: "announce",
      start_at: NOW.toISOString(),
      end_at: new Date(NOW.getTime() + 14 * 86_400_000).toISOString(),
      offer_details: "A useful offer.",
      audience: "Local teams",
      campaign_notes: "Stay accurate.",
      generated_summary: "One coordinated test action.",
      channels: [channel],
      status: "active",
    }],
    mara_drafts: [draft],
    content_calendar_items: [calendar],
    [queueTable]: [queue],
    post_draft_assets: [{
      id: `asset-${channel}`,
      owner_user_id: OWNER,
      draft_id: DRAFT,
      status: "uploaded",
      display_name: "test-video.mp4",
      mime_type: "video/mp4",
    }],
    youtube_connections: [{
      owner_user_id: OWNER,
      default_privacy: "unlisted",
      default_made_for_kids: false,
    }],
    tiktok_connections: [{ owner_user_id: OWNER, default_privacy: "SELF_ONLY" }],
    businesses: [business],
    profiles: [{ user_id: OWNER, display_name: "Queue Guard Studio" }],
    instagram_publish_queue: [],
    campaign_sends: [],
    voom_campaign_generations: [],
  };
}

function makeAdmin(channel, options = {}) {
  const state = createCampaignRows(channel);
  const operations = [];
  let cancelMode = options.cancelMode ?? "success";
  let sequence = 0;

  class Query {
    constructor(table) {
      this.table = table;
      this.filters = [];
      this.orderings = [];
      this.limitCount = null;
      this.patch = null;
      this.deleting = false;
      this.inserts = null;
      this.upsertOptions = null;
    }
    select() { return this; }
    eq(column, value) { this.filters.push((row) => row[column] === value); return this; }
    neq(column, value) { this.filters.push((row) => row[column] !== value); return this; }
    in(column, values) {
      const accepted = new Set(values ?? []);
      this.filters.push((row) => accepted.has(row[column]));
      return this;
    }
    gte(column, value) { this.filters.push((row) => String(row[column] ?? "") >= String(value)); return this; }
    lte(column, value) { this.filters.push((row) => String(row[column] ?? "") <= String(value)); return this; }
    order(column, options = {}) {
      this.orderings.push({ column, ascending: options.ascending !== false });
      return this;
    }
    limit(value) { this.limitCount = value; return this; }
    update(value) { this.patch = value; return this; }
    delete() { this.deleting = true; return this; }
    insert(value) { this.inserts = Array.isArray(value) ? value : [value]; return this; }
    upsert(value, options = {}) {
      this.inserts = Array.isArray(value) ? value : [value];
      this.upsertOptions = options;
      return this;
    }
    tableRows() {
      if (!state[this.table]) state[this.table] = [];
      return state[this.table];
    }
    selectedRows() {
      let rows = this.tableRows().filter((row) => this.filters.every((filter) => filter(row)));
      for (const { column, ascending } of this.orderings) {
        rows = [...rows].sort((a, b) => {
          const left = String(a[column] ?? "");
          const right = String(b[column] ?? "");
          return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
        });
      }
      return this.limitCount === null ? rows : rows.slice(0, this.limitCount);
    }
    execute() {
      const rows = this.tableRows();
      if (this.inserts) {
        const output = [];
        for (const incoming of this.inserts) {
          const keys = this.upsertOptions?.onConflict?.split(",").map((key) => key.trim()) ?? [];
          const existing = keys.length
            ? rows.find((row) => keys.every((key) => row[key] === incoming[key]))
            : null;
          if (existing && this.upsertOptions?.ignoreDuplicates) continue;
          if (existing) Object.assign(existing, incoming);
          else {
            const row = { id: `${this.table}-${++sequence}`, ...incoming };
            rows.push(row);
            output.push(row);
            continue;
          }
          output.push(existing);
        }
        return { data: output, error: null };
      }
      const selected = this.selectedRows();
      if (this.patch) {
        for (const row of selected) Object.assign(row, this.patch);
        return { data: selected, error: null };
      }
      if (this.deleting) {
        for (const row of selected) rows.splice(rows.indexOf(row), 1);
        return { data: selected, error: null };
      }
      return { data: selected, error: null };
    }
    then(resolve, reject) { return Promise.resolve(this.execute()).then(resolve, reject); }
    async maybeSingle() {
      const result = this.execute();
      return { data: result.data[0] ?? null, error: result.error };
    }
    async single() {
      const result = this.execute();
      return { data: result.data[0] ?? null, error: result.error };
    }
  }

  const admin = {
    from(table) { return new Query(table); },
    rpc(name, args = {}) {
      if (name === CANCEL_RPC[channel]) {
        operations.push(`cancel:${channel}`);
        const row = state[PUBLISH_QUEUE[channel]].find((item) => item.draft_id === args.p_draft_id);
        if (cancelMode === "failure") return { data: null, error: { message: "synthetic cancel database failure" } };
        if (cancelMode === "race") {
          if (row) row.status = queueStatusForOwner(channel);
          return { data: false, error: null };
        }
        if (cancelMode === "ambiguous") return { data: false, error: null };
        if (!row) return { data: false, error: null };
        row.status = "cancelled";
        operations.push(`cancelled:${channel}`);
        return { data: true, error: null };
      }
      if (name === "update_campaign_action_content") {
        return {
          single: async () => {
            operations.push("campaign-content-mutation");
            const action = state.voom_campaign_actions.find((row) => row.id === args.p_action_id);
            if (!action) return { data: null, error: { message: "campaign_action_not_found" } };
            const patch = args.p_patch ?? {};
            if (args.p_idempotency_key && state.voom_campaign_generations.some((row) => row.idempotency_key === args.p_idempotency_key)) {
              return { data: structuredClone(action), error: null };
            }
            if (patch.title) action.title = patch.title;
            if (patch.purpose) action.purpose = patch.purpose;
            if (patch.scheduledFor) action.scheduled_for = patch.scheduledFor;
            if (patch.contentSource) action.content_source = patch.contentSource;
            if (Array.isArray(patch.safetyBlockers)) action.safety_blockers = patch.safetyBlockers;
            action.mara_content = { ...(action.mara_content ?? {}), ...(patch.content ?? {}) };
            if (args.p_reset_review) action.status = "needs_approval";

            const draft = state.mara_drafts.find((row) => row.id === action.draft_id);
            if (draft) {
              if (patch.title) draft.title = patch.title;
              if (patch.caption) draft.content = patch.caption;
              if (patch.scheduledFor) draft.proposed_publish_at = patch.scheduledFor;
              if (args.p_reset_review) draft.status = "draft";
              draft.content_meta = { ...(draft.content_meta ?? {}), ...(patch.content ?? {}) };
            }
            if (args.p_reset_review) {
              state.content_calendar_items = state.content_calendar_items.filter((row) => row.source_draft_id !== action.draft_id);
            } else {
              const calendar = state.content_calendar_items.find((row) => row.source_draft_id === action.draft_id);
              if (calendar) {
                if (patch.title) calendar.title = patch.title;
                if (patch.caption) calendar.content = patch.caption;
                if (patch.scheduledFor) calendar.publish_at = patch.scheduledFor;
              }
            }
            if (args.p_idempotency_key) {
              state.voom_campaign_generations.push({ idempotency_key: args.p_idempotency_key, action_id: action.id });
            }
            return { data: structuredClone(action), error: null };
          },
        };
      }
      if (name === ENQUEUE_RPC[channel]) {
        operations.push(`queue-upsert:${channel}`);
        const queue = state[PUBLISH_QUEUE[channel]];
        let row = queue.find((item) => item.owner_user_id === args.p_owner_user_id && item.draft_id === args.p_draft_id);
        if (!row) {
          row = { id: `queue-${channel}-${++sequence}`, owner_user_id: args.p_owner_user_id, draft_id: args.p_draft_id };
          queue.push(row);
        }
        Object.assign(row, {
          status: args.p_waiting_for_media ? "waiting_for_media" : "scheduled",
          scheduled_at: args.p_scheduled_at,
          calendar_item_id: args.p_calendar_item_id,
          ...(channel === "tiktok" ? {
            title: args.p_title,
            privacy_level: args.p_privacy_level,
          } : {
            youtube_format: args.p_youtube_format,
            title: args.p_title,
            description: args.p_description,
            privacy_status: args.p_privacy_status,
            made_for_kids: args.p_made_for_kids,
          }),
        });
        return { data: structuredClone(row), error: null };
      }
      return { data: null, error: { message: `unexpected test RPC ${name}` } };
    },
  };
  return {
    admin,
    state,
    operations,
    setCancelMode(mode) { cancelMode = mode; },
  };
}

function relevantSnapshot(state, channel) {
  return JSON.stringify({
    action: state.voom_campaign_actions,
    draft: state.mara_drafts,
    calendar: state.content_calendar_items,
    queue: state[PUBLISH_QUEUE[channel]],
  });
}

function editInput(channel) {
  return channel === "tiktok"
    ? { concept: "Updated TikTok concept", caption: "Updated TikTok caption" }
    : { concept: "Updated YouTube concept", caption: "Updated YouTube caption", description: "Updated YouTube description." };
}

async function editCampaign(fixture, channel) {
  return campaigns.editCampaignActionContent(
    fixture.admin,
    OWNER,
    CAMPAIGN,
    ACTION,
    editInput(channel),
  );
}

for (const channel of ["tiktok", "youtube"]) {
  test(`scheduled ${channel} campaign edit cancellation failure leaves every visible record byte-for-byte unchanged`, async () => {
    const fixture = makeAdmin(channel, { cancelMode: "failure" });
    const before = relevantSnapshot(fixture.state, channel);
    const result = await editCampaign(fixture, channel);

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /No campaign, draft, Calendar or review changes were made/);
    assert.equal(relevantSnapshot(fixture.state, channel), before);
    assert.deepEqual(fixture.operations, [`cancel:${channel}`], "the campaign mutation RPC was never reached");
  });

  test(`scheduled ${channel} campaign edit fails closed when cancellation races into provider ownership`, async () => {
    const fixture = makeAdmin(channel, { cancelMode: "race" });
    const before = JSON.parse(relevantSnapshot(fixture.state, channel));
    const result = await editCampaign(fixture, channel);

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /provider already owns this video/);
    assert.deepEqual(fixture.state.voom_campaign_actions, before.action);
    assert.deepEqual(fixture.state.mara_drafts, before.draft);
    assert.deepEqual(fixture.state.content_calendar_items, before.calendar);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]].length, 1);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].id, before.queue[0].id);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].status, queueStatusForOwner(channel));
    assert.deepEqual(fixture.operations, [`cancel:${channel}`], "the campaign mutation RPC was never reached");
  });

  test(`scheduled ${channel} campaign edit rejects an ambiguous false cancellation without mutating records`, async () => {
    const fixture = makeAdmin(channel, { cancelMode: "ambiguous" });
    const before = relevantSnapshot(fixture.state, channel);
    const result = await editCampaign(fixture, channel);

    assert.equal(result.ok, false);
    assert.match(result.blockers[0], /No campaign, draft, Calendar or review changes were made/);
    assert.equal(relevantSnapshot(fixture.state, channel), before);
    assert.deepEqual(fixture.operations, [`cancel:${channel}`], "an unconfirmed queue row blocks the campaign RPC");
  });

  test(`successful ${channel} cancellation precedes content mutation and resyncs one replacement queue row`, async () => {
    const fixture = makeAdmin(channel);
    const oldQueueId = fixture.state[PUBLISH_QUEUE[channel]][0].id;
    const result = await editCampaign(fixture, channel);

    assert.equal(result.ok, true);
    const cancelIndex = fixture.operations.indexOf(`cancelled:${channel}`);
    const mutationIndex = fixture.operations.indexOf("campaign-content-mutation");
    const replacementIndex = fixture.operations.indexOf(`queue-upsert:${channel}`);
    assert.ok(cancelIndex >= 0 && cancelIndex < mutationIndex, "durable cancellation was confirmed before the campaign RPC");
    assert.ok(mutationIndex < replacementIndex, "the replacement queue is written only after content mutation");
    assert.equal(fixture.state.voom_campaign_actions[0].title, `Updated ${channel === "tiktok" ? "TikTok" : "YouTube"} concept`);
    assert.equal(fixture.state.mara_drafts[0].content, `Updated ${channel === "tiktok" ? "TikTok" : "YouTube"} caption`);
    assert.equal(fixture.state.content_calendar_items[0].content, fixture.state.mara_drafts[0].content);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]].length, 1);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].id, oldQueueId, "the unique owner+draft queue row is reused");
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].status, "scheduled");
    if (channel === "tiktok") assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].title, "Updated TikTok caption");
    else {
      assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].title, "Updated YouTube concept");
      assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].description, "Updated YouTube description.");
    }

    const retry = await editCampaign(fixture, channel);
    assert.equal(retry.ok, true);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]].length, 1, "retry does not create a second durable queue row");
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].id, oldQueueId);
  });
}

test("retry after failed cancellation succeeds safely and reuses the sole provider queue row", async () => {
  for (const channel of ["tiktok", "youtube"]) {
    const fixture = makeAdmin(channel, { cancelMode: "failure" });
    const before = relevantSnapshot(fixture.state, channel);
    const failed = await editCampaign(fixture, channel);
    assert.equal(failed.ok, false);
    assert.equal(relevantSnapshot(fixture.state, channel), before);

    fixture.setCancelMode("success");
    const retried = await editCampaign(fixture, channel);
    assert.equal(retried.ok, true);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]].length, 1);
    assert.equal(fixture.state[PUBLISH_QUEUE[channel]][0].status, "scheduled");
    assert.ok(fixture.operations.indexOf(`cancelled:${channel}`) < fixture.operations.indexOf("campaign-content-mutation"));
  }
});

test("a regeneration uses the same pre-mutation gate, then later approval syncs one replacement queue row", async () => {
  const fixture = makeAdmin("youtube");
  const newContent = {
    strategy: {
      objective: "Build awareness with a practical video.",
      coreMessage: "Show one useful improvement.",
      audienceAngle: "Make the benefit concrete for local teams.",
      narrative: "Introduce the problem, then show the payoff.",
      ctaStrategy: "Invite viewers to learn more.",
      sequenceRationale: "A YouTube video provides the deeper explanation.",
    },
    actions: [{
      slot: 0,
      channel: "youtube_video",
      title: "MARA replacement title",
      email: null,
      instagram: null,
      tiktok: null,
      youtube: {
        format: "video",
        purpose: "Explain the useful improvement.",
        concept: "MARA replacement concept",
        hook: "Start with the visible result.",
        title: "MARA replacement title",
        description: "A clear replacement description with the outcome and useful context.",
        caption: "MARA replacement caption with a concise next step.",
        cta: "Learn more",
        visualDirection: "Use a clear screen demonstration.",
        script: ["Hook", "Show the problem", "Demonstrate the improvement", "Close with a next step"],
        proposedSendAt: null,
      },
    }],
    performanceNote: null,
  };
  const result = await campaigns.regenerateCampaignAction(
    fixture.admin,
    fixture.admin,
    OWNER,
    CAMPAIGN,
    ACTION,
    {
      idempotencyKey: "campaign-regenerate-queue-guard-1",
      now: NOW,
      deps: { ai: { async structured(request) { return request.parse(newContent); } } },
    },
  );

  assert.equal(result.ok, true);
  const cancellationIndex = fixture.operations.indexOf("cancelled:youtube");
  const mutationIndex = fixture.operations.indexOf("campaign-content-mutation");
  assert.ok(cancellationIndex >= 0 && cancellationIndex < mutationIndex);
  assert.equal(fixture.state.voom_campaign_actions[0].status, "needs_approval");
  assert.equal(fixture.state.mara_drafts[0].status, "draft");
  assert.equal(fixture.state.content_calendar_items.length, 0, "regeneration removes the old Calendar mirror after cancellation");
  assert.equal(fixture.state.youtube_publish_queue[0].status, "cancelled");
  assert.equal(fixture.state.youtube_publish_queue.length, 1);

  const approved = await socialDrafts.updateSocialDraft(fixture.admin, OWNER, DRAFT, { decision: "approved" });
  assert.equal(approved.queueStatus, "scheduled");
  assert.equal(fixture.state.youtube_publish_queue.length, 1);
  assert.equal(fixture.state.youtube_publish_queue[0].title, "MARA replacement title");
  assert.equal(fixture.state.youtube_publish_queue[0].description, "A clear replacement description with the outcome and useful context.");

  const retriedApproval = await socialDrafts.updateSocialDraft(fixture.admin, OWNER, DRAFT, { decision: "approved" });
  assert.equal(retriedApproval.queueStatus, "scheduled");
  assert.equal(fixture.state.youtube_publish_queue.length, 1, "approval retry reuses the queue row");
});

test("Instagram campaign edits keep their existing RPC path and do not call TikTok/YouTube cancellation", async () => {
  const fixture = makeAdmin("tiktok");
  const igAction = {
    ...fixture.state.voom_campaign_actions[0],
    channel: "instagram_post",
    mara_content: { format: "post", concept: "Instagram concept" },
  };
  const igDraft = {
    ...fixture.state.mara_drafts[0],
    kind: "instagram_post",
    channel: "Instagram Post · 4:5",
    social_channel: "instagram",
    social_format: "post",
    title: "Instagram concept",
  };
  const igQueue = {
    id: "instagram-queue",
    owner_user_id: OWNER,
    draft_id: DRAFT,
    status: "scheduled",
  };
  fixture.state.voom_campaign_actions[0] = igAction;
  fixture.state.mara_drafts[0] = igDraft;
  fixture.state.instagram_publish_queue.push(igQueue);

  const result = await campaigns.editCampaignActionContent(
    fixture.admin,
    OWNER,
    CAMPAIGN,
    ACTION,
    { concept: "Updated Instagram concept", caption: "Updated Instagram caption" },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(fixture.operations, ["campaign-content-mutation"]);
  assert.equal(fixture.state.instagram_publish_queue[0].status, "scheduled");
  assert.equal(fixture.state.voom_campaign_actions[0].title, "Updated Instagram concept");
});
