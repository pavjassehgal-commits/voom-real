import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  CURRENT_KEY_VERSION,
  encryptInstagramToken,
  inspectStoredToken,
  decryptInstagramToken,
  type InstagramKeyRing,
} from "./crypto.ts";

/**
 * Instagram token encryption-key rotation.
 *
 * Re-encrypts stored Instagram access tokens from a legacy key onto the current
 * primary key, without ever changing account metadata, scopes or status.
 *
 * Safety properties:
 *  - Idempotent. A row already readable with the primary key is reported as
 *    `alreadyCurrent` and left completely untouched.
 *  - Non-destructive. A row that no key can decrypt is reported as `failed` and
 *    left EXACTLY as it was. Rotation never deletes or overwrites a token it
 *    could not first read.
 *  - Verified. Every re-encrypted value is decrypted back and compared to the
 *    original plaintext BEFORE it is written. A bad write is impossible.
 *  - Silent about secrets. Counts and owner ids only — never token plaintext,
 *    never ciphertext, never key material.
 */

export interface RotationOutcome {
  scanned: number;
  migrated: number;
  alreadyCurrent: number;
  failed: number;
  /** Owner ids only, so an operator can investigate without exposing secrets. */
  failedOwnerIds: string[];
}

export interface RotationRow {
  ownerUserId: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
}

export type RotationRowResult = "migrated" | "alreadyCurrent" | "failed";

/**
 * Decides what should happen to one row and produces the replacement payload.
 * Pure: no database, no environment. This is the part worth unit testing hard.
 */
export function planRowRotation(
  row: RotationRow,
  keyRing: InstagramKeyRing,
): { result: RotationRowResult; next?: { encryptedToken: string; iv: string; authTag: string; keyVersion: number } } {
  const stored = { encryptedToken: row.encryptedToken, iv: row.iv, authTag: row.authTag };
  const inspection = inspectStoredToken(stored, keyRing);

  // Unreadable by every key we hold. Leave it strictly alone.
  if (!inspection.readable) return { result: "failed" };

  // Already on the primary key AND already self-describing: nothing to do.
  // This is what makes a second run a no-op.
  if (inspection.usesPrimary && inspection.declaredVersion === CURRENT_KEY_VERSION) {
    return { result: "alreadyCurrent" };
  }

  let plaintext: string;
  try {
    plaintext = decryptInstagramToken(stored, keyRing);
  } catch {
    return { result: "failed" };
  }

  const next = encryptInstagramToken(plaintext, keyRing);

  // Verify the new ciphertext round-trips under the primary key alone before
  // anyone is allowed to write it.
  let verified: string;
  try {
    verified = decryptInstagramToken(
      { encryptedToken: next.encryptedToken, iv: next.iv, authTag: next.authTag },
      { primary: keyRing.primary, legacy: [] },
    );
  } catch {
    return { result: "failed" };
  }
  if (verified !== plaintext) return { result: "failed" };

  return {
    result: "migrated",
    next: { encryptedToken: next.encryptedToken, iv: next.iv, authTag: next.authTag, keyVersion: next.keyVersion },
  };
}

export interface RotationStore {
  /** Every stored secret, owner-scoped. Service-role/security-definer only. */
  listRows(): Promise<RotationRow[]>;
  /** Replaces only the ciphertext columns for one owner. */
  writeRow(ownerUserId: string, next: { encryptedToken: string; iv: string; authTag: string; keyVersion: number }): Promise<void>;
}

/** Runs the rotation over every stored connection. */
export async function rotateInstagramTokens(store: RotationStore, keyRing: InstagramKeyRing): Promise<RotationOutcome> {
  const rows = await store.listRows();
  const outcome: RotationOutcome = { scanned: rows.length, migrated: 0, alreadyCurrent: 0, failed: 0, failedOwnerIds: [] };

  for (const row of rows) {
    const plan = planRowRotation(row, keyRing);
    if (plan.result === "alreadyCurrent") {
      outcome.alreadyCurrent += 1;
      continue;
    }
    if (plan.result === "failed" || !plan.next) {
      outcome.failed += 1;
      outcome.failedOwnerIds.push(row.ownerUserId);
      continue;
    }
    try {
      await store.writeRow(row.ownerUserId, plan.next);
      outcome.migrated += 1;
    } catch {
      // A write failure leaves the original row intact; it will be retried on
      // the next run. Never surface the underlying database error.
      outcome.failed += 1;
      outcome.failedOwnerIds.push(row.ownerUserId);
    }
  }
  return outcome;
}

/**
 * The production store. Both calls go through service-role-only
 * security-definer RPCs, because 0005 deliberately revokes direct
 * service_role access to instagram_connection_secrets.
 */
export function createRotationStore(db: SupabaseClient): RotationStore {
  return {
    async listRows() {
      const { data, error } = await db.rpc("list_instagram_connection_secrets");
      if (error) throw new Error("instagram_rotation_read_failed");
      return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
        ownerUserId: String(row.owner_user_id),
        encryptedToken: String(row.encrypted_access_token),
        iv: String(row.token_iv),
        authTag: String(row.token_auth_tag),
      }));
    },
    async writeRow(ownerUserId, next) {
      const { error } = await db.rpc("update_instagram_connection_secret", {
        p_owner_user_id: ownerUserId,
        p_encrypted_access_token: next.encryptedToken,
        p_token_iv: next.iv,
        p_token_auth_tag: next.authTag,
        p_key_version: next.keyVersion,
      });
      if (error) throw new Error("instagram_rotation_write_failed");
    },
  };
}
