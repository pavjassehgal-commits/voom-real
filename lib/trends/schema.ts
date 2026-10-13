/**
 * Validation of raw trend observations into `TrendObservation`.
 *
 * Two layers:
 *   1. Shape — strict zod objects: unknown fields are rejected, numbers must
 *      be finite numbers (never strings), metric values must say whether they
 *      were measured or are unavailable.
 *   2. Meaning — the source must be registered, the platform and subject kind
 *      must be ones that source covers, the market must be well formed and
 *      respect the source's language rule ("und" only, or a registered
 *      TREND_LANGUAGES tag / "und"), metric keys must be the source's
 *      own and within its declared range, timestamps must be real UTC-
 *      resolvable instants in a sensible order, and every observation must
 *      carry attributed evidence.
 *
 * A declared metric that is simply absent becomes `unavailable` with reason
 * `not_collected` — it is never filled with zero. A measured 0 stays a
 * measured 0. Every measured value is tagged with the metric DEFINITION
 * VERSION in force when the provider reported it (at retrieval); a value
 * claiming a version that does not exist, or that was not in force then,
 * is rejected.
 *
 * Content items: a subject kind that IS an item (a video) must carry the
 * provider's own id, validated per platform; topic kinds must not carry one.
 *
 * Validation is not permission: a valid observation may still come from a
 * source Voom has not approved (see confidence.ts / MarketPolicy).
 *
 * Deterministic: "now" is always passed in; nothing reads the clock.
 */
import { z } from "zod";
import { normalizeSubjectText } from "./dedupe";
import {
  ITEM_IDENTITY_BY_KIND,
  PROVIDER_ITEM_ID_PATTERNS,
  TREND_PLATFORMS,
  TREND_SUBJECT_KINDS,
  UNAVAILABLE_REASONS,
  UNDETERMINED_LANGUAGE,
  isTrendLanguage,
  isTrendSourceId,
  trendSource,
  type MetricDefinition,
  type MetricValue,
  type ParseResult,
  type TrendItem,
  type TrendObservation,
  type TrendSourceId,
  type ValidationIssue,
} from "./types";

/** Tolerated difference between the source's clock and ours. */
export const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
export const MAX_EVIDENCE_ITEMS = 20;

const ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const COUNTRY = /^[A-Z]{2}$/;
const ISO_INSTANT = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const metricValueSchema = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("measured"), value: z.number(), definitionVersion: z.string().max(120).optional() }),
  z.strictObject({ status: z.literal("unavailable"), reason: z.enum(UNAVAILABLE_REASONS) }),
]);

const evidenceSchema = z.strictObject({
  sourceId: z.string(),
  url: z.string().max(2048).nullable(),
  attribution: z.string().min(1).max(200),
  retrievedAt: z.string(),
});

const rawObservationSchema = z.strictObject({
  id: z.string(),
  sourceId: z.string(),
  platform: z.string(),
  market: z.strictObject({ country: z.string(), language: z.string() }),
  subject: z.strictObject({ kind: z.string(), text: z.string(), providerItemId: z.string().max(128).optional() }),
  window: z.strictObject({ start: z.string(), end: z.string() }),
  retrievedAt: z.string(),
  metrics: z.record(z.string(), metricValueSchema).optional(),
  evidence: z.array(evidenceSchema).min(1).max(MAX_EVIDENCE_ITEMS),
});

export type RawTrendObservation = z.input<typeof rawObservationSchema>;

export type ParseOptions = {
  /** The evaluation instant: a Date, epoch milliseconds or an ISO 8601 string. */
  now: Date | number | string;
  clockSkewMs?: number;
};

