/**
 * Trend Intelligence Engine — Stage 1 core types and source registry.
 *
 * Pure data and types: no I/O, no network, no database, no AI, no merchant
 * data and no clock reads. Every function that needs "now" takes it as an
 * argument, so the same input always produces the same output.
 *
 * Ground rules encoded here and enforced by schema.ts:
 *   - A trend observation always names exactly one registered source, one
 *     platform that source covers, and one market (country + language).
 *   - Metrics are defined BY THE SOURCE. A metric's key, unit and meaning are
 *     the source's own; metrics from different sources are never combined.
 *   - A metric the source did not provide is `unavailable` with a reason —
 *     never zero, never estimated.
 *   - No source below is connected in Stage 1. The registry describes what a
 *     future connector may submit; it does not fetch anything.
 */

/* ──────────────────────────────────────────────────────────────
   Platforms, subjects, markets
   ────────────────────────────────────────────────────────────── */

/**
 * Where a trend was observed. `web` is the public web (news, official
 * announcements) as read by a reviewer: it has no content items and no metrics.
 */
export const TREND_PLATFORMS = ["google_search", "youtube", "instagram", "tiktok", "web"] as const;
export type TrendPlatform = (typeof TREND_PLATFORMS)[number];

/** What the trend is about. A source declares which kinds it can report. */
export const TREND_SUBJECT_KINDS = ["search_query", "topic", "hashtag", "sound", "video", "format"] as const;
export type TrendSubjectKind = (typeof TREND_SUBJECT_KINDS)[number];

/**
 * A market is one country plus one language.
 *   - `country`: ISO 3166-1 alpha-2, upper case (e.g. "AE", "IN", "HK").
 *   - `language`: one of the registered TREND_LANGUAGES tags (a strict
 *     BCP 47 subset: language, plus a script where it matters, e.g.
 *     "zh-Hans" vs "zh-Hant"), or "und" (undetermined) when the source does
 *     not report language or the trend is not language-specific.
 * "und" is its own bucket: it is never treated as matching a real language,
 * and two different tags (e.g. zh-Hans and zh-Hant) never match each other.
 */
export type TrendMarket = { country: string; language: string };

export const UNDETERMINED_LANGUAGE = "und";

/**
 * Every language tag the engine accepts. Unregistered tags are rejected, so a
 * typo or an ambiguous tag (bare "zh", "tl", "en-US") can never create a new
 * silent market bucket. Add a tag here deliberately when a market needs it.
 */
export const TREND_LANGUAGES = {
  en: "English",
  ar: "Arabic",
  hi: "Hindi",
  "zh-Hans": "Chinese (Simplified)",
  "zh-Hant": "Chinese (Traditional)",
  tr: "Turkish",
  ms: "Malay",
  id: "Indonesian",
  th: "Thai",
  vi: "Vietnamese",
  fil: "Filipino",
} as const;
export type TrendLanguage = keyof typeof TREND_LANGUAGES;

export function isTrendLanguage(value: unknown): value is TrendLanguage {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TREND_LANGUAGES, value);
}

/**
 * Voom's INTENDED target markets (product decision, 2026-10-11).
 * These are where Voom wants trend intelligence eventually. They say nothing
 * about whether any source actually covers them — see SourceCoverage.
 */
export type TargetMarket = { country: string; name: string; languages: readonly TrendLanguage[] };

export const TARGET_MARKETS = [
  { country: "AE", name: "United Arab Emirates", languages: ["en", "ar"] },
  { country: "IN", name: "India", languages: ["en", "hi"] },
  { country: "CN", name: "China (mainland)", languages: ["zh-Hans"] },
  { country: "HK", name: "Hong Kong", languages: ["zh-Hant", "en"] },
  { country: "TR", name: "Turkey", languages: ["tr", "en"] },
  { country: "SG", name: "Singapore", languages: ["en", "zh-Hans"] },
  { country: "MY", name: "Malaysia", languages: ["ms", "en"] },
  { country: "ID", name: "Indonesia", languages: ["id"] },
  { country: "TH", name: "Thailand", languages: ["th"] },
  { country: "VN", name: "Vietnam", languages: ["vi"] },
  { country: "PH", name: "Philippines", languages: ["fil", "en"] },
] as const satisfies readonly TargetMarket[];

