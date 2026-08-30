import { readResendConfig } from "@/lib/email/config";
import { recordDeliveryFromWebhook, verifyResendWebhook } from "@/lib/voom/campaign-delivery";
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
    await recordDeliveryFromWebhook(admin, {
      provider: "resend",
      providerMessageId: firstString((event.data as Record<string, unknown> | undefined)?.email_id, (event.data as Record<string, unknown> | undefined)?.emailId, (event.data as Record<string, unknown> | undefined)?.id),
      eventId: request.headers.get("svix-id") || firstString(event.id) || `resend:${Date.now()}`,
      eventType: firstString(event.type) || "email.unknown",
      receivedAt: firstString(event.created_at, (event.data as Record<string, unknown> | undefined)?.created_at) || new Date().toISOString(),
      providerStatus: firstString(event.type) || null,
    });
  } catch {
    return new Response("Webhook handling failed safely.", { status: 503 });
  }

  return new Response("OK", { status: 200 });
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}
