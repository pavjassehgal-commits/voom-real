import { processEmailUnsubscribe, verifyUnsubscribeToken } from "@/lib/email/branded/unsubscribe";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * POST /api/unsubscribe — processes a real, signed unsubscribe token.
 *
 * The token is owner- and address-scoped and HMAC-signed, so no login and no
 * session is needed: the token IS the proof that Voom itself sent this email
 * to this address. Processing is idempotent, so a double click is a safe
 * no-op.
 */
export async function POST(request: Request) {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as { token?: unknown };
  } catch {
    return Response.json({ ok: false, reason: "malformed", message: publicMessage("malformed") }, { status: 400 });
  }

  const token = typeof body.token === "string" ? body.token.trim() : "";
  const check = verifyUnsubscribeToken(token);
  if (!check.ok) {
    return Response.json({ ok: false, reason: check.reason, message: publicMessage(check.reason) }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const result = await processEmailUnsubscribe(admin, { ownerId: check.ownerId, email: check.email });

    if (result.ok) {
      return Response.json({
        ok: true,
        reason: result.reason,
        businessName: result.businessName,
        message:
          result.businessName
            ? `You're unsubscribed from ${result.businessName} marketing email.`
            : "You're unsubscribed from marketing email.",
      });
    }

    return Response.json({ ok: false, reason: result.reason, message: publicMessage("processing_failed") }, { status: 503 });
  } catch {
    return Response.json({ ok: false, reason: "processing_failed", message: publicMessage("processing_failed") }, { status: 503 });
  }
}

function publicMessage(reason: string): string {
  switch (reason) {
    case "malformed":
      return "That unsubscribe link is incomplete. If you need to manage your email preferences, reply to the email directly.";
    case "signature_invalid":
      return "That unsubscribe link isn't valid. If you need to manage your email preferences, reply to the email directly.";
    case "not_configured":
      return "We couldn't process that request right now. Please reply to the email instead.";
    default:
      return "We couldn't process that request right now. Please reply to the email instead.";
  }
}
