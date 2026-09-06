import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { INSTAGRAM_SCOPES } from "./scopes.ts";
import { encryptInstagramToken, type InstagramKeyInput } from "./crypto.ts";
import { decryptInstagramToken } from "./crypto.ts";
import type { InstagramConnectionView } from "./types.ts";

const OAUTH_TTL_MS = 10 * 60 * 1000;

export async function getInstagramConnection(db: SupabaseClient, ownerId: string, configured: boolean): Promise<InstagramConnectionView> {
  const { data, error } = await db.from("instagram_connections")
    .select("username,display_name,account_type,profile_picture_url,scopes,status,token_expires_at,last_synced_at,connected_at")
    .eq("owner_user_id", ownerId).maybeSingle();
  if (error) throw new Error("instagram_connection_read_failed");
  if (!data) return { connected: false, configured, status: "not_connected", username: null, name: null, accountType: null, profilePictureUrl: null, scopes: [], tokenExpiresAt: null, lastSyncedAt: null, connectedAt: null };
  return {
    connected: data.status === "connected",
    configured,
    status: data.status,
    username: data.username,
    name: data.display_name,
    accountType: data.account_type,
    profilePictureUrl: data.profile_picture_url,
    scopes: Array.isArray(data.scopes) ? data.scopes : [],
    tokenExpiresAt: data.token_expires_at,
    lastSyncedAt: data.last_synced_at,
    connectedAt: data.connected_at,
  };
}

export async function createOAuthState(db: SupabaseClient, ownerId: string) {
  const state = randomBytes(32).toString("base64url");
  const { error } = await db.from("instagram_oauth_states").insert({ state_hash: hashState(state), owner_user_id: ownerId, expires_at: new Date(Date.now() + OAUTH_TTL_MS).toISOString() });
  if (error) throw new Error("instagram_oauth_state_failed");
  return state;
}

export async function consumeOAuthState(db: SupabaseClient, ownerId: string, state: string, cookieState: string) {
  const supplied = Buffer.from(state);
  const cookie = Buffer.from(cookieState);
  if (supplied.length !== cookie.length || !timingSafeEqual(supplied, cookie)) return false;
  const now = new Date().toISOString();
  const { data, error } = await db.from("instagram_oauth_states").update({ consumed_at: now })
    .eq("state_hash", hashState(state)).eq("owner_user_id", ownerId).is("consumed_at", null).gt("expires_at", now)
    .select("state_hash").maybeSingle();
  if (error) throw new Error("instagram_oauth_state_failed");
  return Boolean(data);
}

export async function saveInstagramConnection(db: SupabaseClient, input: { ownerId: string; instagramUserId: string; username: string; name: string | null; accountType: string | null; profilePictureUrl: string | null; accessToken: string; expiresIn: number; encryptionKey: InstagramKeyInput }) {
  const expiresAt = new Date(Date.now() + input.expiresIn * 1000).toISOString();
  const encrypted = encryptInstagramToken(input.accessToken, input.encryptionKey);
  const { error } = await db.rpc("save_instagram_connection", { p_owner_user_id: input.ownerId, p_instagram_user_id: input.instagramUserId, p_username: input.username, p_display_name: input.name, p_account_type: input.accountType, p_profile_picture_url: input.profilePictureUrl, p_scopes: [...INSTAGRAM_SCOPES], p_token_expires_at: expiresAt, p_encrypted_access_token: encrypted.encryptedToken, p_token_iv: encrypted.iv, p_token_auth_tag: encrypted.authTag, p_key_version: encrypted.keyVersion });
  if (error) throw new Error("instagram_connection_save_failed");
}

export async function disconnectInstagramLocally(db: SupabaseClient, ownerId: string) {
  const { data, error } = await db.rpc("disconnect_instagram_connection", { p_owner_user_id: ownerId });
  if (error) throw new Error("instagram_disconnect_failed");
  return Boolean(data);
}

function hashState(state: string) { return createHash("sha256").update(state, "utf8").digest("hex"); }

export async function getInstagramServerCredentials(db: SupabaseClient, ownerId: string, encryptionKey: InstagramKeyInput) {
  const { data, error } = await db.rpc("get_instagram_connection_secret", { p_owner_user_id: ownerId }).maybeSingle();
  if (error || !data) throw new Error("instagram_connection_unavailable");
  const secret = data as Record<string, unknown>;
  if (secret.connection_status !== "connected") throw new Error("instagram_connection_unavailable");
  return {
    userId: String(secret.instagram_user_id),
    accessToken: decryptInstagramToken({
      encryptedToken: String(secret.encrypted_access_token),
      iv: String(secret.token_iv),
      authTag: String(secret.token_auth_tag),
    }, encryptionKey),
    expiresAt: secret.token_expires_at ? String(secret.token_expires_at) : null,
  };
}
