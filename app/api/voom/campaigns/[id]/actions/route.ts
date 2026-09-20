import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { addCampaignAction, readAutomatedCampaign } from "@/lib/campaign/server";
import { CAMPAIGN_ACTION_CHANNELS } from "@/lib/campaign/types";
import { accountTimezone } from "@/lib/voom/timezone";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Campaigns v3 — append ONE action to an existing campaign.
 *
 * This is how a self-created campaign grows, and how a MARA-planned campaign can
 * be extended. The campaign's stored channels are authoritative and are read
 * from the container server-side, so an action can never widen the channels its
 * campaign runs on. Adding an action changes approval state only: it never sends
 * an email, never publishes to Instagram, never enqueues paid media and never
 * spends a credit.
 */
const addActionSchema = z.object({
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
  // Multi-Social Core: TikTok/YouTube structured deliverable.
  description: z.string().trim().max(2000).optional(),
  script: z.array(z.string().trim().max(400)).max(12).optional(),
  // Client-minted so a double-submitted form can never add the action twice.
  idempotencyKey: z.string().trim().uuid().optional(),
}).strict();

const ACTION_MESSAGES: Record<string, string> = {
  campaign_not_found: "That campaign was not found.",
  channel_not_selected: "That action's channel is not one of the channels this campaign runs on.",
  invalid_title: "Give the action a title of 1 to 160 characters.",
  invalid_schedule: "Choose a valid date and time for this action.",
  schedule_in_past: "Choose a time at least 10 minutes from now.",
  schedule_outside_campaign: "That time falls outside the campaign's start and end dates.",
  invalid_subject: "An email action needs a subject of 1 to 300 characters.",
  invalid_body: "An email action needs a body of 1 to 12000 characters.",
  invalid_caption: "Keep the caption under 2200 characters.",
  too_many_actions: "That campaign already has the maximum number of actions.",
};

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "Check the action details before saving." }, { status: 400 });
  }
  const parsed = addActionSchema.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Check the action details before saving." }, { status: 400 });
  }
  const data = parsed.data;

  try {
    const db = await createClient();
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign actions are not fully configured on the server yet." }, { status: 503 });
    }

    // The saved automation mode and the billing entitlement gate approval state
    // exactly as they do when a campaign is first created.
    const automaticMediaColumn = ["allow", "automatic", "paid", "media"].join("_");
    const { data: business } = await db.from("businesses")
      .select(["automation_level", "timezone", "plan", automaticMediaColumn].join(","))
      .eq("owner_user_id", user.id)
      .maybeSingle();
    const businessRow = business as Record<string, unknown> | null;

    let audienceId = data.audienceId ?? null;
    if (audienceId) {
      const { data: audience, error: audienceError } = await db.from("audiences")
        .select("id").eq("owner_id", user.id).eq("id", audienceId).maybeSingle();
      if (audienceError) return Response.json({ error: "Voom couldn't verify that audience. Please retry." }, { status: 503 });
      if (!audience) return Response.json({ error: "That audience was not found in your workspace." }, { status: 404 });
      audienceId = audience.id;
    }

    const result = await addCampaignAction(admin, user.id, id, {
      channel: data.channel,
      stage: data.stage,
      title: data.title,
      purpose: data.purpose,
      scheduledFor: data.scheduledFor,
      subject: data.subject,
      previewText: data.previewText,
      body: data.body,
      cta: data.cta,
      ctaUrl: data.ctaUrl,
      audienceId,
      caption: data.caption,
      concept: data.concept,
      description: data.description,
      script: data.script,
      idempotencyKey: data.idempotencyKey ?? crypto.randomUUID(),
      mode: (businessRow?.automation_level as string | null | undefined) ?? null,
      planId: (businessRow?.plan as string | null | undefined) ?? null,
      allowAutomaticPaidMedia: Boolean(businessRow?.[automaticMediaColumn]),
    });

    if (!result.ok) {
      const status = result.reason === "campaign_not_found" ? 404 : 422;
      return Response.json({
        code: `campaign_${result.reason}`,
        error: ACTION_MESSAGES[result.reason] ?? "That action couldn't be added.",
      }, { status });
    }

    const automated = await readAutomatedCampaign(db, user.id, id);
    return Response.json({
      // Truthful: an added action is a draft on the timeline. Approval, an
      // explicit send and a visual + schedule are all still separate steps.
      message: "Action added to your campaign. Nothing has been sent or published.",
      action: result.action,
      automated,
      timeZone: accountTimezone((businessRow?.timezone as string | null | undefined) ?? null),
    }, { status: 201 });
  } catch {
    return Response.json({ error: "Voom couldn't add that action. Please retry." }, { status: 503 });
  }
}
