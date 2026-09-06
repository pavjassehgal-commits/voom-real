/**
 * Safe, client-facing error classification for asset ingestion (Post Studio and
 * the legacy Reel upload route).
 *
 * Callers are never shown a raw database or storage error. Instead they receive
 * a canned human message plus a stable `code` the UI can switch on. No SQL
 * details, constraint names, service-role data, tokens or provider secrets ever
 * reach the client.
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

/** Builds a safe error response: canned message + stable code. */
export function ingestionError(code: IngestionErrorCode, message: string, status = 400): Response {
  return Response.json({ error: message, code }, { status });
}

export function defaultIngestionCodeForStatus(status: number): IngestionErrorCode {
  if (status === 401) return "not_authenticated";
  if (status === 404) return "ownership_failure";
  if (status === 413) return "file_too_large";
  if (status === 409) return "action_required";
  if (status === 503) return "storage_failure";
  return "invalid_file";
}
