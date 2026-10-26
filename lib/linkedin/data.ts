import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { encryptLinkedInToken, decryptLinkedInToken } from "./crypto.ts";
import { LinkedInError } from "./client.ts";

export interface LinkedInConnectionView {
  configured: boolean; connected: boolean; id: string | null; memberSub: string | null;
  displayName: string | null; status: string; expiresAt: string | null;
}
export async function getLinkedInConnection(db: SupabaseClient, ownerId: string, configured: boolean): Promise<LinkedInConnectionView> {
  const empty: LinkedInConnectionView = { configured, connected: false, id: null, memberSub: null, displayName: null,
    status: configured ? "disconnected" : "not_configured", expiresAt: null };
  if (!configured) return empty;
  const { data, error } = await db.from("linkedin_connections")
    .select("id,member_sub,display_name,scopes,status,token_expires_at").eq("owner_user_id", ownerId).maybeSingle();
  if (error) throw new Error("linkedin_connection_read_failed");
  if (!data) return empty;
  const valid = Number.isFinite(Date.parse(data.token_expires_at)) && Date.parse(data.token_expires_at) > Date.now() + 60_000;
  return { configured, connected: data.status === "connected" && valid && data.scopes.includes("w_member_social"),
    id: data.id, memberSub: data.member_sub, displayName: data.display_name,
    status: data.status === "connected" && !valid ? "expired" : data.status, expiresAt: data.token_expires_at };
}
export async function createLinkedInState(db: SupabaseClient, ownerId: string): Promise<string> {
  const { data: business, error: lookupError } = await db.from("businesses").select("id").eq("owner_user_id", ownerId).single();
  if (lookupError || !business) throw new Error("linkedin_business_required");
  const state = randomBytes(32).toString("base64url");
  const { error } = await db.from("linkedin_oauth_states").insert({ owner_user_id: ownerId, business_id: business.id,
    state_hash: createHash("sha256").update(state).digest("hex") });
  if (error) throw new Error("linkedin_oauth_unavailable");
  return state;
}
export async function consumeLinkedInState(db: SupabaseClient, ownerId: string, state: string, cookieState: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(state) || !/^[A-Za-z0-9_-]{43}$/.test(cookieState)
    || !timingSafeEqual(Buffer.from(state), Buffer.from(cookieState))) return null;
  const { data, error } = await db.rpc("consume_linkedin_oauth_state", { p_owner: ownerId,
    p_hash: createHash("sha256").update(state).digest("hex") });
  if (error) throw new Error("linkedin_oauth_unavailable");
  return typeof data === "string" ? data : null;
}
export async function saveLinkedInConnection(db: SupabaseClient, input: {
  ownerId: string; businessId: string; memberSub: string; displayName: string; scopes: string[];
  accessToken: string; expiresIn: number; encryptionKey: string;
  state: string;
}) {
  const { error } = await db.rpc("save_linkedin_connection", { p_owner: input.ownerId, p_business: input.businessId,
    p_member: input.memberSub, p_name: input.displayName, p_scopes: input.scopes,
    p_expiry: new Date(Date.now() + input.expiresIn * 1000).toISOString(),
    p_encrypted_token: encryptLinkedInToken(input.accessToken, input.encryptionKey, input.ownerId),
    p_state_hash: createHash("sha256").update(input.state).digest("hex") });
  if (error?.code === "23505") throw new Error("linkedin_already_linked");
  if (error) throw new Error("linkedin_save_failed");
}
export async function linkedInCredentials(db: SupabaseClient, ownerId: string, connectionId: string, memberSub: string, key: string) {
  const { data: connection, error } = await db.from("linkedin_connections").select("id,status,scopes,token_expires_at,member_sub")
    .eq("owner_user_id", ownerId).eq("id", connectionId).maybeSingle();
  if (error) throw new LinkedInError("unavailable");
  if (!connection || connection.status !== "connected" || connection.member_sub !== memberSub
    || !connection.scopes.includes("w_member_social") || !(Date.parse(connection.token_expires_at) > Date.now() + 60_000)) throw new LinkedInError("reconnect");
  const { data: secret, error: secretError } = await db.from("linkedin_connection_secrets")
    .select("encrypted_access_token").eq("connection_id", connection.id).maybeSingle();
  if (secretError || !secret) throw new LinkedInError("unavailable");
  try { return decryptLinkedInToken(secret.encrypted_access_token, key, ownerId); }
  catch { throw new LinkedInError("reconnect"); }
}
