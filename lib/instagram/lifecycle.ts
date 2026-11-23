/**
 * Meta signed-request parsing and HTTP contract for the Instagram deauthorize and
 * data-deletion callbacks. Reused from the audited lifecycle work (4aeac7c).
 * No database access, no logging of requests, identities or secrets.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export type LifecycleKind = "deauthorize" | "deletion";
export interface LifecycleEvent { appId: string; subjectId: string; issuedAt: number | null; kind: LifecycleKind; eventKey: string }
/**
 * appSecret: META_APP_SECRET, which VOOM already uses as the Instagram App Secret for
 * Instagram Login token exchange. Meta does not document which secret signs Instagram
 * Login callbacks, so an optional verification-only fallback (the parent Meta app
 * secret) can be configured without a code change. The fingerprint always uses appSecret.
 */
export interface LifecycleConfig { appId: string; appSecret: string; publicOrigin: string; fallbackSecret?: string; parentAppId?: string }
export interface LifecycleReceipt { confirmation_code: string }
const HEADERS = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
const MAX_BODY = 8192;

export function lifecycleConfig(env: NodeJS.ProcessEnv = process.env): LifecycleConfig | null {
  if (env.INSTAGRAM_LIFECYCLE_ENABLED !== "on") return null;
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "production") return null;
  const appId = env.INSTAGRAM_LIFECYCLE_APP_ID;
  if (!appId || !/^\d{1,40}$/.test(appId) || appId !== env.META_APP_ID || !env.META_APP_SECRET) return null;
  try {
    const url = new URL(env.INSTAGRAM_LIFECYCLE_PUBLIC_ORIGIN ?? "");
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) return null;
    const fallback = env.INSTAGRAM_LIFECYCLE_FALLBACK_APP_SECRET?.trim();
    const parent = env.INSTAGRAM_LIFECYCLE_PARENT_APP_ID?.trim();
    if (parent && !/^\d{1,40}$/.test(parent)) return null;
    return { appId, appSecret: env.META_APP_SECRET, publicOrigin: url.origin,
      ...(fallback && fallback !== env.META_APP_SECRET ? { fallbackSecret: fallback } : {}),
      ...(parent && parent !== appId ? { parentAppId: parent } : {}) };
  } catch { return null; }
}

function decode(part: string): Buffer {
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(part)) throw new Error("invalid_request");
  const bytes = Buffer.from(part, "base64url");
  const canonical = part.replace(/=+$/, "");
  const padding = part.length - canonical.length;
  if (bytes.toString("base64url") !== canonical || (padding > 0 && padding !== (4 - canonical.length % 4) % 4)) throw new Error("invalid_request");
  return bytes;
}

export function verifyLifecycleRequest(signed: string, config: LifecycleConfig, kind: LifecycleKind, now = Date.now()): LifecycleEvent {
  if (signed.length > MAX_BODY || signed.split(".").length !== 2) throw new Error("invalid_request");
  const [sig, payload] = signed.split(".");
  const supplied = decode(sig);
  const matches = (secret: string) => {
    const expected = createHmac("sha256", secret).update(payload).digest();
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  };
  if (!matches(config.appSecret) && !(config.fallbackSecret && matches(config.fallbackSecret))) throw new Error("invalid_request");
  const value = JSON.parse(decode(payload).toString("utf8"));
  if (!value || value.algorithm !== "HMAC-SHA256" || typeof value.user_id !== "string" || !/^\d{1,40}$/.test(value.user_id)
    || (value.issued_at !== undefined && (!Number.isSafeInteger(value.issued_at) || value.issued_at <= 0 || value.issued_at > Math.floor(now / 1000) + 300))
    || (value.app_id !== undefined && String(value.app_id) !== config.appId && String(value.app_id) !== config.parentAppId)) throw new Error("invalid_request");
  // No short freshness cutoff: genuine delayed/retried callbacks must remain actionable.
  // SQL compares issued_at with connected_at so a newer re-authorisation is never revoked.
  return { appId: config.appId, subjectId: value.user_id, issuedAt: value.issued_at ?? null, kind,
    // Equivalent encodings and irrelevant signed fields cannot multiply a receipt.
    // HMAC keeps this private identity fingerprint unguessable without the app secret.
    eventKey: createHmac("sha256", config.appSecret).update(JSON.stringify([config.appId, kind, value.user_id, value.issued_at ?? null])).digest("hex") };
}

async function boundedBody(request: Request): Promise<string> {
  if (Number(request.headers.get("content-length")) > MAX_BODY) throw new Error("invalid_request");
  const reader = request.body?.getReader();
  if (!reader) throw new Error("invalid_request");
  const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const next = await reader.read(); if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY) { await reader.cancel(); throw new Error("invalid_request"); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString("utf8");
}

export async function handleLifecycle(request: Request, kind: LifecycleKind, config: LifecycleConfig | null,
  accept: (event: LifecycleEvent) => Promise<LifecycleReceipt>): Promise<Response> {
  if (!config) return Response.json({ error: "Unavailable." }, { status: 503, headers: HEADERS });
  let event: LifecycleEvent;
  try {
    if (request.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "application/x-www-form-urlencoded") throw new Error("invalid_request");
    const form = new URLSearchParams(await boundedBody(request));
    if (form.getAll("signed_request").length !== 1) throw new Error("invalid_request");
    event = verifyLifecycleRequest(form.get("signed_request") ?? "", config, kind);
  } catch { return Response.json({ error: "Invalid request." }, { status: 400, headers: HEADERS }); }
  try {
    const receipt = await accept(event);
    if (!/^[a-f0-9]{32}$/.test(receipt.confirmation_code)) throw new Error("receipt_failed");
    return Response.json(kind === "deletion" ? {
      url: `${config.publicOrigin}/data-deletion/status?code=${receipt.confirmation_code}`,
      confirmation_code: receipt.confirmation_code,
    } : { received: true }, { headers: HEADERS });
  } catch { return Response.json({ error: "Please retry later." }, { status: 503, headers: HEADERS }); }
}
