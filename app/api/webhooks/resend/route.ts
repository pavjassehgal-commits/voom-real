import { readResendConfig } from "@/lib/email/config";
import { normalizeResendWebhook, verifyResendWebhook } from "@/lib/email/providers/resend";
import { recordDeliveryFromWebhook } from "@/lib/voom/campaign-delivery";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const config = readResendConfig();
  if (!config?.webhookSecret) return new Response("Resend webhook is not configured.", { status: 503 });

  const payload = await request.text();
  let event: Record<string, unknown>;
  try {
    event = verifyResendWebhook(payload, request.headers, config.webhookSecret);
  } catch {
    return new Response("Invalid webhook signature.", { status: 403 });
  }

  try {
    const admin = createAdminClient();
    const normalized = normalizeResendWebhook(event, request.headers);
    await recordDeliveryFromWebhook(admin, {
      provider: normalized.provider,
      providerMessageId: normalized.providerMessageId,
      eventId: normalized.eventId,
      eventType: normalized.eventType,
      receivedAt: normalized.receivedAt,
      providerStatus: normalized.status,
    });
  } catch {
    return new Response("Webhook handling failed safely.", { status: 503 });
  }

  return new Response("OK", { status: 200 });
}
