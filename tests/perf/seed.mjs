/**
 * Deterministic seed dataset for the navigation performance harness.
 *
 * Models a realistic ACTIVE account so every expensive branch of the real
 * navigation data path executes: a rolling multi-channel plan with media on
 * every Instagram item (the signed-URL path), durable TikTok/YouTube queue
 * rows, pending approvals, reel-production state, an automated campaign with
 * horizon actions, credits, stored performance snapshots, contacts and a
 * lifecycle email flow. A second owner exists to prove isolation.
 */

const DAY_MS = 86_400_000;

export const OWNER_A = "11111111-1111-4111-8111-111111111111";
export const OWNER_B = "22222222-2222-4222-8222-222222222222";

/** Local calendar date (YYYY-MM-DD) of `date` in the account timezone. */
export function localDay(date, timeZone = "Asia/Dubai") {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

function dayString(base, plusDays) {
  const shifted = new Date(base.getTime() + plusDays * DAY_MS);
  return localDay(shifted);
}

/** `now`-relative seed so the rolling horizon always matches wall-clock time. */
export function seedStore(now = new Date()) {
  const store = new Map();
  const put = (table, rows) => store.set(table, rows);

  const tz = "Asia/Dubai";
  const today = dayString(now, 0);

  const businessRow = (owner, id, overrides = {}) => ({
    id,
    owner_user_id: owner,
    brand_name: "Perf Brand",
    brand_description: "A performance-test brand.",
    industry: "Retail",
    target_customer: ["store owners"],
    main_goal: "Grow awareness",
    brand_personality: ["direct"],
    preferred_channels: ["instagram", "tiktok", "youtube"],
    monthly_ad_budget: "500",
    content_frequency: "3x_week",
    automation_level: "assisted",
    publishing_permission: "approve_each_post",
    plan: "pro",
    allow_automatic_paid_media: false,
    timezone: tz,
    onboarding_completed: true,
    created_at: new Date(now.getTime() - 30 * DAY_MS).toISOString(),
    updated_at: now.toISOString(),
    ...overrides,
  });

  put("businesses", [
    businessRow(OWNER_A, "biz-1"),
    businessRow(OWNER_B, "biz-2", { brand_name: "Other Owner Brand" }),
  ]);

  put("profiles", [
    { user_id: OWNER_A, display_name: "Perf Owner", email: "perf@example.com" },
    { user_id: OWNER_B, display_name: "Other Owner", email: "other@example.com" },
  ]);

  const planA = "plan-1";
  put("marketing_plans", [
    {
      id: planA,
      owner_user_id: OWNER_A,
      business_goal: "Grow the brand with consistent content",
      valid_from: dayString(now, -1),
      valid_until: dayString(now, 6),
      status: "active",
      created_at: new Date(now.getTime() - DAY_MS).toISOString(),
    },
    {
      id: "plan-2",
      owner_user_id: OWNER_B,
      business_goal: "Someone else's plan",
      valid_from: dayString(now, -1),
      valid_until: dayString(now, 6),
      status: "active",
      created_at: new Date(now.getTime() - DAY_MS).toISOString(),
    },
  ]);

  // ── Rolling workflow drafts: 3/day × 7 days ────────────────────────────
  const drafts = [];
  const assets = [];
  const generations = [];
  const igQueue = [];
  const calendarItems = [];
  const ytQueue = [];
  const ttQueue = [];
  const pendingActions = [];

  const slotKinds = [
    { suffix: "instagram_post", kind: "instagram_post", channel: "instagram", format: "post" },
    { suffix: "instagram_reel", kind: "reel", channel: "instagram", format: "reel" },
  ];

  for (let day = 0; day < 7; day += 1) {
    const date = dayString(now, day);
    const publishAt = new Date(now.getTime() + day * DAY_MS).toISOString();
    for (const [index, slot] of slotKinds.entries()) {
      const id = `draft-${date}-${slot.suffix}`;
      const approved = day <= 1 && index === 0;
      drafts.push({
        id,
        owner_user_id: OWNER_A,
        source_plan_id: planA,
        source_plan_item_key: `${date}|${slot.suffix}`,
        kind: slot.kind,
        social_channel: slot.channel,
        social_format: slot.format,
        title: `Concept ${slot.suffix} ${date}`,
        content: `Caption for ${slot.suffix} on ${date}`,
        content_meta: slot.format === "reel" ? { description: "A reel", script: ["shot 1", "shot 2"] } : {},
        proposed_publish_at: publishAt,
        status: approved ? "approved" : "draft",
        created_at: new Date(now.getTime() - DAY_MS).toISOString(),
      });
      // Every Instagram item carries stored media → exercises the signed-URL path.
      assets.push({
        draft_id: id,
        owner_user_id: OWNER_A,
        mime_type: "image/jpeg",
        origin: "mara",
        storage_path: `visuals/${id}.jpg`,
        display_name: `${id}.jpg`,
        status: "uploaded",
      });
      generations.push({
        draft_id: id,
        owner_user_id: OWNER_A,
        status: "succeeded",
        media_type: "image",
        error_code: null,
        created_at: new Date(now.getTime() - DAY_MS).toISOString(),
        updated_at: new Date(now.getTime() - DAY_MS / 2).toISOString(),
      });
      calendarItems.push({
        id: `cal-${id}`,
        owner_user_id: OWNER_A,
        source_draft_id: id,
        title: `Concept ${slot.suffix} ${date}`,
        channel: slot.format === "reel" ? "Instagram Reel" : "Instagram Post",
        publish_at: publishAt,
        status: "scheduled",
      });
      if (approved) {
        igQueue.push({
          draft_id: id,
          owner_user_id: OWNER_A,
          status: "scheduled",
          instagram_media_id: null,
          failure_message: null,
          scheduled_at: publishAt,
          media_kind: slot.format,
          published_at: null,
        });
      }
    }

    // One social draft per day: TikTok and YouTube alternate.
    const social = day % 2 === 0
      ? { suffix: "tiktok_video", kind: "tiktok_video", channel: "tiktok", format: "video" }
      : { suffix: "youtube_short", kind: "youtube_short", channel: "youtube", format: "short" };
    const socialId = `draft-${date}-${social.suffix}`;
    drafts.push({
      id: socialId,
      owner_user_id: OWNER_A,
      source_plan_id: planA,
      source_plan_item_key: `${date}|${social.suffix}`,
      kind: social.kind,
      social_channel: social.channel,
      social_format: social.format,
      title: `Concept ${social.suffix} ${date}`,
      content: `Caption for ${social.suffix} on ${date}`,
      content_meta: {},
      proposed_publish_at: publishAt,
      status: day === 0 ? "approved" : "draft",
      created_at: new Date(now.getTime() - DAY_MS).toISOString(),
    });
    calendarItems.push({
      id: `cal-${socialId}`,
      owner_user_id: OWNER_A,
      source_draft_id: socialId,
      title: `Concept ${social.suffix} ${date}`,
      channel: social.suffix === "tiktok_video" ? "TikTok" : "YouTube Short",
      publish_at: publishAt,
      status: "scheduled",
    });
    if (day === 0) {
      const queueRow = {
        id: `q-${socialId}`,
        owner_user_id: OWNER_A,
        draft_id: socialId,
        status: "scheduled",
        failure_message: null,
        published_at: null,
        provider_privacy_status: "public",
        scheduled_at: publishAt,
      };
      if (social.suffix === "tiktok_video") ttQueue.push(queueRow);
      else ytQueue.push(queueRow);
    }
  }

  // Published / failed history (progressed work stays visible past the horizon).
  const pastDate = dayString(now, -3);
  const pastPublish = new Date(now.getTime() - 3 * DAY_MS).toISOString();
  const pastId = `draft-${pastDate}-instagram_reel`;
  drafts.push({
    id: pastId,
    owner_user_id: OWNER_A,
    source_plan_id: planA,
    source_plan_item_key: `${pastDate}|instagram_reel`,
    kind: "reel",
    social_channel: "instagram",
    social_format: "reel",
    title: "A published reel",
    content: "Published caption",
    content_meta: {},
    proposed_publish_at: pastPublish,
    status: "approved",
    created_at: new Date(now.getTime() - 4 * DAY_MS).toISOString(),
  });
  assets.push({
    draft_id: pastId,
    owner_user_id: OWNER_A,
    mime_type: "image/jpeg",
    origin: "mara",
    storage_path: `visuals/${pastId}.jpg`,
    display_name: `${pastId}.jpg`,
    status: "uploaded",
  });
  igQueue.push({
    draft_id: pastId,
    owner_user_id: OWNER_A,
    status: "published",
    instagram_media_id: "ig-media-1",
    failure_message: null,
    scheduled_at: pastPublish,
    media_kind: "reel",
    published_at: pastPublish,
  });

  // Pending approvals + one open reel-production action.
  pendingActions.push(
    {
      id: "act-1",
      owner_user_id: OWNER_A,
      tool_name: "propose_calendar_item",
      summary: "Approve a planned post",
      old_value: null,
      new_value: { sourceDraftId: `draft-${today}-instagram_post`, title: "Concept", publishAt: now.toISOString() },
      sanitized_arguments: { sourceDraftId: `draft-${today}-instagram_post`, title: "Concept", publishAt: now.toISOString() },
      status: "pending",
      result_summary: null,
      error_summary: null,
      created_at: new Date(now.getTime() - 3600_000).toISOString(),
      updated_at: new Date(now.getTime() - 3600_000).toISOString(),
      executed_at: null,
    },
    {
      id: "act-2",
      owner_user_id: OWNER_A,
      tool_name: "choose_reel_production",
      summary: "Choose how to produce a reel",
      old_value: null,
      new_value: { draftId: `draft-${today}-instagram_reel`, productionStatus: "awaiting_choice" },
      sanitized_arguments: { draftId: `draft-${today}-instagram_reel` },
      status: "pending",
      result_summary: null,
      error_summary: null,
      created_at: new Date(now.getTime() - 3200_000).toISOString(),
      updated_at: new Date(now.getTime() - 3200_000).toISOString(),
      executed_at: null,
    },
    {
      id: "act-3",
      owner_user_id: OWNER_A,
      tool_name: "propose_email_flow",
      summary: "Prepare a welcome flow",
      old_value: null,
      new_value: { flowType: "welcome" },
      sanitized_arguments: { flowType: "welcome" },
      status: "pending",
      result_summary: null,
      error_summary: null,
      created_at: new Date(now.getTime() - 3000_000).toISOString(),
      updated_at: new Date(now.getTime() - 3000_000).toISOString(),
      executed_at: null,
    },
  );

  put("mara_drafts", drafts);
  put("post_draft_assets", assets);
  put("mara_media_generations", generations);
  put("instagram_publish_queue", igQueue);
  put("content_calendar_items", calendarItems);
  put("youtube_publish_queue", ytQueue);
  put("tiktok_publish_queue", ttQueue);
  put("mara_pending_actions", pendingActions);

  // Legacy ordinal-slot draft must never surface in current views.
  store.get("mara_drafts").push({
    id: "draft-legacy-0",
    owner_user_id: OWNER_A,
    source_plan_id: planA,
    source_plan_item_key: "0",
    kind: "instagram_post",
    social_channel: "instagram",
    social_format: "post",
    title: "Legacy slot",
    content: "Legacy",
    content_meta: {},
    proposed_publish_at: now.toISOString(),
    status: "draft",
    created_at: new Date(now.getTime() - 10 * DAY_MS).toISOString(),
  });

  // ── Campaigns (exercises the campaign branch of the coordinator) ───────
  put("voom_campaigns", [
    {
      id: "camp-1",
      owner_user_id: OWNER_A,
      name: "Awareness push",
      goal: "awareness",
      status: "active",
      is_automated: true,
      start_at: new Date(now.getTime() - DAY_MS).toISOString(),
      end_at: new Date(now.getTime() + 10 * DAY_MS).toISOString(),
      created_at: new Date(now.getTime() - DAY_MS).toISOString(),
    },
  ]);
  put("voom_campaign_actions", [
    {
      id: "ca-1", campaign_id: "camp-1", owner_user_id: OWNER_A, slot: `${today}|instagram_reel`,
      channel: "instagram_reel", stage: "awareness", title: "Campaign reel", purpose: "reach",
      scheduled_for: now.toISOString(), status: "approved", draft_id: null, email_campaign_id: null, safety_blockers: [],
    },
    {
      id: "ca-2", campaign_id: "camp-1", owner_user_id: OWNER_A, slot: `${today}|email`,
      channel: "email", stage: "consideration", title: "Campaign email", purpose: "conversions",
      scheduled_for: now.toISOString(), status: "proposed", draft_id: null, email_campaign_id: null, safety_blockers: [],
    },
    {
      id: "ca-3", campaign_id: "camp-1", owner_user_id: OWNER_A, slot: `${today}|tiktok_video`,
      channel: "tiktok_video", stage: "awareness", title: "Campaign tiktok", purpose: "reach",
      scheduled_for: now.toISOString(), status: "needs_approval", draft_id: `draft-${today}-tiktok_video`, email_campaign_id: null, safety_blockers: [],
    },
  ]);
  put("mara_draft_assets", [
    { draft_id: `draft-${today}-tiktok_video`, owner_user_id: OWNER_A, storage_path: `visuals/tt-${today}.mp4` },
  ]);

  // ── Credits / performance / contacts / email state ─────────────────────
  put("voom_credit_ledger", [
    { owner_user_id: OWNER_A, credits: 10, source: "grant", status: "granted", created_at: new Date(now.getTime() - 20 * DAY_MS).toISOString() },
    { owner_user_id: OWNER_A, credits: 5, source: "generation", status: "settled", created_at: new Date(now.getTime() - 2 * DAY_MS).toISOString() },
  ]);

  const perfRows = [];
  for (let i = 0; i < 8; i += 1) {
    const published = new Date(now.getTime() - (2 + i) * DAY_MS).toISOString();
    perfRows.push({
      owner_user_id: OWNER_A,
      instagram_media_id: i === 0 ? "ig-media-1" : `ig-media-x${i}`,
      draft_id: i === 0 ? pastId : `draft-perf-${i}`,
      content_type: i % 2 === 0 ? "reel" : "post",
      published_at: published,
      collected_at: new Date(now.getTime() - i * 3600_000).toISOString(),
      metrics: { reach: 1000 + i * 10, likes: 100 + i, comments: 10 + i, shares: 5, saves: 3, total_interactions: 118 + i * 2 },
      metric_sources: { reach: "provider", likes: "provider" },
    });
  }
  put("instagram_performance_snapshots", perfRows);
  put("youtube_performance_snapshots", [
    {
      owner_user_id: OWNER_A, youtube_video_id: "yt-1", content_type: "video",
      published_at: new Date(now.getTime() - 5 * DAY_MS).toISOString(),
      collected_at: new Date(now.getTime() - DAY_MS).toISOString(),
      metrics: { views: 5000, likes: 120 },
    },
  ]);

  const contacts = [];
  for (let i = 0; i < 12; i += 1) {
    contacts.push({ id: `c-${i}`, owner_id: OWNER_A, email: `c${i}@example.com`, email_status: "subscribed" });
  }
  contacts.push({ id: "c-unsub", owner_id: OWNER_A, email: "unsub@example.com", email_status: "unsubscribed" });
  contacts.push({ id: "c-null", owner_id: OWNER_A, email: null, email_status: "subscribed" });
  put("contacts", contacts);

  put("campaign_sends", [
    { owner_user_id: OWNER_A, sent_at: new Date(now.getTime() - 2 * DAY_MS).toISOString() },
  ]);

  put("voom_email_flows", [
    { id: "flow-1", owner_user_id: OWNER_A, flow_type: "welcome", name: "Welcome", status: "active", created_by: "user", created_at: new Date(now.getTime() - 5 * DAY_MS).toISOString() },
  ]);
  put("voom_email_flow_enrollments", [
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "active" },
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "active" },
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "done" },
  ]);
  put("voom_email_flow_step_runs", [
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "scheduled", scheduled_for: now.toISOString(), accepted_at: null, delivered_at: null },
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "delivered", scheduled_for: pastPublish, accepted_at: pastPublish, delivered_at: pastPublish },
    { flow_id: "flow-1", owner_user_id: OWNER_A, status: "failed", scheduled_for: pastPublish, accepted_at: pastPublish, delivered_at: null },
  ]);

  put("instagram_connections", [
    { owner_user_id: OWNER_A, username: "perfbrand", display_name: "Perf Brand", account_type: "BUSINESS", profile_picture_url: null, scopes: ["instagram_business_basic"], status: "connected", token_expires_at: null, last_synced_at: null, connected_at: pastPublish },
  ]);
  put("tiktok_connections", [
    { owner_user_id: OWNER_A, open_id: "tt-open", display_name: "Perf", avatar_url: null, creator_username: "perf", scopes: ["video.publish"], status: "connected", access_token_expires_at: null, refresh_token_expires_at: null, default_privacy: "public", last_synced_at: null, connected_at: pastPublish },
  ]);
  put("youtube_connections", [
    { owner_user_id: OWNER_A, channel_id: "yt-chan", channel_title: "Perf", channel_handle: "@perf", thumbnail_url: null, scopes: ["https://www.googleapis.com/auth/youtube.upload"], status: "connected", access_token_expires_at: null, default_privacy: "public", default_made_for_kids: false, last_synced_at: null, connected_at: pastPublish },
  ]);

  // Owner B: a minimal but valid dataset to prove owner isolation.
  store.get("mara_drafts").push({
    id: "draft-b-1",
    owner_user_id: OWNER_B,
    source_plan_id: "plan-2",
    source_plan_item_key: `${today}|instagram_post`,
    kind: "instagram_post",
    social_channel: "instagram",
    social_format: "post",
    title: "Other owner's concept",
    content: "Other owner's caption",
    content_meta: {},
    proposed_publish_at: now.toISOString(),
    status: "draft",
    created_at: now.toISOString(),
  });

  return store;
}
