import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ResendConfig } from "./core";
import type { NormalizedEmailDeliveryEvent } from "./provider";
import { readDeliveryScope, validDeliveryProof } from "./delivery-scope";

interface WebhookDeps {
  config: () => ResendConfig | null;
  verify: (payload: string, headers: Headers, secret: string) => Record<string, unknown>;
  normalize: (event: Record<string, unknown>, headers: Headers) => NormalizedEmailDeliveryEvent;
  db: () => SupabaseClient;
  record: (db: SupabaseClient, input: {
    provider: "resend"; providerMessageId: string | null; eventId: string;
    eventType: string; receivedAt: string; providerStatus: string | null;
    sourceId?: string; sourceKind?: "campaign" | "flow";
  }) => Promise<void>;
  env?: Record<string, string | undefined>;
}

export function createResendWebhookHandler(deps: WebhookDeps) {
  return async (request: Request): Promise<Response> => {
    const config = deps.config();
    if (!config?.webhookSecret) return new Response("Resend webhook is not configured.", { status: 503 });
    const payload = await request.text();
    if (Buffer.byteLength(payload) > 65536) return new Response("Webhook too large.", { status: 413 });
    let event: Record<string, unknown>;
    try { event = deps.verify(payload, request.headers, config.webhookSecret); }
    catch { return new Response("Invalid webhook signature.", { status: 403 }); }
    try {
      const scope = readDeliveryScope(deps.env);
      const normalized = deps.normalize(event, request.headers);
      const data = event.data as { tags?: Record<string, unknown> } | undefined;
      const tags = data?.tags;
      // A correctly signed event for another environment is intentionally
      // ignored, not saved as an unmatched receipt or copied into staging.
      if (scope && tags?.voom_scope !== scope.name) return new Response("Ignored unrelated delivery.", { status: 200 });
      // Never apply scoped traffic through an unconfigured legacy receiver.
      if (!scope && (tags?.voom_scope || tags?.voom_proof)) return new Response("Ignored scoped delivery.", { status: 200 });
      const admin = deps.db();
      if (scope) {
        if (!normalized.sourceId || !normalized.sourceKind || !normalized.providerMessageId) {
          return new Response("Invalid delivery identity.", { status: 403 });
        }
        const result = await admin.from("voom_email_submissions")
          .select("owner_user_id,source_id,source_kind,state,provider_message_id")
          .eq("source_id", normalized.sourceId).eq("source_kind", normalized.sourceKind).maybeSingle();
        // Missing/failed reads must remain retryable, including a callback
        // racing submission persistence. Do not acknowledge successful work.
        if (result.error || !result.data) throw new Error("delivery_submission_unavailable");
        const row = result.data;
        if (!validDeliveryProof(scope, { ownerId: row.owner_user_id, sourceKind: row.source_kind, sourceId: row.source_id }, tags?.voom_proof)
          || row.state === "rejected" || (row.provider_message_id && row.provider_message_id !== normalized.providerMessageId)) {
          return new Response("Invalid delivery binding.", { status: 403 });
        }
        // A message ID already belonging to any other owner/source must never
        // reach the legacy message-based status/suppression update path.
        const collision = await admin.from("voom_email_submissions")
          .select("owner_user_id,source_id,source_kind").eq("provider_message_id", normalized.providerMessageId).maybeSingle();
        if (collision.error) throw new Error("delivery_lookup_unavailable");
        if (collision.data && (collision.data.owner_user_id !== row.owner_user_id
          || collision.data.source_id !== row.source_id || collision.data.source_kind !== row.source_kind)) {
          return new Response("Conflicting delivery identity.", { status: 403 });
        }
      }
      await deps.record(admin, {
        provider: normalized.provider, providerMessageId: normalized.providerMessageId,
        eventId: normalized.eventId, eventType: normalized.eventType,
        receivedAt: normalized.receivedAt, providerStatus: normalized.status,
        sourceId: normalized.sourceId, sourceKind: normalized.sourceKind,
      });
    } catch { return new Response("Webhook handling failed safely.", { status: 503 }); }
    return new Response("OK", { status: 200 });
  };
}
