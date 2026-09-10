import "server-only";
import type { MediaDiagnostic } from "./types";

export const DIAGNOSTIC_READ_MAX = 4_096;
export const DIAGNOSTIC_MESSAGE_MAX = 240;
export const DIAGNOSTIC_EXCERPT_MAX = 240;
export const DIAGNOSTIC_CONTENT_TYPE_MAX = 80;
export const DIAGNOSTIC_SCALAR_MAX = 80;

const IDENTIFIER_RE = /^[A-Z][A-Z0-9_]{1,63}$/;
const NUMERIC_CODE_RE = /^\d{1,3}$/;
const CONTENT_TYPE_RE = /^[a-z0-9.+*-]+\/[a-z0-9.+*-]+(?:\s*;\s*[a-z0-9.+*-]+=[\w.+*-]+)*$/i;
const CONTENT_TYPE_MEDIA_RE = /^[a-z0-9.+*-]+\/[a-z0-9.+*-]+$/i;

/** Redact credential-like tokens and obvious secret keywords. Specific values first. */
const SECRET_RE = new RegExp(
  [
    "https?:\\/\\/[^\\s\"'<>]+",
    "bearer\\s+[A-Za-z0-9._\\-+/=]+",
    "AIza[0-9A-Za-z_\\-]{8,}",
    "sk-[A-Za-z0-9]{8,}",
    "eyJ[A-Za-z0-9_\\-]+=*\\.[A-Za-z0-9_\\-]+=*\\.[A-Za-z0-9_\\-]+=*",
    "(?:api[-_]?key|access[_-]?token|refresh[_-]?token|id[_-]?token|client[_-]?secret|x-goog-api-key)\\s*[:=]\\s*[^\\s\"']+",
    "(?:token|secret|signature|key)=[^\\s\"'&]+",
    "(?:cookie|set-cookie)\\s*[:=]\\s*\\S+",
    "api[-_ ]?key",
    "authorization",
    "\\bbearer\\b",
    "\\bcookie\\b",
    "signed[_ -]?url",
  ].join("|"),
  "gi",
);

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function sanitizeText(value: string, max: number): string | null {
  const redacted = value
    .replace(SECRET_RE, "[redacted]")
    .replace(/[\u0000-\u001F\u007F]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!redacted) return null;
  return redacted.slice(0, max);
}

function sanitizeContentType(header: string | null): string | null {
  if (!header) return null;
  const trimmed = header.trim().slice(0, DIAGNOSTIC_CONTENT_TYPE_MAX);
  if (CONTENT_TYPE_RE.test(trimmed)) return trimmed;
  const media = trimmed.split(";")[0]?.trim() ?? "";
  return CONTENT_TYPE_MEDIA_RE.test(media) ? media.slice(0, DIAGNOSTIC_CONTENT_TYPE_MAX) : null;
}

function diagnosticCode(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 599) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (IDENTIFIER_RE.test(trimmed) || NUMERIC_CODE_RE.test(trimmed)) return trimmed;
  }
  return null;
}

function diagnosticStatus(value: unknown): string | null {
  return typeof value === "string" && IDENTIFIER_RE.test(value.trim()) ? value.trim() : null;
}

function diagnosticMessage(value: unknown): string | null {
  return typeof value === "string" ? sanitizeText(value, DIAGNOSTIC_MESSAGE_MAX) : null;
}

function addScalar(out: Record<string, string>, key: string, value: unknown) {
  if (out[key]) return;
  if (typeof value === "string") {
    const clean = sanitizeText(value, DIAGNOSTIC_SCALAR_MAX);
    if (clean) out[key] = clean;
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const clean = sanitizeText(String(value), DIAGNOSTIC_SCALAR_MAX);
    if (clean) out[key] = clean;
  }
}

function collectDetails(error: Record<string, unknown>): Record<string, string> | null {
  const out: Record<string, string> = {};
  addScalar(out, "reason", error.reason);
  addScalar(out, "type", error.type);
  addScalar(out, "param", error.param);
  const details = error.details;
  if (Array.isArray(details)) {
    const first = asRecord(details[0]);
    if (first) {
      addScalar(out, "reason", first.reason);
      addScalar(out, "domain", first.domain);
      addScalar(out, "description", first.description);
      const violations = first.fieldViolations;
      if (Array.isArray(violations)) {
        const violation = asRecord(violations[0]);
        if (violation) {
          addScalar(out, "field", violation.field);
          addScalar(out, "description", violation.description);
        }
      }
    }
  }
  const errors = error.errors;
  if (Array.isArray(errors)) {
    const first = asRecord(errors[0]);
    if (first) {
      addScalar(out, "reason", first.reason);
      addScalar(out, "domain", first.domain);
    }
  }
  return Object.keys(out).length ? out : null;
}

function errorRecord(root: unknown): Record<string, unknown> {
  const obj = asRecord(root);
  if (!obj) return {};
  const nested = asRecord(obj.error);
  return nested ?? obj;
}

function excerptFromBody(raw: string, contentType: string | null): string | null {
  const html = contentType?.toLowerCase().includes("text/html") || /^\s*</.test(raw);
  const source = html ? raw.replace(/<[^>]+>/g, " ") : raw;
  return sanitizeText(source, DIAGNOSTIC_EXCERPT_MAX);
}

/**
 * Bounded, sanitized provider-rejection diagnostics. Never include request
 * headers, request bodies, prompts, API keys, or unbounded raw responses.
 */
export async function parseProviderDiagnostic(response: Response): Promise<MediaDiagnostic> {
  const contentType = sanitizeContentType(response.headers.get("content-type"));
  let raw = "";
  try {
    raw = (await response.text()).slice(0, DIAGNOSTIC_READ_MAX);
  } catch {
    raw = "";
  }

  let parsed: unknown = null;
  let json = false;
  if (raw) {
    try {
      parsed = JSON.parse(raw);
      json = true;
    } catch {
      parsed = null;
    }
  }

  const root = asRecord(parsed);
  const error = errorRecord(parsed);
  const stringError = root && typeof root.error === "string" ? root.error : null;
  const nestedMessage = diagnosticMessage(error.message)
    ?? diagnosticMessage(asRecord(Array.isArray(error.errors) ? error.errors[0] : null)?.message)
    ?? diagnosticMessage(stringError);

  const diagnostic: MediaDiagnostic = {
    http_status: response.status,
    content_type: contentType,
    provider_code: diagnosticCode(error.code),
    provider_status: diagnosticStatus(error.status),
    provider_message: nestedMessage,
    provider_details: collectDetails(error),
    body_excerpt: null,
  };

  const incomplete = !diagnostic.provider_code || !diagnostic.provider_status || !diagnostic.provider_message;
  if (incomplete && raw) {
    diagnostic.body_excerpt = json ? sanitizeText(raw, DIAGNOSTIC_EXCERPT_MAX) : excerptFromBody(raw, contentType);
  }
  return diagnostic;
}
