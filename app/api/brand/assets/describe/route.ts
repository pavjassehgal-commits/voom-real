import { z } from "zod";
import { AiError, createAiVisionProvider } from "@/lib/ai";
import { BRAND_ASSET_KINDS, isOwnBrandAssetPath } from "@/lib/brand/assets";
import { readBrandAssetObject } from "@/lib/brand/asset-storage";
import { downscaleForVision } from "@/lib/brand/image";
import { describeBrandImage } from "@/lib/brand/vision";
import { consumeAiRateLimit } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Brand Kit v2, slice 5: MARA looks at one uploaded brand image.
 *
 * POST { path, kind } -> { ok: true, reading } or { ok: false, reason }.
 * The image must sit in the caller's own folder. A small JPEG copy (768 px)
 * goes to the optional vision model (AI_VISION_*); nothing is stored here,
 * the owner keeps or changes the text and it is saved with the kit. Every
 * failure is a plain reason with status 200, so the uploader simply leaves
 * the line empty for the owner to type.
 */

const body = z.object({ path: z.string().max(200), kind: z.enum(BRAND_ASSET_KINDS) }).strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ ok: false, reason: "login" }, { status: 401 });
  let input: z.infer<typeof body>;
  try { input = body.parse(await request.json()); } catch { return Response.json({ ok: false, reason: "not_found" }, { status: 400 }); }
  if (!isOwnBrandAssetPath(user.id, input.path, input.kind)) return Response.json({ ok: false, reason: "not_found" }, { status: 404 });

  // Checked before the limiter, so an account without image reading spends nothing.
  let provider: ReturnType<typeof createAiVisionProvider>;
  try { provider = createAiVisionProvider(); } catch { return Response.json({ ok: false, reason: "not_configured" }); }

  if (!(await consumeAiRateLimit(user.id, "brand_vision"))) return Response.json({ ok: false, reason: "rate_limited" });

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch { return Response.json({ ok: false, reason: "unavailable" }); }
  const bytes = await readBrandAssetObject(admin, user.id, input.path);
  if (!bytes) return Response.json({ ok: false, reason: "not_found" });

  let jpeg: Uint8Array;
  try { jpeg = await downscaleForVision(bytes); } catch { return Response.json({ ok: false, reason: "unreadable" }); }

  try {
    const reading = await describeBrandImage(provider, { kind: input.kind, jpeg });
    return Response.json({ ok: true, reading });
  } catch (error) {
    const code = error instanceof AiError ? error.code : "unknown";
    console.error("[brand-vision] failed", { code, kind: input.kind });
    return Response.json({ ok: false, reason: code === "rate_limited" ? "rate_limited" : code === "not_configured" ? "not_configured" : "unavailable" });
  }
}
