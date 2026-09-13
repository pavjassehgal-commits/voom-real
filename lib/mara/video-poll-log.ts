import "server-only";

/**
 * Safe structured diagnostics for the durable media worker. The allow-list is
 * deliberately narrower than a provider response: provider job ids, storage
 * paths, signed URLs, prompts, request bodies and credentials never enter a
 * log record.
 */
export const VIDEO_POLL_EVENTS = [
  "poll_started",
  "provider_status",
  "provider_completed",
  "asset_stored",
  "provider_failed",
  "timed_out",
] as const;

export type VideoPollEvent = (typeof VIDEO_POLL_EVENTS)[number];
export const VIDEO_POLL_LOG_PREFIX = "[voom:media-generation]";

const SAFE_TOKEN_RE = /^[a-zA-Z0-9_-]{1,80}$/;
const PROVIDERS = ["magic-hour", "gemini", "openai", "openrouter"] as const;
type ProviderName = (typeof PROVIDERS)[number];

export interface VideoPollLogInput {
  generationId?: unknown;
  provider?: unknown;
  providerStatus?: unknown;
  errorCode?: unknown;
  batchSize?: unknown;
  durationMs?: unknown;
}

export interface VideoPollLogRecord {
  event: VideoPollEvent;
  at: string;
  generationId: string | null;
  provider: ProviderName | null;
  providerStatus: string | null;
  errorCode: string | null;
  batchSize: number | null;
  durationMs: number | null;
}

export function buildVideoPollLogRecord(
  event: VideoPollEvent,
  input: VideoPollLogInput = {},
  at: number = Date.now(),
): VideoPollLogRecord {
  return {
    event: VIDEO_POLL_EVENTS.includes(event) ? event : "provider_failed",
    at: new Date(Number.isFinite(at) ? at : Date.now()).toISOString(),
    generationId: safeToken(input.generationId),
    provider: providerOrNull(input.provider),
    providerStatus: safeToken(input.providerStatus),
    errorCode: safeToken(input.errorCode),
    batchSize: boundedInteger(input.batchSize, 0, 100),
    durationMs: boundedInteger(input.durationMs, 0, 3_600_000),
  };
}

export function logVideoPoll(event: VideoPollEvent, input: VideoPollLogInput = {}, at?: number): void {
  console.info(VIDEO_POLL_LOG_PREFIX, buildVideoPollLogRecord(event, input, at));
}

function safeToken(value: unknown): string | null {
  return typeof value === "string" && SAFE_TOKEN_RE.test(value) ? value : null;
}

function providerOrNull(value: unknown): ProviderName | null {
  return typeof value === "string" && (PROVIDERS as readonly string[]).includes(value)
    ? value as ProviderName
    : null;
}

function boundedInteger(value: unknown, min: number, max: number): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : null;
}
