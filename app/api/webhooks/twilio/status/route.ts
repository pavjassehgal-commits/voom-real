import { verifyTwilioSignature, recordDeliveryFromWebhook } from "@/lib/voom/campaign-delivery";
import { readTwilioConfig } from "@/lib/sms/config";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const config = readTwilioConfig();
  if (!config) return new Response("Twilio is not configured.", { status: 503 });

  const raw = await request.text();
  const params = Object.fromEntries(new URLSearchParams(raw).entries());
  const signature = request.headers.get("x-twilio-signature");
  const valid = verifyTwilioSignature({ authToken: config.apiKey, url: request.url, params, signature });
  if (!valid) return new Response("Invalid Twilio signature.", { status: 403 });

  try {
    const admin = createAdminClient();
    const status = params.MessageStatus || params.SmsStatus || "unknown";
    const eventId = request.headers.get("i-twilio-idempotency-token") || `${params.MessageSid || "missing"}:${status}:${params.ErrorCode || ""}:${params.RawDlrDoneDate || params.DateCreated || ""}`;
    await recordDeliveryFromWebhook(admin, {
      provider: "twilio",
      providerMessageId: params.MessageSid || null,
      eventId,
      eventType: status,
      receivedAt: new Date().toISOString(),
      providerStatus: status,
    });
  } catch {
    return new Response("Webhook handling failed safely.", { status: 503 });
  }

  return new Response("OK", { status: 200 });
}
