/**
 * Branded Email Engine v1 — durable public URL resolution for email assets.
 *
 * Email images must be PUBLIC and DURABLE: a temporary signed URL would expire
 * inside a delivered email and leak nothing useful, so this module only ever
 * returns a stable public URL for an asset in a public bucket. When the asset
 * cannot be read back safely, it returns null and the renderer falls back to
 * brand color/text design (no broken image, no signed URL).
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { isEmailSafeImage } from "./assets";

/** Buckets Voom is allowed to serve publicly from for email (never private slides). */
const PUBLIC_EMAIL_BUCKETS = new Set(["brand-assets"]);

/**
 * Resolves a durable, public URL for an asset object path in an email-safe
 * public bucket. Returns null for anything else — including signed URLs or
 * non-public buckets — so a broken or expiring image can never be embedded.
 */
export async function getPublicAssetUrl(
  db: SupabaseClient,
  storagePath: string,
): Promise<string | null> {
  const path = (storagePath ?? "").trim();
  if (!path || path.length > 500 || path.includes("..")) return null;

  const [bucketId, ...rest] = path.split("/");
  if (!bucketId || !PUBLIC_EMAIL_BUCKETS.has(bucketId)) return null;
  const objectPath = rest.join("/");
  if (!objectPath) return null;

  // `getPublicUrl` is the ONLY url surface this module uses: it creates the
  // stable public URL; it never signs and never exposes a signed token.
  const { data } = await db.storage.from(bucketId).getPublicUrl(objectPath);
  if (!data) return null;

  const url = String((data as { publicUrl?: string }).publicUrl ?? "");
  const guessed = mimeTypeFromPath(objectPath);
  if (!guessed || !isEmailSafeImage(url, guessed)) return null;
  return url;
}

function mimeTypeFromPath(path: string): string | null {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "image/png";
  if (lower.endsWith(".webp")) return "image/webp";
  if (lower.endsWith(".gif")) return "image/gif";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
  return null;
}
