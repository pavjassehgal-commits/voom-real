import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { encryptYouTubeToken, decryptYouTubeToken, type YouTubeKeyInput } from "./crypto.ts";
import { YOUTUBE_SCOPES, hasUploadPermission } from "./scopes.ts";
import type { YouTubeClient } from "./client.ts";
import type { YouTubeConnectionView } from "./types.ts";
import { assertYouTubeGrant, confirmedYouTubeAuthorizationLoss, eraseYouTubeData, retryYouTubeRevocations } from "./privacy.ts";

/**
 * The YouTube connection data layer.
 *
 * Security properties (mirroring the proven Instagram layer):
 *   - OAuth state is 256 bits of CSPRNG output, stored ONLY as a SHA-256
 *     hash, bound to the owner, single-use and expiring after 10 minutes.
 *     The callback must present the exact state AND the matching httpOnly
 *     cookie value (compared in constant time), so a state from another
 *     owner's flow — or a replayed one — can never complete a connection.
 *   - tokens exist only as AES-256-GCM ciphertext in the database; the
 *     plaintext never leaves this module, never reaches the browser, and is
 *     never written to a log or an error message.
 *   - refresh happens server-side on demand; a refresh Google rejects with
 *     invalid_grant blocks access and erases derived data instead of
 *     retaining an indefinitely revoked connection (migration 0065).
 */

const OAUTH_TTL_MS = 10 * 60 * 1000;
/** Refresh slightly before the real expiry so a call never races it. */
const REFRESH_SKEW_MS = 60 * 1000;

export async function getYouTubeConnection(
  db: SupabaseClient,
  ownerId: string,
  configured: boolean,
  projectAudited: boolean,
): Promise<YouTubeConnectionView> {
  const { data, error } = await db.from("youtube_connections")
    .select("channel_id,channel_title,channel_handle,thumbnail_url,scopes,status,access_token_expires_at,default_privacy,default_made_for_kids,last_synced_at,connected_at")
    .eq("owner_user_id", ownerId).maybeSingle();
  if (error) throw new Error("youtube_connection_read_failed");
  if (!data) {
    return {
      connected: false, configured, status: "not_connected", channelId: null, channelTitle: null,
      channelHandle: null, thumbnailUrl: null, scopes: [], accessTokenExpiresAt: null,
      defaultPrivacy: null, defaultMadeForKids: null, projectAudited, lastSyncedAt: null, connectedAt: null,
    };
  }
  const row = data as Record<string, unknown>;
  const privacy = row.default_privacy;
  const madeForKids = row.default_made_for_kids;
  return {
    connected: row.status === "connected",
    configured,
    status: row.status as YouTubeConnectionView["status"],
    channelId: row.channel_id ? String(row.channel_id) : null,
    channelTitle: row.channel_title ? String(row.channel_title) : null,
    channelHandle: row.channel_handle ? String(row.channel_handle) : null,
    thumbnailUrl: row.thumbnail_url ? String(row.thumbnail_url) : null,
    scopes: Array.isArray(row.scopes) ? (row.scopes as string[]) : [],
    accessTokenExpiresAt: row.access_token_expires_at ? String(row.access_token_expires_at) : null,
    defaultPrivacy: privacy === "public" || privacy === "private" || privacy === "unlisted" ? privacy : null,
    defaultMadeForKids: typeof madeForKids === "boolean" ? madeForKids : null,
    projectAudited,
    lastSyncedAt: row.last_synced_at ? String(row.last_synced_at) : null,
    connectedAt: row.connected_at ? String(row.connected_at) : null,
  };
}

export async function createYouTubeOAuthState(db: SupabaseClient, ownerId: string): Promise<string> {
  const state = randomBytes(32).toString("base64url");
  const { error } = await db.from("youtube_oauth_states").insert({
    state_hash: hashState(state),
    owner_user_id: ownerId,
    expires_at: new Date(Date.now() + OAUTH_TTL_MS).toISOString(),
  });
  if (error) throw new Error("youtube_oauth_state_failed");
  return state;
}

