import { randomUUID } from "node:crypto";
import { getCurrentUser } from "@/lib/voom/server-data";
import { getPostDraft, normalizeMediaBrief } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { advanceVideoJob, buildVideoService, enforceVideoJobHardTimeout, latestVideoGeneration, startPostStudioVideo } from "@/lib/mara/video-service";
import { isActiveVideoState } from "@/lib/mara/video-job";
import { toClientGenerationView } from "@/lib/mara/video-view";

export const runtime = "nodejs";
export const maxDuration = 300;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * MARA video generation status + actions for a Post Studio draft (Reel or
 * Story video).
 *
 * GET  — reads the draft's newest video job and lazily advances it: if a real
 *        provider job is in flight, this request polls it and, on success,
 *        downloads/validates/stores the video and atomically swaps it in as
 *        the draft's private asset. The previous asset is never removed until
 *        the new one is validated and linked.
 * POST — { action: "regenerate" } starts a new job (only when no active job
 *        exists; the client's idempotency key makes repeated clicks safe) and
 *        { action: "cancel" } stops a job that has not reached the provider.
 *
 * Nothing here publishes anywhere; the stored asset feeds the existing
 * draft -> approval -> schedule -> publish pipeline unchanged.
 *
 * The `brief` ("What should MARA create?") is persisted on the draft so it
 * survives reloads and regenerations.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 404 });

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
  if (post.kind !== "reel" && post.kind !== "story") {
    return Response.json({ generation: null, post, message: "MARA video generation is available for Reels and Stories." });
  }

  const row = await latestVideoGeneration(admin, user.id, id);
  if (!row) return Response.json({ generation: null, post }, { headers: { "Cache-Control": "no-store" } });

  if (isActiveVideoState(row.status)) {
    const service = await buildVideoService(admin, user.id);
    if (!service) {
      // The provider stack went unconfigured underneath a running job, so it
      // cannot be polled. Voom's OWN hard timeout does not depend on that
      // stack: a job that outlived it is stopped here — a guarded database
      // write only, no provider call, no new job, no charge — instead of
      // staying "generating" forever. A job still inside its limit is reported
      // as-is, untouched.
      const enforced = await enforceVideoJobHardTimeout(admin, user.id, row.id).catch(() => null);
      return Response.json({ generation: toClientGenerationView(enforced?.row ?? row, null), post }, { headers: { "Cache-Control": "no-store" } });
    }
    try {
      const advanced = await advanceVideoJob(service, id, row.id, post.kind);
      if (!advanced.ok) return Response.json({ error: "That generation could not be loaded. Please retry." }, { status: 404 });
      return Response.json({ generation: advanced.view, post: await getPostDraft(admin, user.id, id) }, { headers: { "Cache-Control": "no-store" } });
    } catch {
      return Response.json({ generation: toClientGenerationView(row, null), post }, { headers: { "Cache-Control": "no-store" } });
    }
  }

  const previewUrl = row.status === "completed" && typeof row.storage_path === "string"
    ? await createAdminClient().storage.from("mara-media").createSignedUrl(row.storage_path, 600).then((res) => res.data?.signedUrl ?? null).catch(() => null)
    : null;
  return Response.json({ generation: toClientGenerationView(row, previewUrl), post }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That post was not found." }, { status: 400 });

  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }
  const action = typeof body.action === "string" ? body.action : "";

  const admin = createAdminClient();
  const post = await getPostDraft(admin, user.id, id);
  if (!post) return Response.json({ error: "That post was not found." }, { status: 404 });
  if (post.kind !== "reel" && post.kind !== "story") {
    return Response.json({ error: "MARA video generation is available for Reels and Stories." }, { status: 400 });
  }

  const row = await latestVideoGeneration(admin, user.id, id);

  if (action === "use") {
    // "Use this": the validated asset is already attached to the draft; this
    // records the user's confirmation on the generation record.
    if (!row || row.status !== "completed") return Response.json({ error: "Wait for generation to finish first." }, { status: 409 });
    const { error } = await admin.from("mara_media_generations")
      .update({ approval_status: "approved" })
      .eq("id", row.id).eq("owner_user_id", user.id).eq("status", "completed");
    if (error) return Response.json({ error: "Voom couldn't record that choice safely. Nothing changed." }, { status: 503 });
    return Response.json({ generation: toClientGenerationView(row, null), message: "This video is in use. Approve and schedule to publish through the normal flow." });
  }

  if (action === "cancel") {
    if (!row) return Response.json({ error: "There is no video generation to cancel." }, { status: 404 });
    if (row.status === "queued") {
      const { error } = await admin.from("mara_media_generations")
        .update({ status: "cancelled", error_code: null })
        .eq("id", row.id).eq("owner_user_id", user.id).eq("status", "queued");
      if (error) return Response.json({ error: "Voom couldn't cancel that generation safely. Nothing changed." }, { status: 503 });
      return Response.json({ generation: toClientGenerationView({ ...row, status: "cancelled" }, null), message: "Generation cancelled before any provider work started." });
    }
    if (isActiveVideoState(row.status)) {
      return Response.json({ error: "This video job is already running with the provider and can't be cancelled. It will finish or fail on its own; your current asset is untouched." }, { status: 409 });
    }
    return Response.json({ generation: toClientGenerationView(row, null), message: "That generation already finished, so there was nothing to cancel." });
  }

  if (action !== "regenerate") return Response.json({ error: "Unknown generation action." }, { status: 400 });

  // Resolve brief: explicit body brief wins, otherwise persisted draft brief.
  let effectiveBrief = post.mediaBrief ?? "";
  if ("brief" in body) {
    const raw = (body as { brief?: unknown }).brief;
    if (raw === null || raw === "") {
      effectiveBrief = "";
      await admin.from("mara_drafts").update({ media_brief: null }).eq("owner_user_id", user.id).eq("id", id);
    } else if (typeof raw === "string") {
      effectiveBrief = raw.trim().slice(0, 800);
      const normalized = normalizeMediaBrief(raw);
      await admin.from("mara_drafts").update({ media_brief: normalized }).eq("owner_user_id", user.id).eq("id", id);
    }
  }

  // Idempotency: the client sends one token per user click; repeated clicks
  // with the same token resolve to the same job instead of a new paid run.
  const token = typeof body.idempotencyKey === "string" ? body.idempotencyKey.trim() : randomUUID();
  const result = await startPostStudioVideo({
    admin,
    ownerId: user.id,
    post: { id, kind: post.kind, conversationId: post.conversationId, concept: post.concept },
    brief: effectiveBrief,
    idempotencyToken: token,
  });
  if ("error" in result) {
    return Response.json({ generation: result.generation, error: result.error }, { status: result.status });
  }
  return Response.json(
    { generation: result.generation, post: await getPostDraft(admin, user.id, id), message: result.message },
    { status: result.status },
  );
}
