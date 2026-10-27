import "server-only";
import { createHash } from "node:crypto";
import { createClient } from "@/utils/supabase/server";
import { createAdminClient } from "@/utils/supabase/admin";
import { readYouTubeConfig, youTubeKeyRing } from "./config";
import { getYouTubeServerCredentials } from "./data";
import { YouTubeClient } from "./client";
import { handleRefreshDiagnostic, matchesDiagnosticTarget, REFRESH_DIAGNOSTIC as target, type DiagnosticConnection, type RefreshResult } from "./refresh-diagnostic";

// Not a valid raw OAuth state (it contains ':' and exceeds 43 characters).
// Existing OAuth consumers therefore cannot use or clear this consumed marker.
export const DIAGNOSTIC_MARKER = createHash("sha256")
  .update(`voom:youtube:refresh-diagnostic:${target.connection}:${target.expiresAt}`).digest("hex");

export async function runOwnerRefreshDiagnostic(request: Request) {
  let userDb: Awaited<ReturnType<typeof createClient>> | undefined;
  let admin: ReturnType<typeof createAdminClient> | undefined;
  async function connection(owner: string): Promise<DiagnosticConnection | null> {
    if (!userDb || owner !== target.owner) return null;
    const { data, error } = await userDb.from("youtube_connections")
      .select("id,owner_user_id,channel_id,channel_handle,connected_at,status,scopes,access_token_expires_at")
      .eq("owner_user_id", owner).eq("id", target.connection).maybeSingle();
    if (error) throw new Error("connection_unavailable");
    return data as DiagnosticConnection | null;
  }
  async function requireOriginalConnection() {
    const row = await connection(target.owner);
    if (!matchesDiagnosticTarget(row) || row.status !== "connected") throw new Error("original_connection_changed");
  }
  return handleRefreshDiagnostic(request, {
    now: Date.now, environment: process.env.VERCEL_ENV, projectUrl: process.env.NEXT_PUBLIC_SUPABASE_URL,
    async authenticate() {
      userDb = await createClient();
      // Ask Supabase Auth to verify the actual user; never use admin auth or a
      // client-supplied owner ID, email, bearer override, or impersonation.
      const { data, error } = await userDb.auth.getUser();
      return error ? null : data.user;
    },
    connection,
    configured: () => !!readYouTubeConfig(),
    async claim() {
      // Privileged access is only the normal server-only vault path, AFTER
      // actual owner authentication and an RLS-protected ownership lookup.
      admin = createAdminClient();
      const { error } = await admin.from("youtube_oauth_states").insert({
        owner_user_id: target.owner, state_hash: DIAGNOSTIC_MARKER,
        consumed_at: new Date().toISOString(), expires_at: new Date(target.expiresAt).toISOString(),
      });
      if (error?.code === "23505") return false;
      if (error) throw new Error("one_shot_claim_unconfirmed");
      return true;
    },
    async refresh() {
      if (!admin) throw new Error("one_shot_claim_required");
      const config = readYouTubeConfig();
      if (!config) throw new Error("configuration_unavailable");
      const result: RefreshResult = { requests: 0, accepted: false, persisted: false, scopes: [],
        scopeEvidence: "existing_grant", providerError: null };
      const transport: typeof fetch = async (input, init) => {
        if (String(input) !== "https://oauth2.googleapis.com/token" || init?.method !== "POST"
          || !(init.body instanceof URLSearchParams) || init.body.get("grant_type") !== "refresh_token"
          || result.requests !== 0) throw new Error("diagnostic_request_not_allowed");
        await requireOriginalConnection();
        result.requests += 1;
        const response = await fetch(input, { ...init, redirect: "error" });
        const body = await response.clone().json().catch(() => null) as { error?: unknown; scope?: unknown } | null;
        if (response.ok) {
          result.accepted = true;
          if (typeof body?.scope === "string" && body.scope.trim()) result.scopeEvidence = "refresh_response";
        } else {
          result.providerError = body?.error === "invalid_grant" || body?.error === "invalid_client" || body?.error === "unauthorized_client"
            ? body.error : "other";
        }
        return response;
      };
      const db = admin;
      // Observe the existing encrypted persistence RPC, without changing its
      // behavior or exposing the resulting access token outside this closure.
      const trackedDb = new Proxy(db, { get(object, key) {
        if (key !== "rpc") throw new Error("diagnostic_database_action_not_allowed");
        return (name: string, args: Record<string, unknown>) => {
          if (args.p_owner_user_id !== target.owner || !["get_youtube_connection_secret", "update_youtube_access_token", "set_youtube_connection_status"].includes(name)) {
            throw new Error("diagnostic_database_action_not_allowed");
          }
          const rpc = object.rpc(name, args);
          if (name === "get_youtube_connection_secret") return { async maybeSingle() {
            const response = await rpc.maybeSingle();
            const secret = response.data as Record<string, unknown> | null;
            if (secret && secret.channel_id !== target.channel) throw new Error("original_channel_changed");
            return response;
          } };
          return requireOriginalConnection().then(async () => {
            const response = await rpc;
            if (name === "update_youtube_access_token") result.persisted = !response.error && response.data === true;
            return response;
          });
        };
      } });
      try {
        const credentials = await getYouTubeServerCredentials(trackedDb, target.owner, youTubeKeyRing(config), new YouTubeClient(config, transport));
        result.scopes = credentials.scopes;
      } catch { /* Fixed allowlisted outcome only. Existing logic handles invalid_grant. */ }
      return result;
    },
  });
}