/**
 * Single-use, owner-bound, expiring state consumption. Both the URL state
 * and the httpOnly cookie value must match (constant-time), and the database
 * row must be unconsumed and unexpired — replaying a captured callback URL
 * finds a consumed row and fails.
 */
export async function consumeYouTubeOAuthState(
  db: SupabaseClient,
  ownerId: string,
  state: string,
  cookieState: string,
): Promise<boolean> {
  const supplied = Buffer.from(state);
  const cookie = Buffer.from(cookieState);
  if (supplied.length !== cookie.length || !timingSafeEqual(supplied, cookie)) return false;
  const now = new Date().toISOString();
  const { data, error } = await db.from("youtube_oauth_states").update({ consumed_at: now })
    .eq("state_hash", hashState(state))
    .eq("owner_user_id", ownerId)
    .is("consumed_at", null)
    .gt("expires_at", now)
    .select("state_hash")
    .maybeSingle();
  if (error) throw new Error("youtube_oauth_state_failed");
  return Boolean(data);
}

function hashState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export interface SaveYouTubeConnectionInput {
  ownerId: string;
  channelId: string;
  channelTitle: string | null;
  channelHandle: string | null;
  thumbnailUrl: string | null;
  /** The scopes Google ACTUALLY granted (from the token response). */
  grantedScopes: string[];
  refreshToken: string;
  accessToken: string;
  accessTokenExpiresAt: string;
  encryptionKey: YouTubeKeyInput;
  oauthState?: string;
}

/** Persists a completed authorization: ciphertext in, never plaintext out. */
export async function saveYouTubeConnection(db: SupabaseClient, input: SaveYouTubeConnectionInput): Promise<void> {
  const refresh = encryptYouTubeToken(input.refreshToken, input.encryptionKey);
  const access = encryptYouTubeToken(input.accessToken, input.encryptionKey);
  const { error } = await db.rpc("save_youtube_connection", {
    p_owner_user_id: input.ownerId,
    p_channel_id: input.channelId,
    p_channel_title: input.channelTitle,
    p_channel_handle: input.channelHandle,
    p_thumbnail_url: input.thumbnailUrl,
    p_scopes: input.grantedScopes.length ? input.grantedScopes : [...YOUTUBE_SCOPES],
    p_encrypted_refresh_token: refresh.encryptedToken,
    p_refresh_iv: refresh.iv,
    p_refresh_auth_tag: refresh.authTag,
    p_refresh_key_version: refresh.keyVersion,
    p_encrypted_access_token: access.encryptedToken,
    p_access_iv: access.iv,
    p_access_auth_tag: access.authTag,
    p_access_key_version: access.keyVersion,
    p_access_token_expires_at: input.accessTokenExpiresAt,
    ...(input.oauthState ? { p_state_hash: hashState(input.oauthState) } : {}),
  });
  if (error) throw new Error("youtube_connection_save_failed");
}

export interface YouTubeServerCredentials {
  channelId: string;
  accessToken: string;
  scopes: string[];
  uploadsPlaylistId?: string | null;
  authorizationEpoch: string;
}

/**
 * Server-side credentials for one owner, with on-demand refresh.
 *
 * Throwing means "not usable" — callers treat every throw as not-connected
 * and never publish. A Google-rejected refresh (invalid_grant) erases the
 * matching grant's API data. Original drafts/media and remote YouTube
 * videos are never deleted by this credential path.
 */
