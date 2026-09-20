import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  AutomatedCampaignBuildError,
  buildAutomatedCampaign,
  CampaignChannelsError,
  createSelfCampaign,
  newBuildIdempotencyKey,
  SelfCampaignValidationError,
} from "@/lib/campaign/server";
import {
  CAMPAIGN_ACTION_CHANNELS,
  CAMPAIGN_GOALS,
  MAX_CAMPAIGN_ACTIONS,
  MAX_CAMPAIGN_DAYS,
  MAX_EMAIL_ACTIONS,
  isCampaignGoal,
  normalizeCampaignChannels,
  type CampaignGoal,
} from "@/lib/campaign/types";
import { campaignDate, campaignSpanDays } from "@/lib/campaign/planner";
import { accountTimezone } from "@/lib/voom/timezone";

export const runtime = "nodejs";

const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Campaigns v3 — ONE creation endpoint for both user-facing paths.
 *
 *   creationMethod: 'mara'  MARA plans the actions inside the selected channels
 *   creationMethod: 'self'  the user supplies the actions directly
 *
 * Both write the same campaign container and the same timeline rows, so there is
 * one campaign model rather than one product per path or per channel mix.
 * `creationMethod` is deliberately not the word used for a Voom automation mode:
 * it records who planned the campaign, never who may execute it.
 */
const selfActionSchema = z.object({
  channel: z.enum(CAMPAIGN_ACTION_CHANNELS),
  stage: z.enum(["awareness", "consideration", "conversion", "retention"]).optional(),
  title: z.string().trim().min(1).max(160),
  purpose: z.string().trim().max(1000).optional().default(""),
  scheduledFor: z.string().trim().min(8).max(40),
  subject: z.string().trim().max(300).optional(),
  previewText: z.string().trim().max(500).optional(),
  body: z.string().trim().max(12000).optional(),
  cta: z.string().trim().max(160).optional(),
  ctaUrl: z.string().trim().max(500).nullable().optional(),
  audienceId: z.string().trim().regex(UUID_VALUE_RE).nullable().optional(),
  caption: z.string().trim().max(2200).optional(),
  concept: z.string().trim().max(160).optional(),
}).strict();

const buildSchema = z.object({
  // Required minimum: a name OR a short campaign idea, a goal, and dates.
  name: z.string().trim().min(1).max(160),
  goal: z.string().refine((value): value is CampaignGoal => isCampaignGoal(value), {
    message: "Choose one of the campaign goals.",
  }),
  startDate: z.string().trim().min(8).max(40),
  endDate: z.string().trim().min(8).max(40),
  offerDetails: z.string().trim().max(1000).optional().default(""),
  targetAudience: z.string().trim().max(1000).optional().default(""),
  notes: z.string().trim().max(2000).optional().default(""),
  audienceId: z.string().trim().regex(UUID_VALUE_RE).nullable().optional(),
  // Client-minted so a double-submitted form can never build twice.
  idempotencyKey: z.string().trim().uuid().optional(),
  // v3: which path created this campaign. Defaults to the MARA builder.
  creationMethod: z.enum(["mara", "self"]).optional().default("mara"),
  // v3: the campaign's authoritative channels. Validated against the one
  // allowlist below rather than a denylist, so a retired or invented channel is
  // refused server-side with an explicit code.
  channels: z.array(z.string().trim().min(1).max(20)).max(4).optional(),
  // v3: the user's own actions, used only on the self path.
  actions: z.array(selfActionSchema).max(MAX_CAMPAIGN_ACTIONS).optional().default([]),
}).strict();

/**
 * Truthful, actionable refusals for a self-created campaign.
 *
 * Each one names what the user has to change; none of them implies anything was
 * saved, sent or published. `channel_not_selected` is the invalid-combination
 * refusal: an action whose channel the campaign did not select.
 */
