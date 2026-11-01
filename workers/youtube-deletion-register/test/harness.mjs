// Real workerd + real local D1 (Miniflare), with the Worker compiled by Node's
// strip-only TypeScript transform. Only the Resend API is replaced (outbound).
import { Miniflare } from "miniflare";
import { stripTypeScriptTypes } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

const ROOT = new URL("../", import.meta.url);
const dir = mkdtempSync(join(tmpdir(), "voom-ydr-"));
export const compiledPath = join(dir, "index.mjs");
const compiled = stripTypeScriptTypes(readFileSync(new URL("src/index.ts", ROOT), "utf8"));
writeFileSync(compiledPath, compiled); // for direct (Node) fault-injection imports only
export const schema = readFileSync(new URL("schema/0001_register.sql", ROOT), "utf8");
export const statements = schema.split(/;\s*\n/).map((s) => s.trim()).filter((s) => s && !/^(--[^\n]*\n?)+$/.test(s));

export const tokens = () => ({
  JOURNAL_TOKEN: randomBytes(24).toString("hex"), JOURNAL_TOKEN_NEXT: randomBytes(24).toString("hex"),
  ALERT_TOKEN: randomBytes(24).toString("hex"), REPLAY_TOKEN: randomBytes(24).toString("hex"),
});
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");
export const DAY = 86_400_000;
export const ORIGIN = "https://register.voom-acceptance.example.com";

export async function startRegister(vars = {}, secrets = tokens()) {
  const emails = [];
  const resend = { mode: "ok" };
  const mf = new Miniflare({
    modules: true, script: compiled, d1Databases: ["DB"], compatibilityDate: "2026-08-01",
    bindings: { ...secrets, RESEND_API_KEY: "re_synthetic_test_only", ALERT_FROM: "VOOM Alerts <alerts@example.com>",
      ALERT_TO: "operator@example.com", ALERT_ESCALATE_TO: "deputy@example.com", ...vars },
    outboundService: async (request) => {
      const url = new URL(request.url);
      if (url.hostname !== "api.resend.com") return new Response("blocked", { status: 599 });
      emails.push({ key: request.headers.get("idempotency-key"), body: await request.json() });
      return resend.mode === "ok" ? Response.json({ id: "synthetic" }) : new Response("{}", { status: 503 });
    },
  });
  const db = await mf.getD1Database("DB");
  for (const s of statements) await db.prepare(s).run();
  const fetchRegister = (url, init = {}) => mf.dispatchFetch(url, init);
  const post = (path, body, { token = secrets.JOURNAL_TOKEN, key, raw, headers = {} } = {}) => mf.dispatchFetch(`${ORIGIN}${path}`, {
    method: "POST", body: raw ?? JSON.stringify(body),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...(key === null ? {} : { "Idempotency-Key": key ?? body?.eventId }), ...headers },
  });
  const scheduled = async (time) => (await mf.getWorker()).scheduled({ scheduledTime: new Date(time), cron: "17 * * * *" });
  return { mf, db, secrets, emails, resend, post, scheduled, fetchRegister, dispose: () => mf.dispose() };
}

/** Exactly the shape lib/youtube/deletion-delivery.ts journalEnvelope() produces. */
export function intent({ eventId = crypto.randomUUID(), ownerId = crypto.randomUUID(), scope = "erase", receivedAt = new Date().toISOString(), cutoffAt = null } = {}) {
  return { version: 1, eventId, ownerId, scope, receivedAt,
    deadlineAt: scope === "erase" ? new Date(Date.parse(receivedAt) + 7 * DAY).toISOString() : null,
    cutoffAt: scope === "retention" ? (cutoffAt ?? new Date(Date.parse(receivedAt) - 28 * DAY).toISOString()) : null };
}
export const completion = (i, appliedAt = new Date().toISOString()) =>
  ({ ...i, eventId: `${i.eventId}:active-erasure`, requestId: i.eventId, stage: "active_erasure", appliedAt });
export const alert = (requestId, code = "erasure_failed", receivedAt = new Date().toISOString()) =>
  ({ version: 1, eventId: `${requestId}:${code}`, requestId, code, receivedAt });
