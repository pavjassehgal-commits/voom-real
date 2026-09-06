import { instagramKeyRing, readInstagramConfig } from "@/lib/instagram/config";
import { createRotationStore, rotateInstagramTokens } from "@/lib/instagram/key-rotation";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

/**
 * One-off Instagram token re-encryption endpoint.
 *
 * Protected by its own dedicated secret, INSTAGRAM_KEY_ROTATION_SECRET, which
 * is separate from CRON_SECRET so it can be created for the rotation and
 * deleted immediately afterwards. With that variable unset the route is fully
 * disabled and returns 503 — which is its normal, steady state. No normal user
 * can reach it, and there is no UI that references it.
 *
 * Safe to call twice: rows already on the primary key are reported as
 * alreadyCurrent and left untouched.
 *
 * Remove this file once the rotation is verified and the legacy key is gone.
 */
export async function POST(request: Request) {
  const secret = process.env.INSTAGRAM_KEY_ROTATION_SECRET;
  if (!secret) {
    return Response.json({ error: "Instagram key rotation is not enabled." }, { status: 503 });
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  const config = readInstagramConfig();
  if (!config) {
    return Response.json({ error: "Instagram is not configured on this server." }, { status: 503 });
  }

  const keyRing = instagramKeyRing(config);

  // A dry run reports what WOULD change without writing anything.
  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  try {
    const store = createRotationStore(createAdminClient());
    const outcome = await rotateInstagramTokens(
      dryRun ? { listRows: store.listRows, writeRow: async () => {} } : store,
      keyRing,
    );
    return Response.json(
      {
        dryRun,
        legacyKeysConfigured: keyRing.legacy.length,
        // Counts and owner ids only. No token plaintext, no ciphertext, no keys.
        ...outcome,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Instagram key rotation could not complete safely." }, { status: 503 });
  }
}
