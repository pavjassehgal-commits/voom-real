import { hasPublishPermission } from "./publishing.ts";

export type InstagramPublishReadiness = "ready" | "missing" | "disconnected" | "permission_required" | "expired";
export type InstagramConnectionIssue = Exclude<InstagramPublishReadiness, "ready">;

/** Read-only UI eligibility, not a replacement for the worker's final checks.
 * A persisted connection/job is not proof of usable authorization. Unknown
 * legacy expiry stays compatible with the worker; an invalid explicit expiry
 * fails closed. This never refreshes tokens or changes a draft or queue row.
 */
export function instagramPublishReadiness(connection: {
  status: string;
  scopes: readonly string[];
  tokenExpiresAt?: string | null;
} | null, now: Date = new Date()): InstagramPublishReadiness {
  if (!connection || connection.status === "not_connected") return "missing";
  if (connection.status === "expired") return "expired";
  if (connection.status !== "connected") return "disconnected";
  if (connection.tokenExpiresAt) {
    const expiry = Date.parse(connection.tokenExpiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return "expired";
  }
  if (!hasPublishPermission([...connection.scopes])) return "permission_required";
  return "ready";
}
