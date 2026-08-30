import { getCurrentUser } from "@/lib/voom/server-data";
import { createCampaign, listCampaigns } from "@/lib/mara/internal-data";
import { readCampaignDelivery } from "@/lib/voom/campaign-delivery";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

const campaignFields = z.object({
  kind: z.enum(["email", "sms"]),
  name: z.string().trim().min(1).max(160),
  objective: z.string().trim().max(1000).default(""),
  audience: z.string().trim().max(1000).default(""),
  subject: z.string().trim().max(300).nullable().optional(),
  previewText: z.string().trim().max(500).nullable().optional(),
  content: z.string().trim().max(12000).default(""),
  proposedSendAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const kind = new URL(request.url).searchParams.get("kind") || undefined;
  if (kind && kind !== "email" && kind !== "sms") return Response.json({ error: "That campaign type is invalid." }, { status: 400 });
  try {
    const db = await createClient();
    const campaigns = await listCampaigns(db, user.id, kind);
    const deliveries = Object.fromEntries(await Promise.all(campaigns.map(async (campaign) => [campaign.id, await readCampaignDelivery(db, user.id, campaign)] as const)));
    return Response.json({ campaigns, deliveries });
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
  if (!parsed.success) return Response.json({ error: "Check the campaign details before saving." }, { status: 400 });

  try {
    const campaign = await createCampaign(await createClient(), user.id, {
      kind: parsed.data.kind,
      name: parsed.data.name,
      objective: parsed.data.objective,
      audience: parsed.data.audience,
      subject: parsed.data.subject ?? null,
      preview_text: parsed.data.previewText ?? null,
      content: parsed.data.content,
      proposed_send_at: parsed.data.proposedSendAt ?? null,
    });
    return Response.json({ campaign }, { status: 201 });
  } catch {
    return Response.json({ error: "Voom couldn't save that campaign draft. Please retry." }, { status: 503 });
  }
}
