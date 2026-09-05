import { getCurrentUser } from "@/lib/voom/server-data";
import { normalizePostFormat, normalizeSchedule, postApprovalBlockers } from "@/lib/post/core";
import { approvePostDraft, getPostDraft, savePostDraft } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });
  try {
    const post = await getPostDraft(createAdminClient(), user.id, id);
    if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
    return Response.json({ post }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "That post couldn't load. Please retry." }, { status: 503 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }

  const admin = createAdminClient();
  const action = typeof body.action === "string" ? body.action : "save";

  if (action === "approve") {
    const existing = await getPostDraft(admin, user.id, id);
    if (!existing) return Response.json({ error: "That post was not found." }, { status: 404 });
    const blockers = postApprovalBlockers({ caption: existing.caption, hasVisual: existing.visualReady });
    if (blockers.length) return Response.json({ error: blockers.join(" ") }, { status: 409 });
    try {
      const post = await approvePostDraft(admin, user.id, id);
      return Response.json({ post, message: "Approved inside Voom. Nothing was published to Instagram." });
    } catch {
      return Response.json({ error: "Voom couldn't approve that post. Please retry." }, { status: 503 });
    }
  }

  if (action !== "save") return Response.json({ error: "Unknown post action." }, { status: 400 });

  const concept = typeof body.concept === "string" ? body.concept.trim().slice(0, 160) : undefined;
  const caption = typeof body.caption === "string" ? body.caption.slice(0, 2200) : undefined;
  const cta = typeof body.cta === "string" ? body.cta.trim().slice(0, 160) : undefined;
  const hashtags = Array.isArray(body.hashtags) ? body.hashtags.filter((tag): tag is string => typeof tag === "string").slice(0, 20) : undefined;
  const format = body.format !== undefined ? normalizePostFormat(body.format) : undefined;

  let scheduledAt: string | null | undefined;
  if ("scheduledAt" in body) {
    if (body.scheduledAt === null || body.scheduledAt === "") scheduledAt = null;
    else {
      const normalized = normalizeSchedule(body.scheduledAt);
      if (!normalized) return Response.json({ error: "That schedule date is not valid." }, { status: 400 });
      if (Date.parse(normalized) < Date.now() - 5 * 60_000) return Response.json({ error: "Choose a date in the future to schedule this." }, { status: 400 });
      scheduledAt = normalized;
    }
  }

  if ([concept, caption, cta, hashtags, format, scheduledAt].every((value) => value === undefined)) {
    return Response.json({ error: "There was nothing to save." }, { status: 400 });
  }

  try {
    const post = await savePostDraft(admin, user.id, id, { concept, caption, cta, hashtags, format, scheduledAt });
    if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
    return Response.json({ post, message: "Saved as a draft inside Voom. Nothing was published." });
  } catch (reason) {
    if (reason instanceof Error && reason.message === "post_concept_required") {
      return Response.json({ error: "Give this post a title before saving." }, { status: 400 });
    }
    return Response.json({ error: "Voom couldn't save that post. Please retry." }, { status: 503 });
  }
}
