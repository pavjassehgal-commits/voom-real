import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface DeliveryScope { name: string; secret: string }
export interface DeliverySource { ownerId: string; sourceKind: string; sourceId: string }

/** Preview must never silently accept another environment's delivery events.
 * Production without these new settings retains legacy callback compatibility. */
export function readDeliveryScope(env: Record<string, string | undefined> = process.env): DeliveryScope | null {
  const name = env.EMAIL_DELIVERY_SCOPE?.trim();
  const secret = env.EMAIL_DELIVERY_SCOPE_SECRET?.trim();
  if (!name && !secret && env.VERCEL_ENV !== "preview") return null;
  if (!name || !/^[a-zA-Z0-9_-]{1,64}$/.test(name) || !secret || secret.length < 32) {
    throw new Error("email_delivery_scope_required");
  }
  return { name, secret };
}

function signature(scope: DeliveryScope, source: DeliverySource) {
  return createHmac("sha256", scope.secret)
    .update(JSON.stringify(["voom-email-v1", scope.name, source.ownerId, source.sourceKind, source.sourceId]))
    .digest("hex");
}

export function deliveryScopeTags(source: DeliverySource, scope = readDeliveryScope()) {
  return scope ? [{ name: "voom_scope", value: scope.name }, { name: "voom_proof", value: signature(scope, source) }] : [];
}

export function validDeliveryProof(scope: DeliveryScope, source: DeliverySource, proof: unknown) {
  return typeof proof === "string" && /^[a-f0-9]{64}$/.test(proof)
    && timingSafeEqual(Buffer.from(proof, "hex"), Buffer.from(signature(scope, source), "hex"));
}
