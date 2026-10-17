import { z } from "zod";

import { safePostAssetName } from "@/lib/post/asset";
import { getSocialDraft } from "@/lib/social/server-drafts";
import { finalizeTikTokUpload, type TikTokUploadFailure } from "@/lib/tiktok/upload-session";
import { createTikTokUploadPorts } from "@/lib/tiktok/upload-session-server";
import { tiktokUploadErrorMessage } from "@/lib/tiktok/video-upload";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const bodySchema = z.object({
  path: z.string().min(1).max(200),
  fileName: z.string().min(1).max(255),
}).strict();

/**
 * Finishes a direct upload: re-checks the signed-in owner and draft, then
 * verifies what actually arrived in storage (path, real size ≤ 50 MB, MP4
 * signature, readable duration) before linking it to the draft. Replacing a
 * video withdraws any TikTok confirmation. Safe to retry. Never calls TikTok.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again.", code: "not_authenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That TikTok draft was not found.", code: "not_found" }, { status: 404, headers: NO_STORE });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That upload was not valid.", code: "invalid" }, { status: 400, headers: NO_STORE }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "That upload was not valid.", code: "invalid" }, { status: 400, headers: NO_STORE });

  const admin = createAdminClient();
  try {
    const result = await finalizeTikTokUpload(createTikTokUploadPorts(admin), {
      ownerId: user.id,
      draftId: id,
      path: parsed.data.path,
      displayName: safePostAssetName(parsed.data.fileName),
    });
    if (!result.ok) return failure(result.code);
    const draft = await getSocialDraft(admin, user.id, id);
    return Response.json({
      draft,
      message: "Video stored privately in Voom. Review and confirm it before posting to TikTok.",
    }, { headers: NO_STORE });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "";
    if (code === "social_draft_provider_owned") return failure("provider_owned");
    if (code.includes("publish_cancel_failed") || code === "social_draft_queue_cancel_not_confirmed") {
      return Response.json({ error: "Voom couldn't safely withdraw the previous TikTok queue item. The new video was not attached.", code: "queue_withdraw_failed" }, { status: 503, headers: NO_STORE });
    }
    return Response.json({ error: "Voom couldn't attach that video. Please retry.", code: "storage_failure" }, { status: 503, headers: NO_STORE });
  }
}

function failure(code: TikTokUploadFailure) {
  const status = code === "not_found" || code === "not_tiktok" || code === "no_business" ? 404
    : code === "invalid_path" ? 403
      : code === "provider_owned" || code === "upload_incomplete" ? 409
        : code === "too_large" ? 413
          : code === "storage_failure" ? 503 : 400;
  const error = status === 404 ? "That TikTok draft was not found."
    : status === 403 ? "That upload doesn't belong to this draft."
      : tiktokUploadErrorMessage(code);
  return Response.json({ error, code }, { status, headers: NO_STORE });
}
