import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  STAGED_KEY_VERSION,
  decryptInstagramToken,
  encryptInstagramTokenForStagedRotation,
  inspectStoredToken,
  toKeyRing,
  type EncryptedInstagramToken,
  type InstagramKeyRing,
} from "./crypto.ts";

/**
 * Staged Instagram token encryption-key rotation.
 *
 * PRIMARY remains the normal write key. The job reads with the complete
 * PRIMARY -> NEXT -> LEGACY ring but re-encrypts with NEXT specifically. Each
 * replacement is authenticated and compared with the source plaintext under
 * NEXT alone before the existing single-row RPC is allowed to write it.
 */

export interface RotationOutcome {
  scanned: number;
  migratable: number;
  migrated: number;
  alreadyOnNext: number;
  failed: number;
}

export interface RotationRow {
  ownerUserId: string;
  encryptedToken: string;
  iv: string;
  authTag: string;
  keyVersion: number;
}

/** Allowlists the only fields the protected endpoint may return. */
export function publicRotationResult(outcome: RotationOutcome, dryRun: boolean) {
  return dryRun
    ? {
        scanned: outcome.scanned,
        migratable: outcome.migratable,
        alreadyOnNext: outcome.alreadyOnNext,
        failed: outcome.failed,
      }
    : {
        scanned: outcome.scanned,
        migrated: outcome.migrated,
        alreadyOnNext: outcome.alreadyOnNext,
        failed: outcome.failed,
      };
}

export type RotationRowResult = "migratable" | "alreadyOnNext" | "failed";

export class InstagramStagedRotationConfigurationError extends Error {
  readonly code = "instagram_staged_rotation_not_configured";
  constructor() {
    super("instagram_staged_rotation_not_configured");
    this.name = "InstagramStagedRotationConfigurationError";
  }
}

function requireNextKey(keyRing: InstagramKeyRing): { ring: InstagramKeyRing & { next: string }; next: string } {
  const ring = toKeyRing(keyRing);
  if (!ring.next) throw new InstagramStagedRotationConfigurationError();
  return { ring: ring as InstagramKeyRing & { next: string }, next: ring.next };
}

/**
 * Plans one row without touching the database.
 *
 * A row counts as already-on-NEXT only when NEXT authenticates it and both its
 * ciphertext marker and database key_version identify staged v3. Thus every
 * row produced by this job is explicit and a second run is a byte-for-byte
 * no-op. An older-format value that happens to use NEXT is safely normalized
 * to the explicit staged format.
 */
export function planRowRotation(
  row: RotationRow,
  keyRing: InstagramKeyRing,
): { result: RotationRowResult; next?: EncryptedInstagramToken } {
  const { ring, next: nextKey } = requireNextKey(keyRing);
  const stored = { encryptedToken: row.encryptedToken, iv: row.iv, authTag: row.authTag };
  const inspection = inspectStoredToken(stored, ring);

  if (!inspection.readable) return { result: "failed" };

  if (
    inspection.usesNext
    && inspection.declaredVersion === STAGED_KEY_VERSION
    && row.keyVersion === STAGED_KEY_VERSION
  ) {
    return { result: "alreadyOnNext" };
  }

  let plaintext: string;
  let next: EncryptedInstagramToken;
  try {
    plaintext = decryptInstagramToken(stored, ring);
    next = encryptInstagramTokenForStagedRotation(plaintext, nextKey);

    // NEXT alone must authenticate the replacement before any write occurs.
    const verified = decryptInstagramToken(
      { encryptedToken: next.encryptedToken, iv: next.iv, authTag: next.authTag },
      nextKey,
    );
    if (verified !== plaintext) return { result: "failed" };
  } catch {
    return { result: "failed" };
  }

  return { result: "migratable", next };
}

export interface RotationStore {
  /** Every stored secret, owner-scoped. Service-role/security-definer only. */
  listRows(): Promise<RotationRow[]>;
  /** Atomically replaces only the ciphertext columns for one owner. */
  writeRow(ownerUserId: string, next: EncryptedInstagramToken): Promise<void>;
}

/**
 * Runs the staged rotation. A dry run executes the full decrypt/encrypt/verify
 * plan but never calls writeRow. Missing NEXT is rejected before reading rows.
 */
export async function rotateInstagramTokens(
  store: RotationStore,
  keyRing: InstagramKeyRing,
  options: { dryRun?: boolean } = {},
): Promise<RotationOutcome> {
  // Validate before listRows so a missing or same-as-PRIMARY target cannot even
  // scan production secrets.
  requireNextKey(keyRing);

  const rows = await store.listRows();
  const outcome: RotationOutcome = {
    scanned: rows.length,
    migratable: 0,
    migrated: 0,
    alreadyOnNext: 0,
    failed: 0,
  };

  for (const row of rows) {
    let plan: ReturnType<typeof planRowRotation>;
    try {
      plan = planRowRotation(row, keyRing);
    } catch {
      outcome.failed += 1;
      continue;
    }

    if (plan.result === "alreadyOnNext") {
      outcome.alreadyOnNext += 1;
      continue;
    }
    if (plan.result === "failed" || !plan.next) {
      outcome.failed += 1;
      continue;
    }
    if (options.dryRun) {
      outcome.migratable += 1;
      continue;
    }

    try {
      // The RPC is one PostgreSQL statement/transaction for this owner. An RPC
      // error rolls back that row and is safely retriable.
      await store.writeRow(row.ownerUserId, plan.next);
      outcome.migrated += 1;
    } catch {
      outcome.failed += 1;
    }
  }
  return outcome;
}

/**
 * Production storage adapter. 0023 is already sufficient: both operations use
 * its service-role-only security-definer RPCs, and no direct secret-table grant
 * or new migration is required.
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
        keyVersion: Number(row.key_version),
      }));
    },
    async writeRow(ownerUserId, next) {
      const { data, error } = await db.rpc("update_instagram_connection_secret", {
        p_owner_user_id: ownerUserId,
        p_encrypted_access_token: next.encryptedToken,
        p_token_iv: next.iv,
        p_token_auth_tag: next.authTag,
        p_key_version: next.keyVersion,
      });
      if (error || data !== true) throw new Error("instagram_rotation_write_failed");
    },
  };
}
