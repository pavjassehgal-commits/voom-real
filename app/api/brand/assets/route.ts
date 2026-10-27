import { randomUUID } from "node:crypto";
import { z } from "zod";
import { BRAND_ASSET_KINDS, BRAND_ASSET_LIMITS, brandAssetPath, isOwnBrandAssetPath, type BrandAsset, type BrandAssetKind } from "@/lib/brand/assets";
import { loadNewestBrandAssets, putBrandAssetObject, removeBrandAssetObjects, signBrandAssetUrls } from "@/lib/brand/asset-storage";
import { computeLogoColours } from "@/lib/brand/image";
import { detectReelAsset } from "@/lib/media/reel-asset";
import { consumeAiRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

/**
 * Brand Kit v2, slice 5: brand images (logo, product photos, past posts).
 *
 * POST   multipart { file, kind }: checks the real bytes (JPEG, PNG or WebP,
 *        10 MB), stores them unchanged in the private `brand-kit` bucket under
 *        the caller's own folder, and returns the reference plus a one-hour
 *        preview link. For a logo it also returns the two colours computed
 *        from its pixels. Nothing is added to the brand kit here: the
 *        reference is saved with the next kit version (onboarding Finish or a
 *        Brand page Save).
 * DELETE { path }: removes an upload that is NOT part of the saved kit (a
 *        file removed before Finish, or a Brand page edit that was cancelled).
 *        Saved images are removed by saving the Brand page without them.
 */

function json(body: unknown, status = 200) {
  return Response.json(body, { status });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);

  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (contentLength > BRAND_ASSET_LIMITS.maxBytes + 500_000) return json({ error: "That image is too large. Choose one up to 10 MB." }, 413);

  let form: FormData;
  try { form = await request.formData(); } catch { return json({ error: "Choose one image." }, 400); }
  const kindRaw = form.get("kind");
  if (typeof kindRaw !== "string" || !(BRAND_ASSET_KINDS as readonly string[]).includes(kindRaw)) return json({ error: "Choose where this image goes." }, 400);
  const kind = kindRaw as BrandAssetKind;
  const file = form.get("file");
  if (!(file instanceof File) || file.size < 1) return json({ error: "Choose one image." }, 400);
  if (file.size > BRAND_ASSET_LIMITS.maxBytes) return json({ error: "That image is too large. Choose one up to 10 MB." }, 413);

  const bytes = new Uint8Array(await file.arrayBuffer());
  // Magic bytes, never the browser's content type or the file name.
  const detected = detectReelAsset(bytes);
  if (!detected || detected.kind !== "image" || (detected.extension !== "jpg" && detected.extension !== "png" && detected.extension !== "webp")) {
    return json({ error: "Use a JPEG, PNG or WebP image." }, 400);
  }

  if (!(await consumeAiRateLimit(user.id, "brand_asset_upload"))) return rateLimitedResponse();

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch { return json({ error: "Voom couldn't store that image. Nothing changed." }, 503); }

  const id = randomUUID();
  const path = brandAssetPath(user.id, kind, id, detected.extension);
  try {
    await putBrandAssetObject(admin, path, bytes, detected.mimeType);
  } catch {
    console.error("[brand-assets] upload failed", { kind });
    return json({ error: "Voom couldn't store that image. Nothing changed." }, 503);
  }

  // Colours come from the pixels, by code. A logo they can't be read from simply has none.
  const colours = kind === "logo" ? await computeLogoColours(bytes).catch(() => null) : null;
  const previews = await signBrandAssetUrls(admin, user.id, [path]);
  const asset: BrandAsset = {
    id, kind, path,
    mimeType: detected.mimeType as BrandAsset["mimeType"],
    byteSize: bytes.byteLength,
    description: "", chips: [], look: "", describedBy: "",
  };
  return json({ asset, previewUrl: previews[path] ?? null, colours });
}

const deleteBody = z.object({ path: z.string().max(200) }).strict();

export async function DELETE(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);
  let body: z.infer<typeof deleteBody>;
  try { body = deleteBody.parse(await request.json()); } catch { return json({ error: "That image was not found." }, 400); }
  if (!isOwnBrandAssetPath(user.id, body.path)) return json({ error: "That image was not found." }, 404);

  let admin: ReturnType<typeof createAdminClient>;
  try { admin = createAdminClient(); } catch { return json({ error: "Voom couldn't remove that image. Please try again." }, 503); }

  const saved = await loadNewestBrandAssets(admin, user.id);
  if (saved.some((asset) => asset.path === body.path)) {
    return json({ error: "That image is part of your saved brand kit. Remove it on the Brand page and save." }, 409);
  }
  await removeBrandAssetObjects(admin, user.id, [body.path]);
  return json({ ok: true });
}
