import { z } from "zod";

import { startTikTokUpload, type TikTokUploadFailure } from "@/lib/tiktok/upload-session";
import { createTikTokUploadPorts, tiktokResumableEndpoint } from "@/lib/tiktok/upload-session-server";
import { POST_ASSET_BUCKET } from "@/lib/post/server-data";
import { tiktokUploadErrorMessage } from "@/lib/tiktok/video-upload";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NO_STORE = { "Cache-Control": "no-store" } as const;

const bodySchema = z.object({
  fileName: z.string().min(1).max(255),
  fileSize: z.number().int().positive(),
  contentType: z.string().max(100).optional(),
}).strict();

/**
 * Starts one direct upload of a TikTok draft video. Returns a signed upload
 * token that is valid for 2 hours and for exactly one private path under the
 * signed-in owner's folder. No video bytes pass through this function, no
 * service-role credential leaves the server, and TikTok is never contacted.
 */
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again.", code: "not_authenticated" }, { status: 401, headers: NO_STORE });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That TikTok draft was not found.", code: "not_found" }, { status: 404, headers: NO_STORE });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Choose one MP4 video.", code: "invalid" }, { status: 400, headers: NO_STORE }); }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Choose one MP4 video.", code: "invalid" }, { status: 400, headers: NO_STORE });

  const endpoint = tiktokResumableEndpoint();
  if (!endpoint) return Response.json({ error: "Video uploads aren't available right now.", code: "not_configured" }, { status: 503, headers: NO_STORE });

  try {
    const result = await startTikTokUpload(createTikTokUploadPorts(createAdminClient()), {
      ownerId: user.id,
      draftId: id,
      fileName: parsed.data.fileName,
      fileSize: parsed.data.fileSize,
      contentType: parsed.data.contentType,
    });
    if (!result.ok) return failure(result.code);
    return Response.json({
      upload: {
        endpoint,
        bucket: POST_ASSET_BUCKET,
        path: result.path,
        token: result.token,
        expiresAt: result.expiresAt,
        maxBytes: result.maxBytes,
        chunkSize: result.chunkSize,
      },
    }, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Voom couldn't start the upload. Please retry.", code: "storage_failure" }, { status: 503, headers: NO_STORE });
  }
}

function failure(code: TikTokUploadFailure) {
  const status = code === "not_found" || code === "not_tiktok" || code === "no_business" ? 404
    : code === "provider_owned" ? 409
      : code === "too_large" ? 413
        : code === "storage_failure" ? 503 : 400;
  const error = status === 404 ? "That TikTok draft was not found." : tiktokUploadErrorMessage(code);
  return Response.json({ error, code }, { status, headers: NO_STORE });
}