/**
 * Whether a source has been CHECKED to cover a platform in a country.
 *   verified    — checked against the provider (requires checkedAt + evidence)
 *   unavailable — checked: the source does not cover it
 *   unverified  — not checked (the default for everything not listed)
 * Only "verified" coverage lets observations count as evidence. Nothing is
 * verified in Stage 1, so no trend availability is claimed anywhere.
 */
export type SourceCoverage = {
  sourceId: string;
  platform: TrendPlatform;
  country: string;
  status: "verified" | "unavailable" | "unverified";
  /** ISO 8601 instant of the check; required for verified/unavailable. */
  checkedAt: string | null;
  /** How it was checked (e.g. "i18nRegions.list returned AE"); required for verified/unavailable. */
  evidence: string | null;
};

/** No coverage has been verified yet. Stage 2 records real checks here. */
export const DEFAULT_SOURCE_COVERAGE: readonly SourceCoverage[] = [];

/**
 * Whether Voom has APPROVED using a source's data (legal, policy and product
 * review). Technical support, API availability and verified coverage never
 * imply this. Unlisted sources are "not_reviewed" and are never used.
 */
export type SourceAuthorization = {
  sourceId: string;
  status: "approved" | "not_approved" | "under_review";
  /** ISO 8601 instant of the decision; required for approved/not_approved. */
  decidedAt: string | null;
  /** Who decided; required for approved/not_approved. */
  decidedBy: string | null;
  /** The approval record (ticket, document); required for approved. */
  reference: string | null;
};

/** No source is approved for use yet. */
export const DEFAULT_SOURCE_AUTHORIZATIONS: readonly SourceAuthorization[] = [];

/** What the engine may use: intended targets, checked coverage and approved sources. */
export type MarketPolicy = {
  targets: readonly TargetMarket[];
  coverage: readonly SourceCoverage[];
  authorizations: readonly SourceAuthorization[];
};

/* ──────────────────────────────────────────────────────────────
   Metrics
   ────────────────────────────────────────────────────────────── */

/**
 *   relative_index  — rescaled within ONE request (e.g. the Google Trends
 *                     website's 0–100); never comparable across requests
 *   scaled_interest — provider-scaled consistently across requests, but not
 *                     an absolute volume (e.g. the Google Trends API alpha)
 *   count           — a raw tally reported by the source
 *   rank            — a 1-based position in a source-defined list
 */
export type MetricUnit = "relative_index" | "scaled_interest" | "count" | "rank";

/**
 * One meaning of a metric over time. Providers redefine metrics; values
 * recorded under different versions are never comparable. Versions of a
 * metric are in time order and do not overlap.
 */
export type MetricDefinitionVersion = {
  id: string;
  /** The source's own meaning. Never reinterpreted or converted. */
  definition: string;
  /** Inclusive ISO 8601 start of this meaning, or null if open-ended. */
  effectiveFrom: string | null;
  /** Exclusive ISO 8601 end of this meaning, or null if still current. */
  effectiveUntil: string | null;
};

export type MetricDefinition = {
  key: string;
  label: string;
  unit: MetricUnit;
  versions: readonly MetricDefinitionVersion[];
  min: number;
  max: number | null;
  integer: boolean;
  /** Required for a "complete" observation (see confidence.ts). */
  required: boolean;
};