const SELF_ACTION_MESSAGES: Record<string, string> = {
  channel_not_selected: "That action's channel is not one of the channels this campaign runs on.",
  too_many_actions: `A campaign can hold at most ${MAX_CAMPAIGN_ACTIONS} actions.`,
  too_many_emails: `Keep a campaign to ${MAX_EMAIL_ACTIONS} emails or fewer.`,
  invalid_action: "Check that action before saving.",
  invalid_title: "Every action needs a title of 1 to 160 characters.",
  invalid_schedule: "Choose a valid date and time for every action.",
  schedule_in_past: "Choose a time at least 10 minutes from now.",
  schedule_outside_campaign: "Every action must fall inside the campaign's start and end dates.",
  invalid_dates: "The end date must be on or after the start date.",
  invalid_subject: "An email action needs a subject of 1 to 300 characters.",
  invalid_body: "An email action needs a body of 1 to 12000 characters.",
  invalid_preview_text: "Keep the preview text under 500 characters.",
  invalid_cta: "Keep the CTA under 160 characters.",
  invalid_caption: "Keep the caption under 2200 characters.",
  invalid_concept: "Keep the concept under 160 characters.",
};

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Tell Voom what the campaign is for first." }, { status: 400 });
  }
  const parsed = buildSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Add a campaign idea, a goal, and start/end dates." }, { status: 400 });
  }
  const data = parsed.data;

  // v3: resolve the campaign's authoritative channels once, before anything is
  // planned or written. An empty selection, an unknown value, a repeat, or a
  // channel Voom has retired are all refused here with an explicit code.
  const channelsResult = normalizeCampaignChannels(data.channels ?? null);
  if (!channelsResult.ok) {
    return Response.json({
      code: "campaign_channels_invalid",
      error: "Choose Instagram, Email, or both.",
    }, { status: 422 });
  }
  const channels = channelsResult.channels;

  try {
    const db = await createClient();

    // Date-only inputs are interpreted in the workspace's business calendar,
    // never in the browser's timezone or UTC.
    const datesValid = (DATE_RE.test(data.startDate) || !Number.isNaN(Date.parse(data.startDate)))
      && (DATE_RE.test(data.endDate) || !Number.isNaN(Date.parse(data.endDate)));
    if (!datesValid) return Response.json({ error: "Choose valid start and end dates." }, { status: 400 });

    // The saved automation mode and timezone decide what this build is allowed
    // to do. The build never sends or publishes in any mode.
    const automaticMediaColumn = ["allow", "automatic", "paid", "media"].join("_");
    const { data: business } = await db.from("businesses")
      .select(["automation_level", "timezone", "plan", automaticMediaColumn].join(","))
      .eq("owner_user_id", user.id)
      .maybeSingle();
    const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
    const startDate = campaignDate(data.startDate, timeZone);
    const endDate = campaignDate(data.endDate, timeZone);
    if (!startDate || !endDate) return Response.json({ error: "Choose valid start and end dates." }, { status: 400 });

    const span = campaignSpanDays(startDate, endDate, timeZone);
    if (span < 1) return Response.json({ error: "The end date must be on or after the start date." }, { status: 400 });
    if (span > MAX_CAMPAIGN_DAYS) {
      return Response.json({ error: `Keep campaigns to ${MAX_CAMPAIGN_DAYS} days or fewer for v1.` }, { status: 400 });
    }

    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign building is not fully configured on the server yet." }, { status: 503 });
    }

    let audienceId: string | null = null;
    if (data.audienceId) {
      const { data: audience, error: audienceError } = await db.from("audiences")
        .select("id").eq("owner_id", user.id).eq("id", data.audienceId).maybeSingle();
      if (audienceError) return Response.json({ error: "Voom couldn't verify that audience. Please retry." }, { status: 503 });
      if (!audience) return Response.json({ error: "That audience was not found in your workspace." }, { status: 404 });
      audienceId = audience.id;
    }

    const brief = {
      name: data.name,
      goal: data.goal,
      startAt: startDate,
      endAt: endDate,
      offerDetails: data.offerDetails || undefined,
      targetAudience: data.targetAudience || undefined,
      notes: data.notes || undefined,
      audienceId,
      channels,
    };
    const gating = {
      mode: (business as { automation_level?: string | null } | null)?.automation_level ?? null,
      planId: (business as { plan?: string | null } | null)?.plan ?? null,
      allowAutomaticPaidMedia: Boolean((business as Record<string, unknown> | null)?.[automaticMediaColumn]),
      timeZone,
      idempotencyKey: data.idempotencyKey ?? newBuildIdempotencyKey(),
    };

    // v3 path 2: the user wrote the campaign themselves. No provider is called,
    // no strategy is invented, and the automation mode gates approval state
    // exactly as it does on the MARA path — being self-created grants nothing.
    if (data.creationMethod === "self") {
      const created = await createSelfCampaign(db, admin, user.id, {
        brief,
        actions: data.actions,
        channels,
        ...gating,
      });
      return Response.json({
        message: created.actionCount === 0
          ? "Your campaign is saved. Add its actions whenever you are ready. Nothing has been sent or published."
          : "Your campaign is saved. Nothing has been sent or published.",
        ...created,
        goals: CAMPAIGN_GOALS,
      }, { status: 201 });
    }

    // v3 path 1: MARA plans the campaign inside the selected channels.
    const result = await buildAutomatedCampaign(db, admin, user.id, {
      brief,
      channels,
      ...gating,
    });

    return Response.json({
      // Truthful about which layer wrote the content: when the text provider
      // was unavailable the deterministic v1 plan was used and the campaign
      // was still created. Nothing was sent or published either way.
      message: result.generationSource === "mara"
        ? "MARA built your campaign. Nothing has been sent or published."
        : "Voom built your campaign from its standard campaign plan because MARA's writer was unavailable. Nothing has been sent or published.",
      ...result,
      goals: CAMPAIGN_GOALS,
    }, { status: 201 });
  } catch (error) {
    return buildFailureResponse(error);
  }
}

