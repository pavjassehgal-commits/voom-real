/**
 * The durable video generation job state machine (pure — no I/O, unit
 * testable).
 *
 *   queued      row persisted, provider job not yet started
 *   generating  a real provider job id is persisted (job in flight)
 *   processing  claimed: download / validate / overlay / store in progress
 *   completed   validated bytes stored privately and attached to the draft
 *   failed      safe error_code set; the previous asset (if any) is untouched
 *   cancelled   user cancelled before any provider job was started
 *
 * Safety rules encoded here:
 *   - a failed or timed-out job NEVER removes or replaces the draft's
 *     current asset; replacement happens only inside `completed`,
 *   - at most one active job per (owner, draft) — enforced by a partial
 *     unique index and re-checked before every start,
 *   - provider timeouts fail the job instead of leaving it "generating"
 *     forever, and a crashed processing claim is re-claimable.
 */

export const VIDEO_JOB_STATES = ["queued", "generating", "processing", "completed", "failed", "cancelled"] as const;
export type VideoJobState = (typeof VIDEO_JOB_STATES)[number];

/** States in which the job is doing (or may do) paid work. */
export const ACTIVE_VIDEO_STATES: VideoJobState[] = ["queued", "generating", "processing"];

/** Total job lifetime before it is abandoned safely. */
export const VIDEO_JOB_TIMEOUT_MINUTES = 30;
/** A processing claim older than this is treated as crashed and re-claimable. */
export const VIDEO_STALE_PROCESSING_MINUTES = 10;
/** A queued row older than this never got a provider job (start request died). */
export const VIDEO_STALE_QUEUED_MINUTES = 10;

export function isActiveVideoState(status: string): boolean {
  return (ACTIVE_VIDEO_STATES as string[]).includes(status);
}

export function isTerminalVideoState(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/** Client-visible phase. "preparing" exists only while the start request is in flight. */
export type VideoJobPhase = "preparing" | "generating" | "processing" | "ready" | "failed" | "cancelled";

export function phaseForState(status: string): VideoJobPhase {
  if (status === "queued" || status === "generating") return "generating";
  if (status === "processing") return "processing";
  if (status === "completed") return "ready";
  if (status === "failed") return "failed";
  if (status === "cancelled") return "cancelled";
  return "preparing";
}

/** One active job per draft: only terminal states may start a regeneration. */
export function mayStartGeneration(currentStatus: string | null): boolean {
  return currentStatus === null || isTerminalVideoState(currentStatus);
}

export interface JobClock {
  nowMs: number;
  createdAtMs: number;
  updatedAtMs: number;
}

/**
 * Decides what to do with a non-terminal job before any provider call:
 *   "timeout"   abandon the job (provider_timeout),
 *   "reclaim"   crashed processing claim -> back to generating,
 *   "ok"        proceed as-is.
 */
export function staleDecision(status: string, clock: JobClock): "timeout" | "reclaim" | "ok" {
  if (!isActiveVideoState(status)) return "ok";
  const ageMs = clock.nowMs - clock.createdAtMs;
  if (ageMs > VIDEO_JOB_TIMEOUT_MINUTES * 60_000) return "timeout";
  const sinceUpdateMs = clock.nowMs - clock.updatedAtMs;
  if (status === "processing" && sinceUpdateMs > VIDEO_STALE_PROCESSING_MINUTES * 60_000) return "reclaim";
  if (status === "queued" && sinceUpdateMs > VIDEO_STALE_QUEUED_MINUTES * 60_000) return "timeout";
  return "ok";
}

/** Deterministic idempotency keys. Same click (same token) -> same key. */
export function videoIdempotencyKey(scope: "post" | "reel", draftId: string, token: string): string {
  const clean = token.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 64);
  if (!clean) throw new Error("idempotency_token_required");
  return `video:${scope}:${draftId}:${clean}`.slice(0, 200);
}

/**
 * Safe user-facing messages per error code. Provider specifics (raw messages,
 * payloads, credentials) never reach the client — only these strings.
 */
export function videoJobSafeError(code: string | null): string | null {
  switch (code) {
    case null:
      return null;
    case "not_configured":
      return "Create with MARA is temporarily unavailable. Your previous asset is unchanged.";
    case "rate_limited":
      return "Video generation is taking longer than expected. Your previous asset is unchanged.";
    case "rejected":
      return "Generation couldn't finish. Your previous asset is unchanged.";
    case "unsupported_input":
      return "This video provider can't animate that image yet. Your previous asset is unchanged.";
    case "invalid_output":
      return "The generated video didn't pass Voom's checks, so it was not attached. Your previous asset is unchanged.";
    case "provider_timeout":
      return "Video generation is taking longer than expected and this attempt was stopped. Your previous asset is unchanged.";
    case "insufficient_credits":
      return "Video generation couldn't finish because the media account is out of credits. Nothing was charged for this attempt and your previous asset is unchanged.";
    case "storage_failure":
      return "Voom couldn't store that video safely. Your previous asset is unchanged.";
    case "db_failure":
      return "Voom couldn't update that generation safely. Nothing changed.";
    default:
      return "Generation couldn't finish. Your previous asset is unchanged.";
  }
}

/** The statuses that block a new start for the same draft. */
export const BLOCKING_START_STATUSES: string[] = ["queued", "generating", "processing"];

export function generationModeFor(hasReferenceImage: boolean, referenceIsUserAsset: boolean): "image_to_video" | "generated_image_to_video" | "text_to_video" {
  if (hasReferenceImage) return referenceIsUserAsset ? "image_to_video" : "generated_image_to_video";
  return "text_to_video";
}
