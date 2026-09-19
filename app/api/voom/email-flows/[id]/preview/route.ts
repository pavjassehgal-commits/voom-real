import { prepareEmailPreview } from "@/lib/email/branded";
import { readEmailFlow } from "@/lib/email-flows/read";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

/**
 * GET  /api/voom/email-flows/:id/preview?position=N — the EXACT email one
 * flow step would send: same deterministic renderer, sender identity and
 * quality guard as the production engine.
 *
 * POST /api/voom/email-flows/:id/preview — the same preview of UNSAVED
 * editor content (the modal's current draft for one step), so the owner sees
 * precisely what saving would produce.
 */

const draftPreviewFields = z.object({
  position: z.number().int().min(0).max(11),
  subject: z.string().trim().min(1).max(300),
  previewText: z.string().trim().max(500).optional(),
  body: z.string().trim().min(1).max(12000),
  cta: z.string().trim().max(160).optional(),
  ctaUrl: z.string().trim().max(500).nullable().optional(),
}).strict();
export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "That flow was not found." }, { status: 404 });
  }

  const positionParam = new URL(request.url).searchParams.get("position");
  const position = positionParam === null ? 0 : Number.parseInt(positionParam, 10);
  if (!Number.isInteger(position) || position < 0 || position > 11) {
    return Response.json({ error: "Choose a valid step." }, { status: 400 });
  }

  try {
    const db = await createClient();
    const flow = await readEmailFlow(db, user.id, id);
    if (!flow) return Response.json({ error: "That flow was not found." }, { status: 404 });

    const step = flow.steps.find((candidate) => candidate.position === position);
    if (!step) {
      return Response.json({ error: "That step is not part of the flow's current revision." }, { status: 404 });
    }

    const admin = createAdminClient();
    const preview = await prepareEmailPreview(admin, user.id, {
      subject: step.subject,
      previewText: step.previewText,
      body: step.body,
      cta: step.cta,
      ctaUrl: step.ctaUrl,
      flowType: flow.flowType,
      campaignObjective: flow.objective,
      campaignName: flow.name,
      firstName: "Ada",
    });

    return Response.json({
      preview,
      step: {
        position: step.position,
        title: step.title,
        subject: step.subject,
        contentSource: step.contentSource,
      },
      recipient: "A sample recipient (Ada) — the real send addresses each enrolled contact.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't build that preview. Please retry." }, { status: 503 });
  }
}

/**
 * POST /api/voom/email-flows/:id/preview — preview UNSAVED editor content for
 * one step, so the owner sees exactly what saving would produce. Same
 * deterministic renderer, sender identity and quality guard as production.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "That flow was not found." }, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That preview request isn't valid." }, { status: 400 });
  }
  const parsed = draftPreviewFields.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Check the step content before previewing." }, { status: 400 });
  }

  try {
    const db = await createClient();
    const flow = await readEmailFlow(db, user.id, id);
    if (!flow) return Response.json({ error: "That flow was not found." }, { status: 404 });

    const step = flow.steps.find((candidate) => candidate.position === parsed.data.position);
    if (!step) {
      return Response.json({ error: "That step is not part of the flow's current revision." }, { status: 404 });
    }

    const admin = createAdminClient();
    const preview = await prepareEmailPreview(admin, user.id, {
      subject: parsed.data.subject,
      previewText: parsed.data.previewText ?? step.previewText,
      body: parsed.data.body,
      cta: parsed.data.cta ?? step.cta,
      ctaUrl: parsed.data.ctaUrl ?? step.ctaUrl,
      flowType: flow.flowType,
      campaignObjective: flow.objective,
      campaignName: flow.name,
      firstName: "Ada",
    });

    return Response.json({
      preview,
      step: {
        position: step.position,
        title: step.title,
        subject: parsed.data.subject,
        contentSource: "draft",
      },
      recipient: "A sample recipient (Ada) — the real send addresses each enrolled contact.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't build that preview. Please retry." }, { status: 503 });
  }
}