/** Parses an ISO 8601 instant with an explicit timezone and a real calendar date. Returns epoch ms or null. */
export function parseInstant(value: string): number | null {
  const match = ISO_INSTANT.exec(value);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match;
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const probe = new Date(Date.UTC(year, month - 1, day));
  if (probe.getUTCFullYear() !== year || probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return null;
  if (Number(h) > 23 || Number(mi) > 59 || (s !== undefined && Number(s) > 59)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function resolveNow(now: ParseOptions["now"]): number | null {
  if (now instanceof Date) return Number.isFinite(now.getTime()) ? now.getTime() : null;
  if (typeof now === "number") return Number.isFinite(now) ? now : null;
  if (typeof now === "string") return parseInstant(now);
  return null;
}

/** The definition version of `metric` in force at `atMs`, or null. Versions use [from, until). */
export function definitionVersionAt(metric: MetricDefinition, atMs: number) {
  return (
    metric.versions.find((version) => {
      const from = version.effectiveFrom === null ? Number.NEGATIVE_INFINITY : parseInstant(version.effectiveFrom) ?? Number.NaN;
      const until = version.effectiveUntil === null ? Number.POSITIVE_INFINITY : parseInstant(version.effectiveUntil) ?? Number.NaN;
      return atMs >= from && atMs < until;
    }) ?? null
  );
}

/** The YouTube video id a watch/short link points to, or null when the URL is not a YouTube video link. */
function youTubeVideoIdFromUrl(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\.|^m\./, "");
    if (host === "youtu.be") return url.pathname.slice(1) || null;
    if (host !== "youtube.com") return null;
    if (url.pathname === "/watch") return url.searchParams.get("v");
    const shorts = /^\/shorts\/([^/]+)/.exec(url.pathname);
    return shorts ? shorts[1] : null;
  } catch {
    return null;
  }
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0 && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** Validates one raw observation. Never throws. */
export function parseTrendObservation(input: unknown, options: ParseOptions): ParseResult<TrendObservation> {
  const nowMs = resolveNow(options.now);
  if (nowMs === null) return { ok: false, issues: [{ path: "", code: "invalid_now", message: "The evaluation time is not a valid instant." }] };
  const skew = options.clockSkewMs ?? DEFAULT_CLOCK_SKEW_MS;

  const shaped = rawObservationSchema.safeParse(input);
  if (!shaped.success) {
    return {
      ok: false,
      issues: shaped.error.issues.map((issue) => ({ path: issue.path.map(String).join("."), code: "invalid_shape", message: issue.message })),
    };
  }
  const raw = shaped.data;
  const issues: ValidationIssue[] = [];
  const fail = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (!ID.test(raw.id)) fail("id", "invalid_id", "The id must be 1–128 letters, digits or _.:- characters.");

  // Source and platform — strict identification.
  if (!isTrendSourceId(raw.sourceId)) {
    fail("sourceId", "unknown_source", "The source is not in the trend source registry.");
    return { ok: false, issues };
  }
  const sourceId: TrendSourceId = raw.sourceId;
  const source = trendSource(sourceId);
  const platform = raw.platform;
  if (!(TREND_PLATFORMS as readonly string[]).includes(platform)) fail("platform", "unknown_platform", "The platform is not recognised.");
  else if (!(source.platforms as readonly string[]).includes(platform)) {
    fail("platform", "platform_not_supported_by_source", `${source.name} does not report trends for this platform.`);
  }

  // Market.
  const country = raw.market.country;
  const language = raw.market.language;
  if (!COUNTRY.test(country)) fail("market.country", "invalid_country", "The country must be an ISO 3166-1 alpha-2 code in upper case.");
  if (source.languageScope === "not_reported") {
    if (language !== UNDETERMINED_LANGUAGE) {
      fail("market.language", "language_must_be_undetermined", `${source.name} does not report language, so the language must be "und".`);
    }
  } else if (language !== UNDETERMINED_LANGUAGE && !isTrendLanguage(language)) {
    fail("market.language", "invalid_language", 'The language must be a registered language tag (e.g. "en", "zh-Hant", "fil") or "und".');
  }

  // Subject (the topic) and item (the specific provider content, if any).
  const kind = raw.subject.kind;
  let normalized: string | null = null;
  let item: TrendItem | null = null;
  if (!(TREND_SUBJECT_KINDS as readonly string[]).includes(kind)) fail("subject.kind", "unknown_subject_kind", "The subject kind is not recognised.");
  else if (!(source.subjectKinds as readonly string[]).includes(kind)) {
    fail("subject.kind", "subject_kind_not_supported_by_source", `${source.name} does not report this kind of subject.`);
  } else {
    const typedKind = kind as TrendObservation["subject"]["kind"];
    normalized = normalizeSubjectText(typedKind, raw.subject.text);
    if (normalized === null) fail("subject.text", "invalid_subject", "The subject is empty, too long or contains control characters.");
    const identity = ITEM_IDENTITY_BY_KIND[typedKind];
    const providerItemId = raw.subject.providerItemId;
    const pattern = (TREND_PLATFORMS as readonly string[]).includes(platform) ? PROVIDER_ITEM_ID_PATTERNS[platform as TrendItem["platform"]] : null;
    if (providerItemId === undefined) {
      if (identity === "required") fail("subject.providerItemId", "provider_item_id_required", "This kind of subject is a specific item and needs the provider's id.");
    } else if (identity === "none") {
      fail("subject.providerItemId", "provider_item_id_not_allowed", "Topics are identified by their text, not by a provider item id.");
    } else if (pattern === null) {
      fail("subject.providerItemId", "provider_item_id_not_supported", "This platform has no content items.");
    } else if (!pattern.test(providerItemId)) {
      fail("subject.providerItemId", "invalid_provider_item_id", "The provider item id does not match this platform's id format.");
    } else {
      item = { platform: platform as TrendItem["platform"], kind: typedKind, providerItemId };
    }
  }

  // Evidence timestamps.
  const start = parseInstant(raw.window.start);
  const end = parseInstant(raw.window.end);
  const retrieved = parseInstant(raw.retrievedAt);
  if (start === null) fail("window.start", "invalid_timestamp", "Expected an ISO 8601 instant with a timezone.");
  if (end === null) fail("window.end", "invalid_timestamp", "Expected an ISO 8601 instant with a timezone.");
  if (retrieved === null) fail("retrievedAt", "invalid_timestamp", "Expected an ISO 8601 instant with a timezone.");
  if (start !== null && end !== null && start > end) fail("window", "window_inverted", "The window starts after it ends.");
  if (end !== null && retrieved !== null && end > retrieved + skew) {
    fail("window.end", "window_after_retrieval", "The window ends after the data was retrieved.");
  }
  if (retrieved !== null && retrieved > nowMs + skew) fail("retrievedAt", "retrieved_in_future", "The retrieval time is in the future.");

  // Metrics — the source's own, in range, never invented.
  const declared = new Map(source.metrics.map((metric) => [metric.key, metric]));
  const metrics: Record<string, MetricValue> = {};
  const submitted = raw.metrics ?? {};
  for (const key of Object.keys(submitted).sort()) {
    if (!declared.has(key)) fail(`metrics.${key}`, "unknown_metric", `${source.name} does not define this metric.`);
  }
  for (const definition of source.metrics) {
    const value = submitted[definition.key];
    if (value === undefined) {
      metrics[definition.key] = { status: "unavailable", reason: "not_collected" };
      continue;
    }
    if (value.status === "unavailable") {
      metrics[definition.key] = { status: "unavailable", reason: value.reason };
      continue;
    }
    const path = `metrics.${definition.key}`;
    if (!Number.isFinite(value.value)) fail(path, "metric_not_finite", "The metric must be a finite number.");
    else if (definition.integer && !Number.isInteger(value.value)) fail(path, "metric_not_integer", "This metric is a whole number.");
    else if (value.value < definition.min || (definition.max !== null && value.value > definition.max)) {
      fail(path, "metric_out_of_range", `This metric must be between ${definition.min} and ${definition.max ?? "unbounded"}.`);
    }
    // The definition in force when the provider reported the value.
    const inForce = retrieved === null ? null : definitionVersionAt(definition, retrieved);
    let versionId = inForce?.id ?? "";
    if (value.definitionVersion !== undefined) {
      if (!definition.versions.some((version) => version.id === value.definitionVersion)) {
        fail(`${path}.definitionVersion`, "unknown_metric_definition", "This metric has no definition version with that id.");
      } else if (retrieved !== null && value.definitionVersion !== inForce?.id) {
        fail(`${path}.definitionVersion`, "metric_definition_not_in_effect", "That definition was not in force when the value was retrieved.");
      }
      versionId = value.definitionVersion;
    } else if (retrieved !== null && inForce === null) {
      fail(`${path}.definitionVersion`, "metric_definition_not_in_effect", "No definition of this metric was in force when the value was retrieved.");
    }
    metrics[definition.key] = { status: "measured", value: value.value, definitionVersion: versionId };
  }

  // Evidence — attributed, from this source, timestamped, linked when required.
  const evidence = raw.evidence.map((entry, index) => {
    const path = `evidence.${index}`;
    if (entry.sourceId !== sourceId) fail(`${path}.sourceId`, "evidence_source_mismatch", "Evidence must come from the observation's own source.");
    if (entry.attribution.trim().length === 0) fail(`${path}.attribution`, "missing_attribution", "Evidence must name its source.");
    const at = parseInstant(entry.retrievedAt);
    if (at === null) fail(`${path}.retrievedAt`, "invalid_timestamp", "Expected an ISO 8601 instant with a timezone.");
    else if (at > nowMs + skew) fail(`${path}.retrievedAt`, "retrieved_in_future", "The evidence retrieval time is in the future.");
    if (entry.url === null) {
      if (source.requiresEvidenceUrl) fail(`${path}.url`, "evidence_url_required", `${source.name} evidence must link to a public page.`);
    } else if (!isSecureUrl(entry.url)) {
      fail(`${path}.url`, "evidence_url_invalid", "Evidence links must be public https URLs without credentials.");
    } else if (platform === "youtube" && raw.subject.providerItemId !== undefined) {
      const linked = youTubeVideoIdFromUrl(entry.url);
      if (linked !== null && linked !== raw.subject.providerItemId) {
        fail(`${path}.url`, "evidence_item_mismatch", "The evidence links to a different video than the observation's item.");
      }
    }
    return { sourceId, url: entry.url, attribution: entry.attribution.trim(), retrievedAt: at === null ? entry.retrievedAt : new Date(at).toISOString() };
  });

  if (issues.length > 0 || start === null || end === null || retrieved === null || normalized === null) {
    return { ok: false, issues };
  }

  return {
    ok: true,
    value: {
      id: raw.id,
      sourceId,
      platform: platform as TrendObservation["platform"],
      market: { country, language },
      subject: { kind: kind as TrendObservation["subject"]["kind"], text: raw.subject.text.trim(), normalized },
      item,
      window: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      retrievedAt: new Date(retrieved).toISOString(),
      metrics,
      evidence,
    },
  };
}

export type BatchParseResult = {
  valid: TrendObservation[];
  rejected: Array<{ index: number; issues: ValidationIssue[] }>;
};

/** Validates many raw observations. Order of `valid` follows input order; rejected items keep their index. */
export function parseTrendObservations(inputs: readonly unknown[], options: ParseOptions): BatchParseResult {
  const valid: TrendObservation[] = [];
  const rejected: BatchParseResult["rejected"] = [];
  inputs.forEach((input, index) => {
    const result = parseTrendObservation(input, options);
    if (result.ok) valid.push(result.value);
    else rejected.push({ index, issues: result.issues });
  });
  return { valid, rejected };
}
