import { getCurrentUser } from "@/lib/voom/server-data";
import { isSocialVideoDraftKind, normalizePostFormat, normalizeSchedule, postApprovalBlockers } from "@/lib/post/core";
import { APPROVAL_CONTENT_CHANGED, approvePostDraft, deletePostDraft, getPostDraft, normalizeMediaBrief, rejectPostDraft, savePostDraft, setPostAssetOrigin } from "@/lib/post/server-data";
import { checkScheduleInstant } from "@/lib/voom/schedule-guard";
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

/**
 * Deletes a post for good. Refused while Instagram is publishing it or once it
 * is published; everything else (draft, approved, scheduled, cancelled) is
 * removed together with its calendar entry, queue row and stored file.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });
  try {
    const result = await deletePostDraft(createAdminClient(), user.id, id);
    if (result.ok) return Response.json({ deleted: true, message: "Post deleted." });
    if (result.reason === "not_found") return Response.json({ error: "That post was not found." }, { status: 404 });
    if (result.reason === "publishing") return Response.json({ error: "Instagram is publishing this post right now. Wait for it to finish, then try again." }, { status: 409 });
    return Response.json({ error: "This post was published to Instagram, so Voom keeps its record. Remove it on Instagram if needed." }, { status: 409 });
  } catch {
    return Response.json({ error: "Voom couldn't delete that post. Please retry." }, { status: 503 });
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
  // TikTok/YouTube drafts share mara_drafts but are approved, scheduled and
  // cancelled only through /api/social-drafts, never the Instagram post path.
  const { data: row, error: kindError } = await admin.from("mara_drafts").select("kind")
    .eq("owner_user_id", user.id).eq("id", id).maybeSingle();
  if (kindError) return Response.json({ error: "Voom couldn't load that post. Please retry." }, { status: 503 });
  if (row && isSocialVideoDraftKind(row.kind)) {
    return Response.json({ error: "Open this video in its YouTube or TikTok editor to change it. Nothing was changed." }, { status: 409 });
  }
  const action = typeof body.action === "string" ? body.action : "save";

  if (action === "approve") {
    const existing = await getPostDraft(admin, user.id, id);
    if (!existing) return Response.json({ error: "That post was not found." }, { status: 404 });
    const blockers = postApprovalBlockers({ caption: existing.caption, hasVisual: existing.visualReady, kind: existing.kind });
    if (blockers.length) return Response.json({ error: blockers.join(" ") }, { status: 409 });
    // Optional: the content version the owner reviewed (GET returns it as
    // post.contentVersion). When sent, Voom approves exactly that version.
    const expected = body.contentVersion;
    if (expected !== undefined && (typeof expected !== "number" || !Number.isSafeInteger(expected) || expected < 1)) {
      return Response.json({ error: "That request was not valid." }, { status: 400 });
    }
    try {
      const post = await approvePostDraft(admin, user.id, id, expected === undefined ? undefined : { expectedContentVersion: expected });
      return Response.json({ post, message: post?.scheduledAt ? "Approved. Voom will automatically publish this to Instagram at the scheduled time." : "Approved inside Voom. Add a schedule so Voom can auto-publish it." });
    } catch (err) {
      if (err instanceof Error && err.message === APPROVAL_CONTENT_CHANGED) {
        const post = await getPostDraft(admin, user.id, id).catch(() => null);
        return Response.json({ post, error: "This post changed after you reviewed it. Nothing was approved — review the latest version and approve again." }, { status: 409 });
      }
      return Response.json({ error: "Voom couldn't approve that post. Please retry." }, { status: 503 });
    }
  }

  if (action === "reject" || action === "cancel") {
    // Cancelling an approved item must stop auto-publishing. An item already
    // published, or already in flight, is never cancelled or republished.
    try {
      const post = await rejectPostDraft(admin, user.id, id);
      if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
      return Response.json({ post, message: "Cancelled. Voom will not publish this to Instagram." });
    } catch {
      return Response.json({ error: "Voom couldn't cancel that post. Please retry." }, { status: 503 });
    }
  }

  if (action === "source") {
    // Instagram Posts only: Reels are always existing content and Stories
    // have no copy to suggest.
    const origin = body.origin;
    if (origin !== "own_asset" && origin !== "existing_content") return Response.json({ error: "Choose a valid source." }, { status: 400 });
    const existing = await getPostDraft(admin, user.id, id);
    if (!existing) return Response.json({ error: "That post was not found." }, { status: 404 });
    if (existing.kind !== "instagram_post") return Response.json({ error: "The source can only be changed on an Instagram Post." }, { status: 400 });
    try {
      const updated = await setPostAssetOrigin(admin, user.id, id, origin);
      const post = updated ? await getPostDraft(admin, user.id, id) : existing;
      return Response.json({
        post,
        message: origin === "existing_content"
          ? (updated ? "Source set to Existing content. MARA can now suggest a caption, CTA and timing." : "Source set to Existing content. It applies to the visual you upload next.")
          : "Source set to My own asset.",
      });
    } catch {
      return Response.json({ error: "Voom couldn't change the source. Please retry." }, { status: 503 });
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
      // Same shared guard the client runs: no past dates, no same-day past
      // times, evaluated in the business timezone.
      const check = checkScheduleInstant(normalized);
      if (!check.ok) return Response.json({ error: check.error }, { status: 400 });
      scheduledAt = normalized;
    }
  }

  let mediaBrief: string | null | undefined;
  if ("brief" in body || "mediaBrief" in body) {
    const raw = (body as { brief?: unknown; mediaBrief?: unknown }).brief ?? (body as { mediaBrief?: unknown }).mediaBrief;
    if (raw === null || raw === "") mediaBrief = null;
    else if (typeof raw === "string") mediaBrief = normalizeMediaBrief(raw) ?? (raw.trim() ? raw.trim().slice(0, 800) : null);
    else mediaBrief = undefined;
  }

  if ([concept, caption, cta, hashtags, format, scheduledAt, mediaBrief].every((value) => value === undefined)) {
    return Response.json({ error: "There was nothing to save." }, { status: 400 });
  }

  try {
    const post = await savePostDraft(admin, user.id, id, { concept, caption, cta, hashtags, format, scheduledAt, mediaBrief });
    if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
    // Editing approved content withdraws its approval (migration 0059); only
    // the owner's own schedule change keeps it.
    return Response.json({
      post,
      message: post.status === "approved"
        ? "Rescheduled. Your approval still covers this post."
        : "Saved as a draft inside Voom. Nothing was published. Approve it when it's ready to publish.",
    });
  } catch (reason) {
    if (reason instanceof Error && reason.message === "post_concept_required") {
      return Response.json({ error: "Give this post a title before saving." }, { status: 400 });
    }
    return Response.json({ error: "Voom couldn't save that post. Please retry." }, { status: 503 });
  }
}
