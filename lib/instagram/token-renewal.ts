import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { InstagramTokenRefreshError } from "./token-refresh.ts";
import { decryptInstagramToken, encryptInstagramToken, type InstagramKeyRing } from "./crypto.ts";

/**
 * Automatic renewal of Instagram long-lived access tokens (migration 0068).
 *
 * Meta: a long-lived Instagram Login token lasts 60 days and can be refreshed
 * for another 60 only while it is at least 24 hours old and unexpired; an
 * expired token cannot be refreshed and the owner must reconnect.
 *
 * Each run first marks already-lapsed connections expired, then claims due
 * connections inside PostgreSQL (`for update skip locked` plus a lease), so
 * overlapping runs never renew the same connection. The renewed token is
 * re-encrypted with the PRIMARY key, verified, and stored together with its
 * new expiry in one transaction, only if the claim is still current. A failed
 * renewal keeps the stored credential: transient failures retry later; a token
 * Meta rejects marks the connection expired/revoked so the owner sees
 * Reconnect. Tokens, provider responses and owner ids never leave this module.
 */

/** Renew once fewer than this many days remain (Meta issues 60). */
export const RENEW_BEFORE_DAYS = 30;
/** A claim older than this is considered abandoned and may be re-claimed. */
export const CLAIM_LEASE_MINUTES = 10;
/** Bounded so one run fits the 300 s worker ceiling (15 s request timeout each). */
export const RENEWAL_BATCH_LIMIT = 10;
/** Stop starting renewals after this much wall-clock time. */
export const RENEWAL_BUDGET_MS = 200_000;
const TRANSIENT_RETRY_MS = 6 * 60 * 60 * 1000;
const RATE_LIMIT_RETRY_MS = 12 * 60 * 60 * 1000;

export type RenewalErrorCode =
  | "rate_limited" | "unavailable" | "invalid_response" | "token_invalid"
  | "permission_missing" | "decrypt_failed" | "encrypt_failed";

export interface RenewalClaim {
  ownerUserId: string;
  claimId: string;
  connectedAt: string;
  tokenExpiresAt: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
}

export interface RenewalStore {
  expireLapsed(): Promise<number>;
  claim(limit: number, renewBeforeDays: number, leaseMinutes: number): Promise<RenewalClaim[]>;
  complete(claim: RenewalClaim, next: { encryptedToken: string; iv: string; authTag: string; keyVersion: number }, expiresAt: string): Promise<boolean>;
  fail(claim: RenewalClaim, code: RenewalErrorCode, retryAt: string | null, connectionStatus: "expired" | "revoked" | null): Promise<boolean>;
}

export interface RenewalDeps {
  store: RenewalStore;
  refresh: (accessToken: string) => Promise<{ accessToken: string; expiresIn: number }>;
  keyRing: InstagramKeyRing;
  now?: () => number;
}

/** Counts only: safe to return from the protected worker route. */
export interface RenewalOutcome {
  lapsedMarkedExpired: number;
  claimed: number;
  renewed: number;
  retrying: number;
  reconnectRequired: number;
  stale: number;
  failed: number;
  deferred: number;
}

export async function renewInstagramTokens(deps: RenewalDeps): Promise<RenewalOutcome> {
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const outcome: RenewalOutcome = { lapsedMarkedExpired: 0, claimed: 0, renewed: 0, retrying: 0, reconnectRequired: 0, stale: 0, failed: 0, deferred: 0 };

  outcome.lapsedMarkedExpired = await deps.store.expireLapsed();
  const claims = await deps.store.claim(RENEWAL_BATCH_LIMIT, RENEW_BEFORE_DAYS, CLAIM_LEASE_MINUTES);
  outcome.claimed = claims.length;

  for (const claim of claims) {
    // Unstarted claims simply lapse after the lease and are picked up again.
    if (now() - startedAt > RENEWAL_BUDGET_MS) { outcome.deferred += 1; continue; }
    const result = await renewOne(deps, claim, now);
    outcome[result] += 1;
  }
  return outcome;
}

type RenewalResult = "renewed" | "retrying" | "reconnectRequired" | "stale" | "failed";

