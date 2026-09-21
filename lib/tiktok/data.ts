import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { decryptTikTokToken, encryptTikTokToken, type TikTokKeyInput } from "./crypto.ts";
import { hasPublishPermission, TIKTOK_SCOPES } from "./scopes.ts";
import type { TikTokClient } from "./client.ts";
import { isTikTokPrivacy } from "./publishing.ts";
import type { TikTokConnectionView } from "./types.ts";

/**
 * The TikTok connection data layer.
 *
 * Security properties (mirroring the proven YouTube layer):
 *   - OAuth state is 256 bits of CSPRNG output, stored ONLY as a SHA-256
 *     hash, bound to the owner, single-use and expiring after 10 minutes.
 *     The callback must present the exact state AND the matching httpOnly
 *     cookie value (compared in constant time), so a state from another
 *     owner's flow — or a replayed one — can never complete a connection.
 *   - tokens exist only as AES-256-GCM ciphertext in the database; the
 *     plaintext never leaves this module, never reaches the browser, and is
 *     never written to a log or an error message.
 *   - refresh happens server-side on demand. TikTok may ROTATE the refresh
 *     token on refresh — the freshly returned value is always the one that
 *     gets persisted. A refresh TikTok rejects marks the connection
 *     `revoked` — the truthful state — instead of pretending access
 *     continues.
 */

const OAUTH_TTL_MS = 10 * 60 * 1000;
/** Refresh slightly before the real expiry (24h access tokens) so a call never races it. */
const REFRESH_SKEW_MS = 60 * 1000;

export async function getTikTokConnection(
  db: SupabaseClient,
  ownerId: string,
  configured: boolean,
  appAudited: boolean,
): Promise<TikTokConnectionView> {
  const { data, error } = await db.from("tiktok_connections")
    .select("open_id,display_name,avatar_url,creator_username,scopes,status,access_token_expires_at,refresh_token_expires_at,default_privacy,last_synced_at,connected_at")
    .eq("owner_user_id", ownerId).maybeSingle();
  if (error) throw new Error("tiktok_connection_read_failed");
  if (!data) {
    return {
      connected: false, configured, status: "not_connected",
      openId: null, displayName: null, avatarUrl: null, creatorUsername: null,
      scopes: [], accessTokenExpiresAt: null, refreshTokenExpiresAt: null,
      defaultPrivacy: null, appAudited, lastSyncedAt: null, connectedAt: null,
    };
  }
  const row = data as Record<string, unknown>;
  const privacy = row.default_privacy;
  return {
    connected: row.status === "connected",
    configured,
    status: row.status as TikTokConnectionView["status"],
    openId: row.open_id ? String(row.open_id) : null,
    displayName: row.display_name ? String(row.display_name) : null,
    avatarUrl: row.avatar_url ? String(row.avatar_url) : null,
    creatorUsername: row.creator_username ? String(row.creator_username) : null,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    accessTokenExpiresAt: row.access_token_expires_at ? String(row.access_token_expires_at) : null,
    refreshTokenExpiresAt: row.refresh_token_expires_at ? String(row.refresh_token_expires_at) : null,
    defaultPrivacy: typeof privacy === "string" && isTikTokPrivacy(privacy) ? privacy : null,
    appAudited,
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    connectedAt: row.connected_at ? String(row.connected_at) : null,
  };
}

export async function createTikTokOAuthState(db: SupabaseClient, ownerId: string): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const { error } = await db.from("tiktok_oauth_states").insert({
    state_hash: hashState(state),
    owner_user_id: ownerId,
    expires_at: new Date(Date.now() + OAUTH_TTL_MS).toISOString(),
  });
  if (error) throw new Error("tiktok_oauth_state_failed");
  return state;
}

/**
 * Single-use, owner-bound, expiring state consumption. Both the URL state
 * and the httpOnly cookie value must match (constant-time), and the database
 * row must be unconsumed and unexpired — replaying a captured callback URL
 * finds a consumed row and fails.
 */
