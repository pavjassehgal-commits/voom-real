import {
  EMAIL_ASSET_MAX_BYTES,
  EmailAssetError,
  listEmailAssets,
  publishDraftAssetAsEmailAsset,
  publishEmailAsset,
} from "@/lib/email/branded";
import { createEmailAssetStorage } from "@/lib/email/branded/storage";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

/**
 * GET  /api/voom/email-assets — the owner's published, email-safe assets.
 *      Public, durable URLs: no short-lived signed links are ever stored.
 *
 * POST /api/voom/email-assets — publish one asset:
 *   { source: "upload", bytesBase64, mimeType, altText? } or
 *   { source: "draft", draftId, altText? }
 *
 * Both paths verify real image bytes, size-cap them, register the row through
 * the guarded service-role RPC, and roll back the object if the row fails.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// JSON/base64 inflates ~33%; keep the decoded image under the engine cap.
const MAX_BASE64_LENGTH = Math.ceil((EMAIL_ASSET_MAX_BYTES * 4) / 3) + 64;

const uploadFields = z.object({
  source: z.literal("upload"),
  bytesBase64: z.string().min(64).max(MAX_BASE64_LENGTH),
  mimeType: z.enum(["image/jpeg", "image/png", "image/webp"]),
  altText: z.string().trim().max(200).optional(),
}).strict();

const draftFields = z.object({
  source: z.literal("draft"),
  draftId: z.string().trim().regex(UUID_RE),
  altText: z.string().trim().max(200).optional(),
}).strict();

const createFields = z.discriminatedUnion("source", [uploadFields, draftFields]);

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  try {
    const admin = createAdminClient();
    const rows = await listEmailAssets(admin, user.id);
    return Response.json({
      assets: rows
        .filter((row) => row.status !== "removed")
        .map((row) => ({
          id: row.id,
          url: typeof row.public_url === "string" ? row.public_url : null,
          altText: typeof row.alt_text === "string" ? row.alt_text : null,
          mimeType: typeof row.mime_type === "string" ? row.mime_type : null,
          byteSize: typeof row.byte_size === "number" ? row.byte_size : null,
          width: typeof row.width === "number" ? row.width : null,
          height: typeof row.height === "number" ? row.height : null,
          sourceKind: typeof row.source_kind === "string" ? row.source_kind : null,
          createdAt: typeof row.created_at === "string" ? row.created_at : null,
        })),
    });
  } catch {
    return Response.json({ error: "Voom couldn't load your email images. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "That upload isn't valid." }, { status: 400 });
  }
  const parsed = createFields.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Publish a JPEG, PNG or WebP image (10 MB max) to use it in email." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const storage = createEmailAssetStorage(admin);

    let asset;
    if (parsed.data.source === "upload") {
      const bytes = base64ToBytes(parsed.data.bytesBase64);
      if (!bytes) return Response.json({ error: "That image didn't come through correctly. Please retry." }, { status: 400 });
      // The publisher verifies the real bytes, makes the image email-safe
      // (capped width, compressed) and registers it with full rollback.
      asset = await publishEmailAsset(admin, storage, {
        ownerId: user.id,
        bytes,
        altText: parsed.data.altText?.trim() || "A photo from this business",
        sourceKind: "uploaded",
      });
    } else {
      asset = await publishDraftAssetAsEmailAsset(admin, storage, {
        ownerId: user.id,
        draftId: parsed.data.draftId,
        altText: parsed.data.altText?.trim() || "A photo from this business",
      });
    }

    return Response.json(
      {
        asset: {
          id: asset.id,
          url: asset.public_url,
          altText: asset.alt_text,
          mimeType: asset.mime_type,
          byteSize: asset.byte_size,
          width: asset.width,
          height: asset.height,
          sourceKind: asset.source_kind,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof EmailAssetError) {
      return Response.json({ error: error.message }, { status: friendlyAssetStatus(error.code) });
    }
    return Response.json({ error: "Voom couldn't publish that image. Nothing was saved." }, { status: 503 });
  }
}

function base64ToBytes(value: string): Uint8Array | null {
  try {
    const cleaned = value.replace(/\s+/g, "");
    const decoded = Buffer.from(cleaned, "base64");
    if (decoded.byteLength === 0 || decoded.byteLength > EMAIL_ASSET_MAX_BYTES) return null;
    return new Uint8Array(decoded);
  } catch {
    return null;
  }
}

function friendlyAssetStatus(code: string): number {
  switch (code) {
    case "invalid_image":
    case "image_too_large":
      return 415;
    case "draft_not_found":
      return 404;
    case "business_not_found":
      return 409;
    default:
      return 503;
  }
}
