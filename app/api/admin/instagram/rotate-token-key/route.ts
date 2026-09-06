import { instagramKeyRing, readInstagramConfig } from "@/lib/instagram/config";
import { createRotationStore, publicRotationResult, rotateInstagramTokens } from "@/lib/instagram/key-rotation";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * Protected, one-off PRIMARY -> NEXT Instagram token rotation endpoint.
 *
 * INSTAGRAM_KEY_ROTATION_SECRET controls access. NEXT must be present and must
 * differ from PRIMARY; otherwise staged rotation is refused before any secret
 * rows are scanned. Normal writes remain on PRIMARY throughout this process.
 */
export async function POST(request: Request) {
  const secret = process.env.INSTAGRAM_KEY_ROTATION_SECRET;
  if (!secret) {
    return Response.json(
      { error: "Instagram key rotation is not enabled." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (request.headers.get("authorization") !== `Bearer ${secret}`) {
    return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  }

  const config = readInstagramConfig();
  if (!config) {
    return Response.json(
      { error: "Instagram is not configured on this server." },
      { status: 503, headers: NO_STORE },
    );
  }
  if (!config.nextEncryptionKey || config.nextEncryptionKey === config.encryptionKey) {
    return Response.json(
      { error: "Instagram staged key rotation is not configured." },
      { status: 503, headers: NO_STORE },
    );
  }

  const dryRun = new URL(request.url).searchParams.get("dryRun") === "1";

  try {
    const outcome = await rotateInstagramTokens(
      createRotationStore(createAdminClient()),
      instagramKeyRing(config),
      { dryRun },
    );

    // Exact allowlist: status/counts only. No owner ids, plaintext, ciphertext,
    // key identifiers, key values or underlying errors.
    return Response.json(publicRotationResult(outcome, dryRun), { headers: NO_STORE });
  } catch {
    return Response.json(
      { error: "Instagram key rotation could not complete safely." },
      { status: 503, headers: NO_STORE },
    );
  }
}