/**
 * Maps a build failure to a truthful, non-sensitive client response.
 *
 * The raw Postgres error never reaches the client — only its SQLSTATE
 * category selects a canned message and a stable machine-readable `code`:
 *   - missing migration/schema (42883 undefined function, 42P01 undefined
 *     table, 42703 undefined column, PGRST202 stale PostgREST schema
 *     cache): the service is not available on this deployment yet;
 *   - integrity errors (23xxx): a database constraint refused the write;
 *   - any other RPC failure / server error: a general failure to retry.
 */
function buildFailureResponse(error: unknown): Response {
  // v3: an invalid channel selection is a client mistake, not a server failure.
  if (error instanceof CampaignChannelsError) {
    return Response.json(
      { code: "campaign_channels_invalid", error: "Choose Instagram, Email, or both." },
      { status: 422 },
    );
  }

  // v3: a self-created campaign whose actions do not fit its own channels,
  // dates or content limits. The message says what to fix; nothing is written.
  if (error instanceof SelfCampaignValidationError) {
    return Response.json(
      { code: `campaign_${error.reason}`, error: SELF_ACTION_MESSAGES[error.reason] ?? "Check the campaign actions before saving." },
      { status: 422 },
    );
  }

  const code = error instanceof AutomatedCampaignBuildError ? error.code : null;

  if (code === "42883" || code === "42P01" || code === "42703" || code === "PGRST202") {
    return Response.json(
      {
        code: "campaigns_schema_missing",
        error: "Campaign building is not available on this deployment yet — the latest database changes have not been applied.",
      },
      { status: 503 },
    );
  }

  if (code !== null && /^23\d{3}$/.test(code)) {
    return Response.json(
      {
        code: "campaign_save_refused",
        error: "Voom couldn't save that campaign because a data safety check refused it. Please retry.",
      },
      { status: 422 },
    );
  }

  if (error instanceof AutomatedCampaignBuildError) {
    return Response.json(
      {
        code: "campaign_save_failed",
        error: "Voom couldn't save that campaign. Please retry.",
      },
      { status: 503 },
    );
  }

  return Response.json(
    { code: "campaign_build_failed", error: "MARA couldn't build that campaign. Please retry." },
    { status: 503 },
  );
}
