import { readResendConfig } from "@/lib/email/config";
import { normalizeResendWebhook, verifyResendWebhook } from "@/lib/email/providers/resend";
import { recordDeliveryFromWebhook } from "@/lib/voom/campaign-delivery";
import { createAdminClient } from "@/utils/supabase/admin";
import { createResendWebhookHandler } from "@/lib/email/webhook-handler";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return createResendWebhookHandler({ config: readResendConfig, verify: verifyResendWebhook,
    normalize: normalizeResendWebhook, db: createAdminClient, record: recordDeliveryFromWebhook })(request);
}