async function renewOne(deps: RenewalDeps, claim: RenewalClaim, now: () => number): Promise<RenewalResult> {
  let current: string;
  try {
    current = decryptInstagramToken({ encryptedToken: claim.encryptedToken, iv: claim.iv, authTag: claim.authTag }, deps.keyRing);
  } catch {
    // A key-configuration problem, not a bad token: never ask the owner to reconnect for it.
    return recordFailure(deps, claim, "decrypt_failed", now);
  }

  let renewed: { accessToken: string; expiresIn: number };
  try {
    renewed = await deps.refresh(current);
  } catch (error) {
    const code: RenewalErrorCode = error instanceof InstagramTokenRefreshError ? error.code : "unavailable";
    return recordFailure(deps, claim, code, now);
  }

  let next: { encryptedToken: string; iv: string; authTag: string; keyVersion: number };
  try {
    next = encryptInstagramToken(renewed.accessToken, deps.keyRing);
    const verified = decryptInstagramToken({ encryptedToken: next.encryptedToken, iv: next.iv, authTag: next.authTag }, deps.keyRing);
    if (verified !== renewed.accessToken) throw new Error("instagram_token_verify_failed");
  } catch {
    return recordFailure(deps, claim, "encrypt_failed", now);
  }

  const expiresAt = new Date(now() + renewed.expiresIn * 1000).toISOString();
  try {
    return (await deps.store.complete(claim, next, expiresAt)) ? "renewed" : "stale";
  } catch {
    // The claim lease expires and a later run retries with the stored token.
    return "failed";
  }
}

async function recordFailure(deps: RenewalDeps, claim: RenewalClaim, code: RenewalErrorCode, now: () => number): Promise<RenewalResult> {
  const reconnect = code === "token_invalid" ? "expired" : code === "permission_missing" ? "revoked" : null;
  const retryAt = reconnect ? null : new Date(now() + (code === "rate_limited" ? RATE_LIMIT_RETRY_MS : TRANSIENT_RETRY_MS)).toISOString();
  try {
    const recorded = await deps.store.fail(claim, code, retryAt, reconnect);
    if (!recorded) return "stale";
  } catch {
    return "failed";
  }
  return reconnect ? "reconnectRequired" : "retrying";
}

/** Service-role store over the 0068 functions; ciphertext only crosses this boundary. */
export function supabaseRenewalStore(db: SupabaseClient): RenewalStore {
  return {
    async expireLapsed() {
      const { data, error } = await db.rpc("expire_lapsed_instagram_tokens");
      if (error) throw new Error("instagram_renewal_expire_failed");
      return typeof data === "number" ? data : 0;
    },
    async claim(limit, renewBeforeDays, leaseMinutes) {
      const { data, error } = await db.rpc("claim_instagram_token_refreshes", {
        p_limit: limit,
        p_renew_before: `${renewBeforeDays} days`,
        p_lease: `${leaseMinutes} minutes`,
      });
      if (error) throw new Error("instagram_renewal_claim_failed");
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        ownerUserId: String(row.owner_user_id),
        claimId: String(row.claim_id),
        connectedAt: String(row.connected_at),
        tokenExpiresAt: String(row.token_expires_at),
        encryptedToken: String(row.encrypted_access_token),
        iv: String(row.token_iv),
        authTag: String(row.token_auth_tag),
      }));
    },
    async complete(claim, next, expiresAt) {
      const { data, error } = await db.rpc("complete_instagram_token_refresh", {
        p_owner_user_id: claim.ownerUserId,
        p_claim_id: claim.claimId,
        p_connected_at: claim.connectedAt,
        p_encrypted_access_token: next.encryptedToken,
        p_token_iv: next.iv,
        p_token_auth_tag: next.authTag,
        p_key_version: next.keyVersion,
        p_token_expires_at: expiresAt,
      });
      if (error) throw new Error("instagram_renewal_complete_failed");
      return data === true;
    },
    async fail(claim, code, retryAt, connectionStatus) {
      const { data, error } = await db.rpc("fail_instagram_token_refresh", {
        p_owner_user_id: claim.ownerUserId,
        p_claim_id: claim.claimId,
        p_connected_at: claim.connectedAt,
        p_error_code: code,
        p_retry_at: retryAt,
        p_connection_status: connectionStatus,
      });
      if (error) throw new Error("instagram_renewal_fail_failed");
      return data === true;
    },
  };
}
