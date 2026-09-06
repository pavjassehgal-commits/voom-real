/**
 * Safe, client-facing error classification for asset ingestion (Post Studio and
 * the legacy Reel upload route).
 *
 * Callers are never shown a raw database or storage error. Instead they receive
 * a canned message plus a stable `code` the UI can switch on. No SQL details,
 * constraint names, service-role data, tokens or provider secrets ever reach the
 * client.
 */
export type IngestionErrorCode =
  | "not_authenticated"
  | "ownership_failure"
  | "not_found"
  | "invalid_file"
  | "unsupported_format"
  | "invalid_video"
  | "file_too_large"
  | "storage_failure"
  | "db_failure"
  | "pack_full"
  | "action_required";

export type IngestionStage =
  | "received"
  | "detected"
  | "draft_read"
  | "storage_upload"
  | "db_upsert"
  | "stored";

export interface IngestionDetection {
  kind?: "image" | "video" | null;
  mimeType?: string | null;
  extension?: string | null;
}

export interface IngestionLogContext extends IngestionDetection {
  requestId: string;
  fileSize?: number | null;
  code?: IngestionErrorCode;
}

const REQUEST_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_MIME_RE = /^(?:image|video)\/[a-z0-9.+-]+$/i;
const SAFE_EXTENSION_RE = /^[a-z0-9]{1,12}$/i;

/** An internal failure that carries only a safe category and stage. */
export class IngestionFailure extends Error {
  readonly code: IngestionErrorCode;
  readonly stage: IngestionStage;

  constructor(code: IngestionErrorCode, stage: IngestionStage) {
    // The message is deliberately a safe code/stage pair, never a provider or
    // database error. It is not returned to the browser.
    super(`${code}:${stage}`);
    this.name = "IngestionFailure";
    this.code = code;
    this.stage = stage;
  }
}

export function isIngestionErrorCode(value: unknown): value is IngestionErrorCode {
  return typeof value === "string" && [
    "not_authenticated", "ownership_failure", "not_found", "invalid_file",
    "unsupported_format", "invalid_video", "file_too_large", "storage_failure",
    "db_failure", "pack_full", "action_required",
  ].includes(value);
}

/** Uses a valid caller correlation id, or the request's server-generated id. */
export function requestIdFrom(request: Request, generatedId: string): string {
  const supplied = request.headers.get("x-request-id")?.trim() ?? "";
  return REQUEST_ID_RE.test(supplied) ? supplied : generatedId;
}

/**
 * Logs only an allow-listed diagnostic shape. In particular, do not pass an
 * SDK error, filename, storage path, user id, or request body to this helper.
 */
export function logIngestionStage(stage: IngestionStage, context: IngestionLogContext): void {
  const fileSize = typeof context.fileSize === "number" && Number.isSafeInteger(context.fileSize) && context.fileSize >= 0
    ? context.fileSize
    : null;
  const detectedKind = context.kind === "image" || context.kind === "video" ? context.kind : null;
  const detectedMime = typeof context.mimeType === "string" && SAFE_MIME_RE.test(context.mimeType) ? context.mimeType : null;
  const extension = typeof context.extension === "string" && SAFE_EXTENSION_RE.test(context.extension) ? context.extension.toLowerCase() : null;
  const code = context.code && isIngestionErrorCode(context.code) ? context.code : undefined;

  // Safe structured fields only. Never add the caught error to this object.
  console.info("[voom:asset-ingestion]", {
    requestId: context.requestId,
    stage,
    fileSize,
    detectedKind,
    detectedMime,
    extension,
    ...(code ? { code } : {}),
  });
}

const DEFAULT_MESSAGES: Record<IngestionErrorCode, string> = {
  not_authenticated: "Please log in again.",
  ownership_failure: "Voom couldn't access that draft safely. Please retry.",
  not_found: "That post was not found.",
  invalid_file: "Choose one valid file.",
  unsupported_format: "Use JPEG, PNG, WebP, MP4, or MOV only.",
  invalid_video: "That video isn't a supported container. Export it as MP4 and try again.",
  file_too_large: "That file is too large. Please choose a smaller file.",
  storage_failure: "Voom couldn't store that file safely. Nothing changed.",
  db_failure: "Voom couldn't save that asset to your content. Nothing changed.",
  pack_full: "This Reel already has the maximum number of assets.",
  action_required: "Choose an available asset option first.",
};

export function messageForIngestionCode(code: IngestionErrorCode): string {
  return DEFAULT_MESSAGES[code];
}

/** Builds a safe error response: canned message + stable code + correlation id. */
export function ingestionError(code: IngestionErrorCode, message: string, status = 400, requestId?: string): Response {
  const headers = requestId ? { "X-Request-Id": requestId } : undefined;
  // Even if a future caller accidentally passes an SDK message, persistence
  // failures can only expose these canned strings to the browser.
  const safeMessage = code === "storage_failure" || code === "db_failure"
    ? messageForIngestionCode(code)
    : message || messageForIngestionCode(code);
  return Response.json({ error: safeMessage, code, ...(requestId ? { requestId } : {}) }, { status, headers });
}

export function ingestionFailureResponse(failure: IngestionFailure, requestId: string, status = statusForIngestionCode(failure.code)): Response {
  return ingestionError(failure.code, messageForIngestionCode(failure.code), status, requestId);
}

export function statusForIngestionCode(code: IngestionErrorCode): number {
  if (code === "not_authenticated") return 401;
  if (code === "ownership_failure" || code === "not_found") return 404;
  if (code === "file_too_large") return 413;
  if (code === "action_required" || code === "pack_full") return 409;
  if (code === "storage_failure" || code === "db_failure") return 503;
  return 400;
}

export function defaultIngestionCodeForStatus(status: number): IngestionErrorCode {
  if (status === 401) return "not_authenticated";
  if (status === 404) return "ownership_failure";
  if (status === 413) return "file_too_large";
  if (status === 409) return "action_required";
  if (status === 503) return "storage_failure";
  return "invalid_file";
}

/** Prefixes a known stable code for visible upload diagnostics without trusting arbitrary codes. */
export function formatIngestionClientError(body: { error?: unknown; code?: unknown }, fallback: string): string {
  const message = typeof body.error === "string" && body.error.trim() ? body.error : fallback;
  return isIngestionErrorCode(body.code) ? `${body.code}: ${message}` : message;
}