export async function consumeTikTokOAuthState(
  db: SupabaseClient,
  ownerId: string,
  state: string,
  cookieState: string,
): Promise<boolean> {
  const supplied = Buffer.from(state);
  const cookie = Buffer.from(cookieState);
  if (supplied.length !== cookie.length || !timingSafeEqual(supplied, cookie)) return false;
  const now = new Date().toISOString();
  const { data, error } = await db.from("tiktok_oauth_states").update({ consumed_at: now })
    .eq("state_hash", hashState(state))
    .eq("owner_user_id", ownerId)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .select("state_hash")
    .maybeSingle();
  if (error) throw new Error("tiktok_oauth_state_failed");
  return Boolean(data);
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export interface SaveTikTokConnectionInput {
  ownerId: string;
  /** The authoritative identity TikTok itself returned at token exchange. */
  openId: string;
  displayName: string | null;
  avatarUrl: string | null;
  /** The scopes TikTok ACTUALLY granted (from the token response). */
  grantedScopes: string[];
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt: string | null;
  encryptionKey: TikTokKeyInput;
}

/** Persists a completed authorization: ciphertext in, never plaintext out. */
export async function saveTikTokConnection(db: SupabaseClient, input: SaveTikTokConnectionInput): Promise<void> {
  const refresh = encryptTikTokToken(input.refreshToken, input.encryptionKey);
  const access = encryptTikTokToken(input.accessToken, input.encryptionKey);
  const { error } = await db.rpc("save_tiktok_connection", {
    p_owner_user_id: input.ownerId,
    p_open_id: input.openId,
    p_display_name: input.displayName,
    p_avatar_url: input.avatarUrl,
    p_scopes: input.grantedScopes.length ? input.grantedScopes : [...TIKTOK_SCOPES],
    p_encrypted_refresh_token: refresh.encryptedToken,
    p_refresh_iv: refresh.iv,
    p_refresh_auth_tag: refresh.authTag,
    p_refresh_key_version: refresh.keyVersion,
    p_encrypted_access_token: access.encryptedToken,
    p_access_iv: access.iv,
    p_access_auth_tag: access.authTag,
    p_access_key_version: access.keyVersion,
    p_access_token_expires_at: input.accessTokenExpiresAt,
    p_refresh_token_expires_at: input.refreshTokenExpiresAt,
  });
  if (error) throw new Error("tiktok_connection_save_failed");
}

export interface TikTokServerCredentials {
  openId: string;
  accessToken: string;
  scopes: string[];
}

/**
 * Server-side credentials for one owner, with on-demand refresh.
 *
 * Throwing means "not usable" — callers treat every throw as not-connected
 * and never publish. A TikTok-rejected refresh marks the connection
 * `revoked` so the UI tells the truth and future publishing stops;
 * historical Voom records and the customer's TikTok posts are untouched
 * either way. TikTok may return a NEW refresh token on refresh; the
 * returned value is always the one persisted.
 */
export async function getTikTokServerCredentials(
  db: SupabaseClient,
  ownerId: string,
  encryptionKey: TikTokKeyInput,
  client: TikTokClient,
): Promise<TikTokServerCredentials> {
  const { data, error } = await db.rpc("get_tiktok_connection_secret", { p_owner_user_id: ownerId }).maybeSingle();
  if (error || !data) throw new Error("tiktok_connection_unavailable");
  const secret = data as Record<string, unknown>;
  if (secret.connection_status !== "connected") throw new Error("tiktok_connection_unavailable");
  const scopes = Array.isArray(secret.scopes) ? (secret.scopes as string[]) : [];
  const openId = String(secret.open_id);

  const refreshToken = decryptTikTokToken({
    encryptedToken: String(secret.encrypted_refresh_token),
    iv: String(secret.refresh_iv),
    authTag: String(secret.refresh_auth_tag),
  }, encryptionKey);

  const expiresAt = secret.access_token_expires_at ? Date.parse(String(secret.access_token_expires_at)) : NaN;
  const storedAccess = secret.encrypted_access_token && secret.access_iv && secret.access_auth_tag
    ? decryptTikTokToken({
        encryptedToken: String(secret.encrypted_access_token),
        iv: String(secret.access_iv),
        authTag: String(secret.access_auth_tag),
      }, encryptionKey)
    : null;

  if (storedAccess && Number.isFinite(expiresAt) && expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return { openId, accessToken: storedAccess, scopes };
  }

  // Refresh server-side. This is the ONLY place a refresh token is spent,
  // and the new tokens go straight back into the vault.
  let refreshed;
  try {
    refreshed = await client.refreshAccessToken(refreshToken);
  } catch (cause) {
    if (isAuthFailure(cause)) {
      try { await db.rpc("set_tiktok_connection_status", { p_owner_user_id: ownerId, p_status: "revoked" }); } catch { /* best effort */ }
    }
    throw new Error("tiktok_token_refresh_failed");
  }
  const access = encryptTikTokToken(refreshed.accessToken, encryptionKey);
  const accessExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
  const rotatedRefresh = refreshed.refreshToken && refreshed.refreshToken !== refreshToken
    ? encryptTikTokToken(refreshed.refreshToken, encryptionKey)
    : null;
  try {
    await db.rpc("update_tiktok_tokens", {
      p_owner_user_id: ownerId,
      p_encrypted_access_token: access.encryptedToken,
      p_access_iv: access.iv,
      p_access_auth_tag: access.authTag,
      p_access_key_version: access.keyVersion,
      p_access_token_expires_at: accessExpiresAt,
      p_encrypted_refresh_token: rotatedRefresh ? rotatedRefresh.encryptedToken : null,
      p_refresh_iv: rotatedRefresh ? rotatedRefresh.iv : null,
      p_refresh_auth_tag: rotatedRefresh ? rotatedRefresh.authTag : null,
      p_refresh_key_version: rotatedRefresh ? rotatedRefresh.keyVersion : null,
      p_refresh_token_expires_at: refreshed.refreshExpiresIn
        ? new Date(Date.now() + refreshed.refreshExpiresIn * 1000).toISOString()
        : null,
    });
  } catch {
    // Persisting the refreshed token is an optimization; the in-memory token
    // remains valid for this invocation either way.
  }
  const granted = refreshed.grantedScopes.length ? refreshed.grantedScopes : scopes;
  return { openId: refreshed.openId || openId, accessToken: refreshed.accessToken, scopes: granted };
}

function isAuthFailure(cause: unknown): boolean {
  return Boolean(cause) && typeof cause === "object" && (cause as { kind?: unknown }).kind === "auth";
}

/**
 * Disconnect. Order matters for safety:
 *   1. obtain the current access token (refreshing if needed — this is the
 *      token TikTok's revoke endpoint accepts),
 *   2. destroy the local secrets + mark disconnected (the RPC also withdraws
 *      every queue row that never reached the provider),
 *   3. best-effort explicit revocation at TikTok's revoke endpoint.
 * Local destruction never depends on the remote call succeeding, and nothing
 * here deletes a queue row with provider evidence, a Voom historical record
 * or — anywhere in this integration — a customer's TikTok post.
 */
export async function disconnectTikTok(
  db: SupabaseClient,
  ownerId: string,
  encryptionKey: TikTokKeyInput,
  client: TikTokClient,
): Promise<{ disconnected: boolean; revokedAtTikTok: boolean }> {
  let accessToken: string | null = null;
  try {
    accessToken = (await getTikTokServerCredentials(db, ownerId, encryptionKey, client)).accessToken;
  } catch {
    // Fall back to the stored (possibly expired) access token: revocation is
    // best-effort anyway, and local destruction must not depend on it.
    const { data } = await db.rpc("get_tiktok_connection_secret", { p_owner_user_id: ownerId }).maybeSingle();
    if (data) {
      const secret = data as Record<string, unknown>;
      if (secret.encrypted_access_token && secret.access_iv && secret.access_auth_tag) {
        try {
          accessToken = decryptTikTokToken({
            encryptedToken: String(secret.encrypted_access_token),
            iv: String(secret.access_iv),
            authTag: String(secret.access_auth_tag),
          }, encryptionKey);
        } catch {
          accessToken = null;
        }
      }
    }
  }

  const { data: disconnected, error } = await db.rpc("disconnect_tiktok_connection", { p_owner_user_id: ownerId });
  if (error) throw new Error("tiktok_disconnect_failed");

  const revokedAtTikTok = accessToken ? await client.revokeAccessToken(accessToken) : false;
  return { disconnected: Boolean(disconnected), revokedAtTikTok };
}

/** Whether the connection can truthfully publish right now. */
export function canPublishWith(view: TikTokConnectionView): boolean {
  return view.connected && hasPublishPermission(view.scopes);
}
