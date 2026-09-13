/**
 * Structured publish-timeline diagnostics.
 *
 * WHY THIS EXISTS: during the production 22:15 incident the exact instant Meta
 * reported the container ready could not be recovered, because individual
 * readiness polls are not persisted anywhere. These events reconstruct that
 * timeline from the application log alone.
 *
 * Deliberate choices:
 *   - Application logging, NOT database rows. A Reel attempt emits up to
 *     REEL_POLL_ATTEMPTS poll events; writing those as permanent rows would
 *     bury the queue table in noise that expires with the log anyway.
 *   - A fixed, allow-listed record shape built field by field. There is no
 *     field for an access token, a signed media URL, a caption or a storage
 *     path, so those cannot be logged by construction — a caller passing them
 *     as extra properties has them dropped.
 *   - Every string is pattern-checked before it is emitted, so a container id
 *     or status that somehow carried a URL is dropped rather than logged.
 *
 * `buildPublishTimelineRecord` is pure so the shape is unit tested directly;
 * only `logPublishTimeline` touches the outside world.
 */

import type { PublishMediaKind } from "./publishing";

/** The complete vocabulary of publish-timeline events. */
export const PUBLISH_TIMELINE_EVENTS = [
  /** The worker invocation started. */
  "run_started",
  /** A queue row was claimed atomically by this invocation. */
  "claimed",
  /** Meta accepted a new media container. */
  "container_created",
  /** An attempt resumed a container persisted by an earlier attempt. */
  "container_reused",
  /** One readiness poll completed. */
  "poll",
  /** The polling budget or attempt count ran out while Meta was still working. */
  "polling_exhausted",
  /** A retry was parked, aligned to the next worker cron boundary. */
  "retry_scheduled",
  /** Meta reported the container FINISHED. */
  "container_ready",
  /** media_publish was called. */
  "publish_requested",
  /** Meta returned a real media id from media_publish. */
  "media_id_received",
  /** The queue row was marked published with that media id. */
  "marked_published",
  /** The attempt ended in a non-retryable failure. */
  "failed",
] as const;

export type PublishTimelineEvent = (typeof PUBLISH_TIMELINE_EVENTS)[number];

/** Stable log prefix, so these lines are greppable next to [voom:asset-ingestion]. */
export const PUBLISH_TIMELINE_PREFIX = "[voom:instagram-publish]";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Meta container and media ids are opaque alphanumerics — never URLs. */
const OPAQUE_ID_RE = /^[A-Za-z0-9_-]{1,120}$/;
/** Meta status_code values: IN_PROGRESS / FINISHED / ERROR / EXPIRED / PUBLISHED. */
const STATUS_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
const FAILURE_CODE_RE = /^[a-z][a-z0-9_]{0,79}$/;
const ISO_INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
const MEDIA_KINDS: PublishMediaKind[] = ["image", "reel", "story"];

/** Upper bound for any duration we log, so a bad clock cannot emit nonsense. */
const MAX_LOGGED_DURATION_MS = 3_600_000;
const MAX_LOGGED_COUNT = 1_000;

export interface PublishTimelineInput {
  itemId?: unknown;
  ownerUserId?: unknown;
  draftId?: unknown;
  mediaKind?: unknown;
  /** Queue row `attempts`, 0-25. */
  attempt?: unknown;
  containerId?: unknown;
  containerStatus?: unknown;
  /** 1-based index of this poll within the attempt. */
  poll?: unknown;
  /** Total polls performed by the attempt. */
  polls?: unknown;
  elapsedMs?: unknown;
  /** Remaining shared invocation polling budget at the time of the event. */
  budgetMs?: unknown;
  retryAt?: unknown;
  instagramMediaId?: unknown;
  code?: unknown;
}

/** The one shape every publish-timeline log line has. Nulls are meaningful. */
export interface PublishTimelineRecord {
  event: PublishTimelineEvent;
  at: string;
  itemId: string | null;
  ownerUserId: string | null;
  draftId: string | null;
  mediaKind: PublishMediaKind | null;
  attempt: number | null;
  containerId: string | null;
  containerStatus: string | null;
  poll: number | null;
  polls: number | null;
  elapsedMs: number | null;
  budgetMs: number | null;
  retryAt: string | null;
  mediaId: string | null;
  code: string | null;
}

/**
 * Builds one log record. Pure: given the same input and clock it returns the
 * same object, and nothing outside `PublishTimelineInput` can reach the output.
 */
export function buildPublishTimelineRecord(
  event: PublishTimelineEvent,
  input: PublishTimelineInput = {},
  at: number = Date.now(),
): PublishTimelineRecord {
  return {
    event: isTimelineEvent(event) ? event : "failed",
    at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    itemId: opaqueIdOrNull(input.itemId, UUID_RE),
    ownerUserId: opaqueIdOrNull(input.ownerUserId, UUID_RE),
    draftId: opaqueIdOrNull(input.draftId, UUID_RE),
    mediaKind: mediaKindOrNull(input.mediaKind),
    attempt: countOrNull(input.attempt, 25),
    containerId: opaqueIdOrNull(input.containerId, OPAQUE_ID_RE),
    containerStatus: opaqueIdOrNull(input.containerStatus, STATUS_RE),
    poll: countOrNull(input.poll, MAX_LOGGED_COUNT),
    polls: countOrNull(input.polls, MAX_LOGGED_COUNT),
    elapsedMs: durationOrNull(input.elapsedMs),
    budgetMs: durationOrNull(input.budgetMs),
    retryAt: instantOrNull(input.retryAt),
    mediaId: opaqueIdOrNull(input.instagramMediaId, OPAQUE_ID_RE),
    code: opaqueIdOrNull(input.code, FAILURE_CODE_RE),
  };
}

/**
 * Emits one publish-timeline line. The record is already fully sanitized by
 * `buildPublishTimelineRecord`, so nothing else may be added here.
 */
export function logPublishTimeline(
  event: PublishTimelineEvent,
  input: PublishTimelineInput = {},
  at: number = Date.now(),
): void {
  console.info(PUBLISH_TIMELINE_PREFIX, buildPublishTimelineRecord(event, input, at));
}

function isTimelineEvent(value: unknown): value is PublishTimelineEvent {
  return typeof value === "string" && (PUBLISH_TIMELINE_EVENTS as readonly string[]).includes(value);
}

function opaqueIdOrNull(value: unknown, pattern: RegExp): string | null {
  return typeof value === "string" && pattern.test(value) ? value : null;
}

function mediaKindOrNull(value: unknown): PublishMediaKind | null {
  return typeof value === "string" && (MEDIA_KINDS as string[]).includes(value)
    ? (value as PublishMediaKind)
    : null;
}

function countOrNull(value: unknown, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** Durations may be negative: a budget that has already run out is the truth. */
function durationOrNull(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  return Math.abs(rounded) <= MAX_LOGGED_DURATION_MS ? rounded : null;
}

function instantOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !ISO_INSTANT_RE.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}
