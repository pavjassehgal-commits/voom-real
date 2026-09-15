import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import {
  AutomatedCampaignBuildError,
  buildAutomatedCampaign,
  newBuildIdempotencyKey,
} from "@/lib/campaign/server";
import {
  CAMPAIGN_GOALS,
  MAX_CAMPAIGN_DAYS,
  isCampaignGoal,
  type CampaignGoal,
} from "@/lib/campaign/types";
import { campaignSpanDays } from "@/lib/campaign/planner";

export const runtime = "nodejs";

const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
}).strict();

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

  // Date-only inputs are interpreted in the business's Dubai calendar.
  const datesValid = (DATE_RE.test(data.startDate) || !Number.isNaN(Date.parse(data.startDate)))
    && (DATE_RE.test(data.endDate) || !Number.isNaN(Date.parse(data.endDate)));
  if (!datesValid) return Response.json({ error: "Choose valid start and end dates." }, { status: 400 });

  const span = campaignSpanDays(dubaiDate(data.startDate), dubaiDate(data.endDate));
  if (span < 1) return Response.json({ error: "The end date must be on or after the start date." }, { status: 400 });
  if (span > MAX_CAMPAIGN_DAYS) {
    return Response.json({ error: `Keep campaigns to ${MAX_CAMPAIGN_DAYS} days or fewer for v1.` }, { status: 400 });
  }

  try {
    const db = await createClient();

    // The saved automation mode decides what the build is allowed to approve
    // internally. The build never sends or publishes in any mode.
    const { data: business } = await db.from("businesses")
      .select("automation_level")
      .eq("owner_user_id", user.id)
      .maybeSingle();

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

    const result = await buildAutomatedCampaign(db, admin, user.id, {
      brief: {
        name: data.name,
        goal: data.goal,
        startAt: dubaiDate(data.startDate),
        endAt: dubaiDate(data.endDate),
        offerDetails: data.offerDetails || undefined,
        targetAudience: data.targetAudience || undefined,
        notes: data.notes || undefined,
        audienceId,
      },
      mode: (business as { automation_level?: string | null } | null)?.automation_level ?? null,
      idempotencyKey: data.idempotencyKey ?? newBuildIdempotencyKey(),
    });

    return Response.json({
      message: "MARA built your campaign. Nothing has been sent or published.",
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

function dubaiDate(value: string): string {
  if (DATE_RE.test(value)) return value;
  const shifted = new Date(new Date(value).getTime() + 4 * 60 * 60_000);
  return shifted.toISOString().slice(0, 10);
}