export const UNAVAILABLE_REASONS = [
  "not_provided_by_source",
  "hidden_by_owner",
  "below_reporting_threshold",
  "not_collected",
  "collection_failed",
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/**
 * A metric is either a value the source reported — always tagged with the
 * definition version it was reported under — or explicitly unavailable.
 */
export type MetricValue =
  | { status: "measured"; value: number; definitionVersion: string }
  | { status: "unavailable"; reason: UnavailableReason };

/* ──────────────────────────────────────────────────────────────
   Content items (provider identity)
   ────────────────────────────────────────────────────────────── */

/**
 * A content item is ONE specific thing on a platform (a video, a sound),
 * identified by the provider's own id. It is distinct from the TOPIC (its
 * text): two different videos can share a title, and one video can be
 * retitled. Items are namespaced by platform, so the same id string on two
 * platforms never refers to the same item.
 *
 *   required — the subject kind IS an item (a video must carry its id)
 *   optional — an id is recorded when the source provides one (a sound)
 *   none     — the subject is a topic, never an item
 */
export const ITEM_IDENTITY_BY_KIND = {
  video: "required",
  sound: "optional",
  search_query: "none",
  topic: "none",
  hashtag: "none",
  format: "none",
} as const satisfies Record<TrendSubjectKind, "required" | "optional" | "none">;

/** Accepted provider id formats per platform; null = the platform has no content items. */
export const PROVIDER_ITEM_ID_PATTERNS: Record<TrendPlatform, RegExp | null> = {
  youtube: /^[A-Za-z0-9_-]{11}$/,
  tiktok: /^[0-9]{1,32}$/,
  instagram: /^[A-Za-z0-9_-]{1,64}$/,
  google_search: null,
  web: null,
};

export type TrendItem = {
  platform: TrendPlatform;
  kind: TrendSubjectKind;
  /** The provider's own id, exactly as issued (case-sensitive). */
  providerItemId: string;
};

/* ──────────────────────────────────────────────────────────────
   Sources
   ────────────────────────────────────────────────────────────── */

/**
 * How long an observation stays useful, measured from the END of the period
 * it describes (age = now − window.end):
 *
 *   fresh   — 0 ≤ age ≤ freshForMs
 *   aging   — freshForMs < age ≤ staleAfterMs
 *   stale   — staleAfterMs < age ≤ expiresAfterMs   (usable, but weak)
 *   expired — age > expiresAfterMs                   (never used)
 *
 * The per-source values below are PROVISIONAL PRODUCT SETTINGS chosen by
 * Voom (approved as initial defaults on 2026-10-11). They are not freshness
 * rules defined by any provider, and a caller may override them with an
 * explicit, validated policy.
 */
export type FreshnessPolicy = {
  freshForMs: number;
  staleAfterMs: number;
  expiresAfterMs: number;
};

export const FRESHNESS_POLICY_BASIS = "provisional_product_default" as const;

/**
 * Governance periods (Stage 2D). PROVISIONAL PRODUCT DEFAULTS, not legal
 * conclusions. Mirrored exactly by the trend_*_period() functions in
 * supabase/proposed/trend_intelligence_governance.sql (a test fails on drift).
 * Source content retention stays source-specific (trend_sources.max_retention_days;
 * YouTube at most 30 days) and is not changed by these.
 */
export const TREND_GOVERNANCE_SETTINGS = {
  basis: "provisional_product_default",
  /** An approval older than this no longer permits use of a source. */
  authorizationReviewDays: 365,
  /** A coverage check older than this no longer verifies a market. */
  coverageReviewDays: 180,
  /** Policy and correction audit history is deleted after this. */
  auditRetentionDays: 730,
  /** Purge-run records are deleted after this. */
  purgeRunRetentionDays: 90,
} as const;

/**
 * What the provider's official documentation says about programmatic access,
 * as last checked by Voom. A documented API is NOT permission to use it.
 */
export type ApiAvailability = {
  status: "generally_available" | "restricted_alpha" | "no_public_api" | "not_applicable";
  note: string;
  /** Official documentation consulted. */
  reference: string | null;
  checkedAt: string;
};

/**
 * Five separate facts about a source — none implies another:
 *   dataSchema      — Voom can validate this source's data (this registry)
 *   apiAvailability — what the provider documents (static, dated)
 *   coverage        — checked per platform × country (MarketPolicy.coverage)
 *   authorization   — Voom's approval to use it (MarketPolicy.authorizations)
 *   connection      — whether a live connector exists (none in Stage 1)
 */
export type TrendSourceDefinition = {
  id: string;
  name: string;
  provider: "google" | "youtube" | "wikimedia" | "voom";
  dataSchema: "supported";
  apiAvailability: ApiAvailability;
  /** Platforms this source can describe. An observation's platform must be one of them. */
  platforms: readonly TrendPlatform[];
  subjectKinds: readonly TrendSubjectKind[];
  /**
   * "not_reported": the source has no language dimension; language must be "und".
   * "optional": a registered language tag when the trend is language-specific,
   *             or "und" when it is a country-level trend across languages.
   */
  languageScope: "not_reported" | "optional";
  /** Whether every evidence item must link to a public https URL. */
  requiresEvidenceUrl: boolean;
  metrics: readonly MetricDefinition[];
  freshness: FreshnessPolicy;
  /** Whether a reviewed, server-only connector exists. Permission remains a separate decision. */
  connection: "not_connected" | "connected";
};

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const CHECKED_2026_10_11 = "2026-10-11T00:00:00Z";
/** YouTube's documented view-count change ("Starting August 24, 2026"); the docs give no time zone, so UTC midnight is used. */
export const YOUTUBE_VIEW_COUNT_CHANGE = "2026-08-24T00:00:00Z";

export const TREND_SOURCES = {
  google_trends_web: {
    id: "google_trends_web",
    name: "Google Trends website",
    provider: "google",
    dataSchema: "supported",
    apiAvailability: {
      status: "no_public_api",
      note: "Values are read from the public Google Trends website, which rescales each request to 0–100. The website is not an API.",
      reference: "https://developers.google.com/search/apis/trends",
      checkedAt: CHECKED_2026_10_11,
    },
    platforms: ["google_search"],
    subjectKinds: ["search_query", "topic"],
    languageScope: "not_reported",
    // The explore URL records the request (terms, market, period) the index is relative to.
    requiresEvidenceUrl: true,
    metrics: [
      {
        key: "interest_index",
        label: "Search interest (website index)",
        unit: "relative_index",
        versions: [
          {
            id: "google_trends_web.interest_index.v1",
            definition:
              "Google Trends website search interest, scaled 0–100 against the peak within that single request (terms, market and period). Not a search volume and not comparable across separate requests.",
            effectiveFrom: null,
            effectiveUntil: null,
          },
        ],
        min: 0,
        max: 100,
        integer: true,
        required: true,
      },
    ],
    freshness: { freshForMs: 3 * DAY, staleAfterMs: 7 * DAY, expiresAfterMs: 30 * DAY },
    connection: "not_connected",
  },
  google_trends_api: {
    id: "google_trends_api",
    name: "Google Trends API (alpha)",
    provider: "google",
    dataSchema: "supported",
    apiAvailability: {
      status: "restricted_alpha",
      note: "Alpha; access by application for a limited set of developers. Values are consistently scaled across requests (not the website's 0–100) and are not absolute search volumes.",
      reference: "https://developers.google.com/search/apis/trends",
      checkedAt: CHECKED_2026_10_11,
    },
    platforms: ["google_search"],
    subjectKinds: ["search_query", "topic"],
    languageScope: "not_reported",
    requiresEvidenceUrl: false,
    metrics: [
      {
        key: "scaled_interest",
        label: "Search interest (API scaled)",
        unit: "scaled_interest",
        versions: [
          {
            id: "google_trends_api.scaled_interest.alpha",
            definition:
              "Search interest as returned by the Google Trends API (alpha): consistently scaled across requests, unlike the website's per-request 0–100 index, and not an absolute search volume. The alpha scale may change; values are only comparable within this definition version.",
            effectiveFrom: null,
            effectiveUntil: null,
          },
        ],
        min: 0,
        max: null,
        integer: false,
        required: true,
      },
    ],
    freshness: { freshForMs: 3 * DAY, staleAfterMs: 7 * DAY, expiresAfterMs: 30 * DAY },
    connection: "not_connected",
  },
  youtube_data_api: {
    id: "youtube_data_api",
    name: "YouTube Data API (most popular chart)",
    provider: "youtube",
    dataSchema: "supported",
    apiAvailability: {
      status: "generally_available",
      note: "videos.list with chart=mostPopular and regionCode; 1 quota unit per request (default 10,000 units/day). Use is governed by the YouTube API Services Terms and Developer Policies, which restrict derived metrics, aggregation and storage.",
      reference: "https://developers.google.com/youtube/v3/docs/videos/list",
      checkedAt: CHECKED_2026_10_11,
    },
    platforms: ["youtube"],
    subjectKinds: ["video"],
    languageScope: "not_reported",
    requiresEvidenceUrl: false,
    // statistics.favoriteCount is deliberately absent: YouTube documents it as
    // deprecated since 2015 and always 0, so recording it would be a fabricated zero.
    metrics: [
      {
        key: "chart_rank",
        label: "Chart position",
        unit: "rank",
        versions: [
          {
            id: "youtube_data_api.chart_rank.v1",
            definition: "1-based position of the video in the order returned by videos.list chart=mostPopular for the region at retrieval time.",
            effectiveFrom: null,
            effectiveUntil: null,
          },
        ],
        min: 1,
        max: null,
        integer: true,
        required: true,
      },
      {
        key: "view_count",
        label: "Views",
        unit: "count",
        versions: [
          {
            id: "youtube_data_api.view_count.v1",
            definition: "statistics.viewCount as reported by the YouTube Data API at retrieval time, under YouTube's view definition before 2026-08-24.",
            effectiveFrom: null,
            effectiveUntil: YOUTUBE_VIEW_COUNT_CHANGE,
          },
          {
            id: "youtube_data_api.view_count.v2",
            definition: "statistics.viewCount as reported by the YouTube Data API at retrieval time; from 2026-08-24 YouTube counts a view the moment a video begins to play. Not comparable with v1 values.",
            effectiveFrom: YOUTUBE_VIEW_COUNT_CHANGE,
            effectiveUntil: null,
          },
        ],
        min: 0,
        max: null,
        integer: true,
        required: true,
      },
      {
        key: "like_count",
        label: "Likes",
        unit: "count",
        versions: [
          {
            id: "youtube_data_api.like_count.v1",
            definition: "statistics.likeCount as reported by the YouTube Data API at retrieval time; recorded as unavailable whenever the API omits it.",
            effectiveFrom: null,
            effectiveUntil: null,
          },
        ],
        min: 0,
        max: null,
        integer: true,
        required: false,
      },
      {
        key: "comment_count",
        label: "Comments",
        unit: "count",
        versions: [
          {
            id: "youtube_data_api.comment_count.v1",
            definition: "statistics.commentCount as reported by the YouTube Data API at retrieval time; recorded as unavailable whenever the API omits it.",
            effectiveFrom: null,
            effectiveUntil: null,
          },
        ],
        min: 0,
        max: null,
        integer: true,
        required: false,
      },
    ],
    freshness: { freshForMs: 1 * DAY, staleAfterMs: 3 * DAY, expiresAfterMs: 7 * DAY },
    connection: "not_connected",
  },
  manual_research: {
    id: "manual_research",
    name: "Voom manual research",
    provider: "voom",
    dataSchema: "supported",
    apiAvailability: {
      status: "not_applicable",
      note: "Recorded by Voom reviewers from public pages, each with a link to its evidence.",
      reference: null,
      checkedAt: CHECKED_2026_10_11,
    },
    platforms: ["google_search", "youtube", "instagram", "tiktok", "web"],
    subjectKinds: ["search_query", "topic", "hashtag", "sound", "video", "format"],
    languageScope: "optional",
    requiresEvidenceUrl: true,
    // Qualitative: a reviewer records that a trend exists and links the public
    // evidence. It carries no numbers, so it can never contribute a statistic.
    metrics: [],
    freshness: { freshForMs: 7 * DAY, staleAfterMs: 14 * DAY, expiresAfterMs: 30 * DAY },
    connection: "not_connected",
  },
  wikidata_events: {
    id: "wikidata_events",
    name: "Wikidata event records",
    provider: "wikimedia",
    dataSchema: "supported",
    apiAvailability: {
      status: "generally_available",
      note: "Structured Wikidata event records queried through the public Wikidata Query Service. Wikidata structured data is CC0; the connector uses no popularity metric and retains entity attribution.",
      reference: "https://www.wikidata.org/wiki/Wikidata:Licensing",
      checkedAt: "2026-10-12T00:00:00Z",
    },
    platforms: ["web"],
    subjectKinds: ["topic"],
    languageScope: "optional",
    requiresEvidenceUrl: true,
    metrics: [],
    freshness: { freshForMs: 1 * DAY, staleAfterMs: 3 * DAY, expiresAfterMs: 14 * DAY },
    connection: "connected",
  },
} as const satisfies Record<string, TrendSourceDefinition>;

export type TrendSourceId = keyof typeof TREND_SOURCES;
export const TREND_SOURCE_IDS = Object.keys(TREND_SOURCES) as TrendSourceId[];

export function isTrendSourceId(value: unknown): value is TrendSourceId {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(TREND_SOURCES, value);
}

export function trendSource(id: TrendSourceId): TrendSourceDefinition {
  return TREND_SOURCES[id];
}

/* ──────────────────────────────────────────────────────────────
   Observations
   ────────────────────────────────────────────────────────────── */

/** Who/what supports the observation. At least one per observation. */
export type TrendEvidence = {
  sourceId: TrendSourceId;
  /** Public https URL of the evidence, or null when the source has none to link. */
  url: string | null;
  /** Human-readable attribution, e.g. "Google Trends". */
  attribution: string;
  /** When this piece of evidence was retrieved (ISO 8601, UTC). */
  retrievedAt: string;
};

/** The TOPIC of an observation: what it is about, as text. */
export type TrendSubject = {
  kind: TrendSubjectKind;
  /** As submitted (trimmed). Shown to people. */
  text: string;
  /** Deterministic comparison form (see dedupe.ts). Used for keys only. */
  normalized: string;
};

/** A validated observation. Produce these only through schema.ts. */
export type TrendObservation = {
  /** Caller-supplied opaque id; used only for deterministic tie-breaking. */
  id: string;
  sourceId: TrendSourceId;
  platform: TrendPlatform;
  market: TrendMarket;
  subject: TrendSubject;
  /** The specific content item, when the subject is (or carries) one. */
  item: TrendItem | null;
  /** The period the metrics describe (ISO 8601, UTC). */
  window: { start: string; end: string };
  /** When the observation was retrieved from the source (ISO 8601, UTC). */
  retrievedAt: string;
  /** Exactly the source's declared metric keys. Missing ones are `unavailable`. */
  metrics: Readonly<Record<string, MetricValue>>;
  evidence: readonly TrendEvidence[];
};

/* ──────────────────────────────────────────────────────────────
   Results
   ────────────────────────────────────────────────────────────── */

export type ValidationIssue = { path: string; code: string; message: string };

export type ParseResult<T> = { ok: true; value: T } | { ok: false; issues: ValidationIssue[] };
