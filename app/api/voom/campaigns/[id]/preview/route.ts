import { prepareEmailPreview } from "@/lib/email/branded";
import { getCampaign } from "@/lib/mara/internal-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

/**
 * GET /api/voom/campaigns/:id/preview — the EXACT email the next send would
 * produce: same deterministic renderer, same sender identity resolution,
 * same quality guard as production sending. What the owner sees in the
 * preview is what the recipient gets.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "That campaign was not found." }, { status: 404 });
  }

  try {
    const db = await createClient();
    const campaign = await getCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });

    const admin = createAdminClient();
    const preview = await prepareEmailPreview(admin, user.id, {
      subject: campaign.subject?.trim() || campaign.name,
      previewText: campaign.preview_text ?? null,
      body: campaign.content,
      cta: "Learn more",
      ctaUrl: campaign.cta_url ?? null,
      campaignObjective: campaign.objective ?? null,
      campaignName: campaign.name,
      firstName: "Ada",
    });

    return Response.json({
      preview,
      recipient: "A sample recipient (Ada) — the real send addresses the selected contact or audience.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't build that preview. Please retry." }, { status: 503 });
  }
}

/**
 * POST /api/voom/campaigns/:id/preview — preview UNSAVED editor content, so
 * the owner sees exactly what saving would produce. Same deterministic
 * renderer, sender identity and quality guard as the production send.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "That campaign was not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That preview request isn't valid." }, { status: 400 });
  }
  const parsed = z
    .object({
      subject: z.string().trim().max(300).nullable().optional(),
      previewText: z.string().trim().max(500).nullable().optional(),
      content: z.string().trim().max(12000),
      ctaUrl: z.string().trim().max(500).nullable().optional(),
      name: z.string().trim().max(160).optional(),
      objective: z.string().trim().max(1000).optional(),
    })
    .strict()
    .safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Check the campaign content before previewing." }, { status: 400 });
  }

  try {
    const db = await createClient();
    const campaign = await getCampaign(db, user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });

    const admin = createAdminClient();
    const preview = await prepareEmailPreview(admin, user.id, {
      subject: (parsed.data.subject ?? campaign.subject ?? "").trim() || (parsed.data.name ?? campaign.name),
      previewText: parsed.data.previewText ?? campaign.preview_text ?? null,
      body: parsed.data.content,
      cta: "Learn more",
      ctaUrl: parsed.data.ctaUrl ?? campaign.cta_url ?? null,
      campaignObjective: parsed.data.objective ?? campaign.objective ?? null,
      campaignName: parsed.data.name ?? campaign.name,
      firstName: "Ada",
    });

    return Response.json({
      preview,
      recipient: "A sample recipient (Ada) — the real send addresses the selected contact or audience.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't build that preview. Please retry." }, { status: 503 });
  }
}
