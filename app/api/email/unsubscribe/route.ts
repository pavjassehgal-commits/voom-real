/**
 * The unsubscribe control: works without a recipient login.
 *
 * A marketing email links here with `?t=<opaque-signed-token>`. The token is
 * owner + address scoped and signed with the provider webhook secret (see
 * lib/branded-email/unsubscribe.ts); this route verifies it, performs the
 * owner-scoped suppression, and returns a confirmation the recipient can read
 * with zero authentication.
 *
 * Nothing here sends email or reserves media. The suppression itself is durable
 * and stops all future marketing sends for the address, exactly like a bounce.
 */

import { createHash } from "node:crypto";

import { verifyUnsubscribeToken } from "@/lib/branded-email/unsubscribe";
import { readResendConfig } from "@/lib/email/config";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const token = url.searchParams.get("t");
  if (!token) {
    return Response.json({ error: "That unsubscribe link is incomplete." }, { status: 400 });
  }

  const config = readResendConfig();
  if (!config?.webhookSecret) {
    return new Response(
      "Unsubscribe is not configured on the server yet. Please contact the business directly.",
      { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } },
    );
  }

  const verified = verifyUnsubscribeToken(config.webhookSecret, token);
  if (!verified.ok || !verified.payload) {
    return new Response("That unsubscribe link is invalid or expired.", {
      status: 400,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return new Response("Unsubscribe is not fully configured on the server yet.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const payload = verified.payload;

  try {
    const { data: optOut } = await admin.rpc("record_email_opt_out", {
      p_owner_user_id: payload.ownerUserId,
      p_email: payload.email,
      p_reason: "unsubscribe",
      p_contact_id: payload.contactId,
      p_flow_id: payload.flowId,
      p_campaign_id: payload.campaignId,
      p_source: "email_link",
      p_detail: "Unsubscribed from a signed link in a marketing email.",
    });

    if (optOut) {
      // Idempotent, replay-safe: the same token always maps to the same hash.
      await admin.rpc("record_email_opt_out_token", {
        p_owner_user_id: payload.ownerUserId,
        p_email: payload.email,
        p_token_hash: tokenHash(token),
        p_contact_id: payload.contactId,
        p_flow_id: payload.flowId,
        p_campaign_id: payload.campaignId,
      }).then(
        () => undefined,
        () => undefined,
      );
    }
  } catch {
    return new Response("Your request could not be completed. Please try again.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  return new Response(
    "You have been removed from this list. You will not receive further marketing emails from this business.",
    { status: 200, headers: { "Content-Type": "text/plain; charset=utf-8" } },
  );
}
