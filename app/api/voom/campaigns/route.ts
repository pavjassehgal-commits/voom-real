import { getCurrentUser } from "@/lib/voom/server-data";
import { createCampaign, listCampaigns } from "@/lib/mara/internal-data";
import { readCampaignDelivery } from "@/lib/voom/campaign-delivery";
import { readAutomatedCampaign } from "@/lib/campaign/server";
import type { AutomatedCampaignView, CampaignContainerRecord } from "@/lib/campaign/types";
import type { CampaignRecord } from "@/lib/voom/types";
import { createClient } from "@/utils/supabase/server";
import { accountTimezone } from "@/lib/voom/timezone";
import { z } from "zod";

const UUID_VALUE_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Legacy single-channel draft creation (email only). SMS is no longer
// creatable; automated multi-channel campaigns are POSTed to ./build.
const campaignFields = z.object({
  kind: z.literal("email"),
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().max(1000).default(""),
  audience: z.string().trim().max(1000).default(""),
  audienceId: z.string().trim().regex(UUID_VALUE_RE).nullable().optional(),
  subject: z.string().trim().max(300).nullable().optional(),
  previewText: z.string().trim().max(500).nullable().optional(),
  content: z.string().trim().max(12000).default(""),
  /** Explicit campaign destination for the CTA button; never invented. */
  ctaUrl: z.string().trim().max(500).nullable().optional(),
  proposedSendAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

function isAutomatedContainer(row: CampaignRecord | CampaignContainerRecord): boolean {
  return Boolean(row.is_automated) || row.kind === "multi";
}

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const kind = new URL(request.url).searchParams.get("kind") || undefined;
  // The legacy ?kind=sms filter remains readable for historical data; only
  // email and sms literals are accepted (never a new SMS creation).
  if (kind && kind !== "email" && kind !== "sms") {
    return Response.json({ error: "That campaign type is invalid." }, { status: 400 });
  }
  try {
    const db = await createClient();
    const rows = await listCampaigns(db, user.id);
    const all = rows as unknown as CampaignRecord[];
    const { data: business } = await db.from("businesses").select("timezone").eq("owner_user_id", user.id).maybeSingle();
    const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);

    // Automated timeline campaigns (MARA-built containers).
    const containers = all.filter((row) => isAutomatedContainer(row) && !row.parent_campaign_id);
    const automated: AutomatedCampaignView[] = [];
    for (const container of containers) {
      const view = await readAutomatedCampaign(db, user.id, container.id).catch(() => null);
      if (view) automated.push(view);
    }

    // Legacy single-channel drafts, including historical (read-only) SMS rows.
    // Automated child campaigns never appear in the legacy list.
    const legacy = all.filter((row) =>
      !row.is_automated && !row.parent_campaign_id && (!kind || row.kind === kind),
    );
    const deliveries: Record<string, Awaited<ReturnType<typeof readCampaignDelivery>>> = {};
    for (const campaign of legacy) {
      if (campaign.kind === "multi") continue;
      deliveries[campaign.id] = await readCampaignDelivery(db, user.id, campaign);
    }

    return Response.json({
      // Back-compat: the legacy list keeps its old field name.
      campaigns: legacy,
      legacy,
      automated,
      deliveries,
      timeZone,
    });
  } catch {
    return Response.json({ error: "Campaigns couldn't load. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That campaign is not valid." }, { status: 400 }); }
  const parsed = campaignFields.safeParse(body);
  if (!parsed.success) {
    // SMS removal: a client that still asks for SMS gets an explicit refusal.
    const rawKind = (body as { kind?: unknown } | null)?.kind;
    if (rawKind === "sms") {
      return Response.json({ error: "SMS marketing is no longer available in Voom. Build an email or Instagram campaign instead." }, { status: 400 });
    }
    return Response.json({ error: "Check the campaign details before saving." }, { status: 400 });
  }

  try {
    const db = await createClient();

    let audienceId: string | null = null;
    if (parsed.data.audienceId) {
      const { data: audience, error: audienceError } = await db
        .from("audiences")
        .select("id")
        .eq("owner_id", user.id)
        .eq("id", parsed.data.audienceId)
        .maybeSingle();
      if (audienceError) {
        return Response.json({ error: "Voom couldn't verify that audience. Please retry." }, { status: 503 });
      }
      if (!audience) {
        return Response.json({ error: "That audience was not found in your workspace." }, { status: 404 });
      }
      audienceId = audience.id;
    }

    const campaign = await createCampaign(db, user.id, {
      kind: "email",
      name: parsed.data.name,
      objective: parsed.data.objective,
      audience: parsed.data.audience,
      audience_id: audienceId,
      subject: parsed.data.subject ?? null,
      preview_text: parsed.data.previewText ?? null,
      content: parsed.data.content,
      cta_url: parsed.data.ctaUrl ?? null,
      proposed_send_at: parsed.data.proposedSendAt ?? null,
    });
    return Response.json({ campaign }, { status: 201 });
  } catch {
    return Response.json({ error: "Voom couldn't save that campaign draft. Please retry." }, { status: 503 });
  }
}
