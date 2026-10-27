import "server-only";

/** Temporary, fixed-target diagnostic. Remove after the authorized verification. */
export const REFRESH_DIAGNOSTIC = {
  owner: "42162404-fef3-4c78-9f2d-7e777102dabf",
  email: "aman@synrapay.com",
  connection: "a848fe88-ec9e-4538-8b2c-57065953db8f",
  channel: "UCu-w6MsEMDLWNn5Pkobg1Yw",
  handle: "@pavjassinghsehgal8524",
  connectedAt: Date.parse("2026-09-21T13:48:37.063174Z"),
  expiresAt: Date.parse("2026-10-29T00:00:00Z"),
  project: "https://spqkkbznzxxkdtexyqzh.supabase.co",
  origin: "https://voom.today",
  confirmation: "refresh-existing-youtube-authorization-once",
} as const;
export const UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";

export interface DiagnosticConnection {
  id: string; owner_user_id: string; channel_id: string; channel_handle: string | null;
  connected_at: string; status: string; scopes: string[]; access_token_expires_at: string | null;
}
export interface RefreshResult {
  requests: number; accepted: boolean; persisted: boolean; scopes: string[];
  scopeEvidence: "refresh_response" | "existing_grant";
  providerError: "invalid_grant" | "invalid_client" | "unauthorized_client" | "other" | null;
}
export interface DiagnosticPorts {
  now(): number;
  environment: string | undefined;
  projectUrl: string | undefined;
  authenticate(): Promise<{ id: string; email?: string | null } | null>;
  /** Must use the signed-in user's RLS client, not a privileged lookup. */
  connection(owner: string): Promise<DiagnosticConnection | null>;
  configured(): boolean;
  claim(): Promise<boolean>;
  refresh(): Promise<RefreshResult>;
}
const json = (body: object, status = 200) => Response.json(body, { status,
  headers: { "Cache-Control": "no-store, private", "Pragma": "no-cache" } });

export async function handleRefreshDiagnostic(request: Request, ports: DiagnosticPorts): Promise<Response> {
  const target = REFRESH_DIAGNOSTIC;
  if (ports.environment !== "production" || ports.projectUrl !== target.project || ports.now() >= target.expiresAt) {
    return json({ error: "Diagnostic unavailable." }, 404);
  }
  if (request.method !== "POST") return json({ error: "POST required." }, 405);
  // A missing Origin is not accepted, including CLI/admin bearer invocations.
  if (new URL(request.url).origin !== target.origin || request.headers.get("origin") !== target.origin
    || request.headers.get("sec-fetch-site") === "cross-site") return json({ error: "Invalid origin." }, 403);
  try {
    const user = await ports.authenticate();
    if (!user) return json({ error: "Sign in as the connection owner." }, 401);
    if (user.id !== target.owner || user.email?.toLowerCase() !== target.email) return json({ error: "Owner access required." }, 403);
    if (request.headers.get("content-type")?.split(";")[0] !== "application/json") return json({ error: "Confirmation required." }, 400);
    // Fixed, small body: no account selectors, arbitrary scopes or provider URLs.
    const text = await request.text();
    if (text.length > 128) return json({ error: "Invalid confirmation." }, 400);
    const body = JSON.parse(text) as Record<string, unknown>;
    if (!body || Object.keys(body).length !== 1 || body.confirm !== target.confirmation) return json({ error: "Confirmation required." }, 400);
    const connection = await ports.connection(user.id);
    if (!matchesDiagnosticTarget(connection) || connection.status !== "connected" || !connection.scopes.includes(UPLOAD_SCOPE)) {
      return json({ error: "The original authorized connection is unavailable." }, 409);
    }
    if (!ports.configured()) return json({ error: "Secure refresh configuration unavailable." }, 503);
    if (Date.parse(connection.access_token_expires_at ?? "") > ports.now() + 60_000) {
      return json({ outcome: "already_current", refreshRequests: 0, uploadPermission: true, scopeEvidence: "existing_grant" });
    }
    // Server-only unique marker is committed before any Google request. An
    // uncertain insert or provider result NEVER authorizes another attempt.
    if (!await ports.claim()) return json({ error: "This one-shot diagnostic was already consumed. Do not retry.", retryAllowed: false }, 409);
    const result = await ports.refresh();
    const base = { refreshRequests: result.requests, retryAllowed: false };
    if (!result.accepted) {
      return json({ ...base, outcome: result.providerError === "invalid_grant" ? "reconnect_required" : "refresh_unconfirmed",
        reconnectionRequired: result.providerError === "invalid_grant" ? true : null,
        providerError: result.providerError }, 409);
    }
    const after = await ports.connection(user.id);
    if (!result.persisted || !matchesDiagnosticTarget(after) || after.status !== "connected"
      || !(Date.parse(after.access_token_expires_at ?? "") > ports.now() + 60_000)) {
      return json({ ...base, outcome: "storage_unconfirmed", reconnectionRequired: null }, 503);
    }
    if (!result.scopes.includes(UPLOAD_SCOPE)) return json({ ...base, outcome: "upload_permission_missing", reconnectionRequired: true }, 409);
    return json({ ...base, outcome: "refreshed", reconnectionRequired: false, uploadPermission: true,
      scopeEvidence: result.scopeEvidence, expiresAt: after.access_token_expires_at });
  } catch {
    // Never reflect exceptions, RPC errors or Google's response bodies.
    return json({ error: "Diagnostic could not be confirmed. Do not retry; inspect connection status.", retryAllowed: false }, 503);
  }
}

export function matchesDiagnosticTarget(row: DiagnosticConnection | null): row is DiagnosticConnection {
  const t = REFRESH_DIAGNOSTIC;
  return !!row && row.id === t.connection && row.owner_user_id === t.owner && row.channel_id === t.channel
    && row.channel_handle === t.handle && Date.parse(row.connected_at) === t.connectedAt;
}