export async function getYouTubeServerCredentials(
  db: SupabaseClient,
  ownerId: string,
  encryptionKey: YouTubeKeyInput,
  client: YouTubeClient,
): Promise<YouTubeServerCredentials> {
  const authorizationEpoch = await assertYouTubeGrant(db,ownerId);
  const { data, error } = await db.rpc("get_youtube_connection_secret", { p_owner_user_id: ownerId }).maybeSingle();
  if (error || !data) throw new Error("youtube_connection_unavailable");
  const secret = data as Record<string, unknown>;
  if (secret.connection_status !== "connected") throw new Error("youtube_connection_unavailable");
  await assertYouTubeGrant(db,ownerId,authorizationEpoch);
  const scopes = Array.isArray(secret.scopes) ? (secret.scopes as string[]) : [];

  const refreshToken = decryptYouTubeToken({
    encryptedToken: String(secret.encrypted_refresh_token),
    iv: String(secret.refresh_iv),
    authTag: String(secret.refresh_auth_tag),
  }, encryptionKey);

  const expiresAt = secret.access_token_expires_at ? Date.parse(String(secret.access_token_expires_at)) : NaN;
  const storedAccess = secret.encrypted_access_token && secret.access_iv && secret.access_auth_tag
    ? decryptYouTubeToken({
        encryptedToken: String(secret.encrypted_access_token),
        iv: String(secret.access_iv),
        authTag: String(secret.access_auth_tag),
      }, encryptionKey)
    : null;

  if (storedAccess && Number.isFinite(expiresAt) && expiresAt - REFRESH_SKEW_MS > Date.now()) {
    return { channelId: String(secret.channel_id), accessToken: storedAccess, scopes, authorizationEpoch };
  }

  // Refresh server-side. This is the ONLY place a refresh token is spent,
  // and the new access token goes straight back into the vault.
  let refreshed;
  try {
    refreshed = await client.refreshAccessToken(refreshToken);
  } catch (cause) {
    if (confirmedYouTubeAuthorizationLoss(cause)) {
      await eraseYouTubeData(db,ownerId,false,authorizationEpoch);
    }
    throw new Error("youtube_token_refresh_failed");
  }
  await assertYouTubeGrant(db,ownerId,authorizationEpoch);
  const access = encryptYouTubeToken(refreshed.accessToken, encryptionKey);
  const accessExpiresAt = new Date(Date.now() + refreshed.expiresIn * 1000).toISOString();
  {
    const saved = await db.rpc("update_youtube_access_token", {
      p_owner_user_id: ownerId,
      p_encrypted_access_token: access.encryptedToken,
      p_access_iv: access.iv,
      p_access_auth_tag: access.authTag,
      p_access_key_version: access.keyVersion,
      p_access_token_expires_at: accessExpiresAt,
      p_expected_epoch: authorizationEpoch,
    });
    if (saved.error || saved.data !== true) throw new Error("youtube_token_refresh_storage_failed");
  }
  const granted = refreshed.grantedScopes.length ? refreshed.grantedScopes : scopes;
  return { channelId: String(secret.channel_id), accessToken: refreshed.accessToken, scopes: granted, authorizationEpoch };
}

/**
 * Disconnect. Order matters for safety:
 *   1. commit an owner-scoped access barrier,
 *   2. erase API-derived data and isolate one encrypted revocation task,
 *   3. immediately attempt Google revocation, durably retrying outages.
 * No remote video-delete API is involved; original drafts/media survive.
 */
export async function disconnectYouTube(
  db: SupabaseClient,
  ownerId: string,
  encryptionKey: YouTubeKeyInput,
  client: YouTubeClient,
): Promise<{ disconnected: boolean; revokedAtGoogle: boolean }> {
  const receipt = await eraseYouTubeData(db,ownerId);
  const revocation = await retryYouTubeRevocations(db,encryptionKey,client,ownerId);
  return { disconnected: true, revokedAtGoogle: !receipt.revocationPending || revocation.completed > 0 };
}

/** Whether the connection can truthfully publish right now. */
export function canPublishWith(view: YouTubeConnectionView): boolean {
  return view.connected && hasUploadPermission(view.scopes);
}
