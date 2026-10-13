/**
 * Trend Intelligence Engine — Stage 1: freshness, deduplication, confidence
 * and isolation (lib/trends/{freshness,dedupe,confidence}.ts).
 *
 * WHAT THIS FILE PINS
 *   - freshness status boundaries per source policy, expiry, and policy
 *     validation; "now" is always explicit;
 *   - subject normalization (Unicode, invisible characters, case, hashtags);
 *   - duplicates are only same source + same trend + same window; the newest
 *     retrieval wins deterministically; id reuse is a reported conflict;
 *   - grouping NEVER mixes platforms, countries, languages or subject kinds,
 *     and never merges metrics;
 *   - confidence is a category with reasons, derived from evidence only:
 *     unsupported markets and expired evidence are insufficient, missing
 *     metrics are never zero, no numeric score is produced;
 *   - every result is independent of input order;
 *   - the module performs no I/O, reads no clock or environment, and is not
 *     wired into MARA, the frontend or any route.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { assessFreshness, isExpired, partitionByExpiry, assertValidFreshnessPolicy, FreshnessPolicyError } = await import("../lib/trends/freshness.ts");
const { normalizeSubjectText, trendKey, dedupeObservations, groupObservationsByTrend } = await import("../lib/trends/dedupe.ts");
const { classifyTrendConfidence, createMarketPolicy, targetMarketStatus, sourceCoverageStatus, MarketPolicyError } = await import("../lib/trends/confidence.ts");
const { TARGET_MARKETS, DEFAULT_SOURCE_COVERAGE, FRESHNESS_POLICY_BASIS } = await import("../lib/trends/types.ts");

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 9, 11, 12, 0, 0);
const iso = (ms) => new Date(ms).toISOString();
// TEST FIXTURE ONLY: coverage marked verified so evidence can be exercised. In
// the shipped defaults nothing is verified (see the default-policy tests).
const verified = (sourceId, platform, country) => ({ sourceId, platform, country, status: "verified", checkedAt: "2026-10-01T00:00:00Z", evidence: "test fixture" });
const approved = (sourceId) => ({ sourceId, status: "approved", decidedAt: "2026-10-01T00:00:00Z", decidedBy: "test", reference: "test fixture" });
const APPROVED = ["google_trends_web", "google_trends_api", "youtube_data_api", "manual_research"].map(approved);
const MARKETS = createMarketPolicy({
  authorizations: APPROVED,
  coverage: [
    verified("google_trends_web", "google_search", "AE"),
    verified("google_trends_web", "google_search", "IN"),
    verified("youtube_data_api", "youtube", "AE"),
    verified("manual_research", "google_search", "AE"),
    verified("manual_research", "google_search", "IN"),
    verified("manual_research", "instagram", "AE"),
    verified("manual_research", "tiktok", "AE"),
  ],
});

/** Builds a VALIDATED observation through the real schema. */
/** A valid 11-character YouTube-style id derived from the fixture id. */
const videoId = (id) => `${id.replace(/[^A-Za-z0-9_-]/g, "")}___________`.slice(0, 11);

function observe({ id, source = "google_trends_web", platform, country = "AE", language, kind, text = "Ramadan recipes", endAgoMs = 0, retrievedAgoMs, metrics, evidenceUrl, itemId }) {
  const end = NOW - endAgoMs;
  const retrieved = NOW - (retrievedAgoMs ?? endAgoMs);
  const defaults = {
    google_trends_web: { platform: "google_search", language: "und", kind: "search_query", metrics: { interest_index: { status: "measured", value: 80 } }, url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes" },
    youtube_data_api: { platform: "youtube", language: "und", kind: "video", metrics: { chart_rank: { status: "measured", value: 2 }, view_count: { status: "measured", value: 125000 } }, url: null },
    manual_research: { platform: "google_search", language: "en", kind: "search_query", metrics: undefined, url: "https://example.com/report" },
  }[source];
  const resolvedKind = kind ?? defaults.kind;
  const providerItemId = itemId ?? (resolvedKind === "video" ? videoId(id) : undefined);
  const result = parseTrendObservation(
    {
      id,
      sourceId: source,
      platform: platform ?? defaults.platform,
      market: { country, language: language ?? defaults.language },
      subject: { kind: resolvedKind, text, ...(providerItemId === undefined ? {} : { providerItemId }) },
      window: { start: iso(end - DAY), end: iso(end) },
      retrievedAt: iso(retrieved),
      ...(metrics === null ? {} : { metrics: metrics ?? defaults.metrics }),
      evidence: [{ sourceId: source, url: evidenceUrl === undefined ? defaults.url : evidenceUrl, attribution: source, retrievedAt: iso(retrieved) }],
    },
    { now: NOW },
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}

const shuffle = (list, seed) => {
  // Deterministic permutation for order-independence checks.
  const out = [...list];
  let state = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const j = state % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
};

/* ──────────────────────────────────────────────────────────────
   Freshness and expiry
   ────────────────────────────────────────────────────────────── */

test("freshness boundaries follow the source policy exactly (Google Trends: 3d / 7d / 30d)", () => {
  const at = (ageMs) => assessFreshness({ sourceId: "google_trends_web", window: { start: iso(NOW - ageMs - DAY), end: iso(NOW - ageMs) } }, NOW).status;
  assert.equal(at(0), "fresh");
  assert.equal(at(3 * DAY), "fresh");
  assert.equal(at(3 * DAY + 1), "aging");
  assert.equal(at(7 * DAY), "aging");
  assert.equal(at(7 * DAY + 1), "stale");
  assert.equal(at(30 * DAY), "stale");
  assert.equal(at(30 * DAY + 1), "expired");
});

test("each source has its own policy, and expiry dates are reported", () => {
  const youtube = observe({ id: "yt", source: "youtube_data_api", endAgoMs: 2 * DAY });
  const google = observe({ id: "gt", endAgoMs: 2 * DAY });
  assert.equal(assessFreshness(youtube, NOW).status, "aging", "YouTube charts age after 1 day");
  assert.equal(assessFreshness(google, NOW).status, "fresh", "search interest stays fresh for 3 days");
  assert.equal(assessFreshness(google, NOW).expiresAt, iso(NOW - 2 * DAY + 30 * DAY));
  assert.equal(isExpired(youtube, NOW + 6 * DAY), true);
  assert.equal(isExpired(youtube, NOW), false);
});

test("a window ending in the future has age 0 rather than a negative age", () => {
  const assessment = assessFreshness({ sourceId: "google_trends_web", window: { start: iso(NOW), end: iso(NOW + 60_000) } }, NOW);
  assert.equal(assessment.ageMs, 0);
  assert.equal(assessment.status, "fresh");
});

test("custom policies are validated; bad evaluation times are refused", () => {
  const obs = { sourceId: "google_trends_web", window: { start: iso(NOW - DAY), end: iso(NOW) } };
  assert.equal(assessFreshness(obs, NOW, { freshForMs: HOUR, staleAfterMs: 2 * HOUR, expiresAfterMs: 3 * HOUR }).status, "fresh");
  for (const policy of [
    { freshForMs: 0, staleAfterMs: 1, expiresAfterMs: 2 },
    { freshForMs: 3, staleAfterMs: 2, expiresAfterMs: 4 },
    { freshForMs: 1, staleAfterMs: 2, expiresAfterMs: Number.POSITIVE_INFINITY },
    { freshForMs: 1, staleAfterMs: Number.NaN, expiresAfterMs: 4 },
  ]) {
    assert.throws(() => assertValidFreshnessPolicy(policy), FreshnessPolicyError, JSON.stringify(policy));
  }
  assert.throws(() => assessFreshness(obs, "not a time"), FreshnessPolicyError);
});

test("expired observations are separated without reordering the rest", () => {
  const a = observe({ id: "a", endAgoMs: DAY });
  const b = observe({ id: "b", endAgoMs: 31 * DAY });
  const c = observe({ id: "c", endAgoMs: 2 * DAY });
  const { usable, expired } = partitionByExpiry([a, b, c], NOW);
  assert.deepEqual(usable.map((o) => o.id), ["a", "c"]);
  assert.deepEqual(expired.map((o) => o.id), ["b"]);
});

/* ──────────────────────────────────────────────────────────────
   Normalization and duplicate detection
   ────────────────────────────────────────────────────────────── */

test("subject normalization is Unicode-, case- and whitespace-insensitive, and locale-independent", () => {
  assert.equal(normalizeSubjectText("hashtag", "#ＥｉｄＯｕｔｆｉｔｓ"), "eidoutfits", "full-width letters fold");
  assert.equal(normalizeSubjectText("hashtag", "##Eid​Outfits"), "eidoutfits", "zero-width characters removed");
  assert.equal(normalizeSubjectText("topic", "  Ramadan\t\tRecipes \n"), "ramadan recipes");
  assert.equal(normalizeSubjectText("topic", "#Ramadan"), "#ramadan", "only hashtags drop the leading #");
  assert.equal(normalizeSubjectText("topic", "İstanbul"), "i̇stanbul", "lower-casing does not depend on the machine's locale");
  assert.equal(normalizeSubjectText("topic", "رمضان"), "رمضان", "non-Latin scripts are preserved");
});

test("repeat reports from one source for one window collapse to the newest retrieval", () => {
  const older = observe({ id: "gt-old", endAgoMs: HOUR, retrievedAgoMs: HOUR / 2 });
  const newer = observe({ id: "gt-new", endAgoMs: HOUR, retrievedAgoMs: 0, text: "RAMADAN   recipes" });
  const result = dedupeObservations([older, newer]);
  assert.deepEqual(result.kept.map((o) => o.id), ["gt-new"]);
  assert.deepEqual(result.duplicates, [{ keptId: "gt-new", droppedId: "gt-old", reason: "same_source_same_trend_same_window" }]);
  assert.deepEqual(result.conflicts, []);
});

test("equal retrieval times tie-break on id, and the identical record twice is collapsed silently", () => {
  const b = observe({ id: "b", endAgoMs: HOUR });
  const a = observe({ id: "a", endAgoMs: HOUR });
  const result = dedupeObservations([b, a, b]);
  assert.deepEqual(result.kept.map((o) => o.id), ["a"]);
  assert.deepEqual(result.duplicates, [{ keptId: "a", droppedId: "b", reason: "same_source_same_trend_same_window" }]);
});

test("different windows, sources, platforms, countries, languages or kinds are never duplicates", () => {
  const base = observe({ id: "base", endAgoMs: HOUR });
  const others = [
    observe({ id: "other-window", endAgoMs: 2 * DAY }),
    observe({ id: "other-source", source: "manual_research", language: "und", endAgoMs: HOUR }),
    observe({ id: "other-country", country: "IN", endAgoMs: HOUR }),
    observe({ id: "other-kind", kind: "topic", endAgoMs: HOUR }),
    observe({ id: "other-platform", source: "manual_research", platform: "tiktok", language: "en", kind: "search_query" }),
  ];
  const result = dedupeObservations([base, ...others]);
  assert.equal(result.kept.length, 6);
  assert.deepEqual(result.duplicates, []);
});

test("an id reused for a different observation is a reported conflict and both are excluded", () => {
  const a = observe({ id: "dup-id", endAgoMs: HOUR });
  const b = observe({ id: "dup-id", country: "IN", endAgoMs: HOUR });
  const c = observe({ id: "fine", endAgoMs: 2 * HOUR });
  const result = dedupeObservations([a, b, c]);
  assert.deepEqual(result.kept.map((o) => o.id), ["fine"]);
  assert.deepEqual(result.conflicts, [{ id: "dup-id", reason: "same_id_different_observation" }]);
});

test("deduplication and grouping are independent of input order", () => {
  const list = [
    observe({ id: "1", endAgoMs: HOUR, retrievedAgoMs: 0 }),
    observe({ id: "2", endAgoMs: HOUR, retrievedAgoMs: HOUR / 2 }),
    observe({ id: "3", source: "youtube_data_api", text: "Ramadan recipes", endAgoMs: HOUR }),
    observe({ id: "4", country: "IN", endAgoMs: 2 * HOUR }),
    observe({ id: "5", source: "manual_research", language: "ar", text: "رمضان", endAgoMs: DAY }),
  ];
  const expectedDedupe = JSON.stringify(dedupeObservations(list));
  const expectedGroups = JSON.stringify(groupObservationsByTrend(list));
  for (let seed = 1; seed <= 25; seed += 1) {
    const shuffled = shuffle(list, seed);
    assert.equal(JSON.stringify(dedupeObservations(shuffled)), expectedDedupe, `dedupe order ${seed}`);
    assert.equal(JSON.stringify(groupObservationsByTrend(shuffled)), expectedGroups, `grouping order ${seed}`);
  }
});

/* ──────────────────────────────────────────────────────────────
   Grouping — never mixes markets, languages or platforms
   ────────────────────────────────────────────────────────────── */

test("only the same platform + country + language + kind + subject share a group", () => {
  const groups = groupObservationsByTrend([
    observe({ id: "gt-ae", endAgoMs: HOUR }),
    observe({ id: "gt-in", country: "IN", endAgoMs: HOUR }),
    observe({ id: "mr-ae-en", source: "manual_research", language: "en", endAgoMs: HOUR }),
    observe({ id: "mr-ae-ar", source: "manual_research", language: "ar", endAgoMs: HOUR }),
    observe({ id: "mr-tiktok", source: "manual_research", platform: "tiktok", language: "en", endAgoMs: HOUR }),
  ]);
  assert.equal(groups.length, 5, "five distinct markets/platforms/languages, five groups");
  for (const group of groups) {
    const keys = new Set(group.observations.map((o) => trendKey(o)));
    assert.equal(keys.size, 1);
  }
  // Google Trends reports no language ("und"); it never corroborates a language-specific report.
  const und = groups.find((g) => g.market.country === "AE" && g.market.language === "und" && g.platform === "google_search");
  assert.deepEqual(und.sourceIds, ["google_trends_web"]);
  assert.deepEqual(groups.find((g) => g.market.language === "en" && g.platform === "google_search").sourceIds, ["manual_research"]);
});

test("grouping keeps each observation's own metrics — nothing is merged or summed", () => {
  const google = observe({ id: "g", endAgoMs: HOUR, metrics: { interest_index: { status: "measured", value: 40 } } });
  const manual = observe({ id: "m", source: "manual_research", language: "und", endAgoMs: HOUR });
  const [group] = groupObservationsByTrend([manual, google]);
  assert.deepEqual(group.sourceIds, ["google_trends_web", "manual_research"]);
  assert.deepEqual(group.observations.find((o) => o.id === "g").metrics, { interest_index: { status: "measured", value: 40, definitionVersion: "google_trends_web.interest_index.v1" } });
  assert.deepEqual(group.observations.find((o) => o.id === "m").metrics, {});
  assert.equal(Object.hasOwn(group, "metrics"), false, "a group has no combined metrics");
});

/* ──────────────────────────────────────────────────────────────
   Confidence
   ────────────────────────────────────────────────────────────── */

const groupOf = (...observations) => {
  const groups = groupObservationsByTrend(observations);
  assert.equal(groups.length, 1, "test fixture must form one group");
  return groups[0];
};
const classify = (group, markets = MARKETS, now = NOW) => classifyTrendConfidence(group, { now, markets });

test("the intended target markets are exactly the approved list (2026-10-11)", () => {
  assert.deepEqual(
    TARGET_MARKETS.map((market) => [market.country, [...market.languages]]),
    [
      ["AE", ["en", "ar"]],
      ["IN", ["en", "hi"]],
      ["CN", ["zh-Hans"]],
      ["HK", ["zh-Hant", "en"]],
      ["TR", ["tr", "en"]],
      ["SG", ["en", "zh-Hans"]],
      ["MY", ["ms", "en"]],
      ["ID", ["id"]],
      ["TH", ["th"]],
      ["VN", ["vi"]],
      ["PH", ["fil", "en"]],
    ],
  );
  assert.deepEqual(DEFAULT_SOURCE_COVERAGE, [], "no provider coverage is claimed by default");
  assert.equal(FRESHNESS_POLICY_BASIS, "provisional_product_default");
});

test("target-market status: country and language must both be targeted", () => {
  const policy = createMarketPolicy();
  assert.equal(targetMarketStatus({ country: "AE", language: "ar" }, policy), "targeted");
  assert.equal(targetMarketStatus({ country: "AE", language: "und" }, policy), "targeted", "a source with no language dimension");
  assert.equal(targetMarketStatus({ country: "HK", language: "zh-Hant" }, policy), "targeted");
  assert.equal(targetMarketStatus({ country: "HK", language: "zh-Hans" }, policy), "language_not_targeted", "Hong Kong is Traditional Chinese, not Simplified");
  assert.equal(targetMarketStatus({ country: "CN", language: "zh-Hant" }, policy), "language_not_targeted");
  assert.equal(targetMarketStatus({ country: "ID", language: "en" }, policy), "language_not_targeted");
  assert.equal(targetMarketStatus({ country: "US", language: "en" }, policy), "not_target_market");
});

test("by default nothing counts as evidence: no source is approved and no coverage is verified", () => {
  const policy = createMarketPolicy();
  const group = groupOf(observe({ id: "g", endAgoMs: HOUR }));
  const result = classify(group, policy);
  assert.deepEqual([result.level, result.reasons], ["insufficient", ["source_not_authorized"]]);
  assert.deepEqual(result.unauthorizedObservationIds, ["g"]);
  assert.deepEqual(result.supportingSourceIds, []);
  // Approval alone is not enough either: coverage must still be verified.
  const approvedOnly = classify(group, createMarketPolicy({ authorizations: APPROVED }));
  assert.deepEqual([approvedOnly.level, approvedOnly.reasons], ["insufficient", ["source_coverage_unverified"]]);
  assert.deepEqual(approvedOnly.uncoveredObservationIds, ["g"]);
  for (const market of TARGET_MARKETS) {
    for (const platform of ["google_search", "youtube", "instagram", "tiktok", "web"]) {
      assert.equal(sourceCoverageStatus("manual_research", platform, market.country, policy), "unverified");
    }
  }
});

test("coverage checked as unavailable is reported as such", () => {
  const policy = createMarketPolicy({
    authorizations: APPROVED,
    coverage: [{ sourceId: "google_trends_web", platform: "google_search", country: "AE", status: "unavailable", checkedAt: "2026-10-01T00:00:00Z", evidence: "provider review" }],
  });
  const result = classify(groupOf(observe({ id: "g", endAgoMs: HOUR })), policy);
  assert.deepEqual([result.level, result.reasons], ["insufficient", ["source_coverage_unavailable"]]);
});

test("only verified sources count; unverified ones in the same group are listed, not used", () => {
  const policy = createMarketPolicy({ authorizations: APPROVED, coverage: [verified("manual_research", "google_search", "AE")] });
  const google = observe({ id: "g", endAgoMs: HOUR });
  const manual = observe({ id: "m", source: "manual_research", language: "und", endAgoMs: HOUR });
  const result = classify(groupOf(google, manual), policy);
  assert.deepEqual(result.supportingSourceIds, ["manual_research"]);
  assert.deepEqual(result.uncoveredObservationIds, ["g"]);
  assert.equal(result.level, "low", "a single qualitative report once Google Trends is excluded");
});

test("market policies are validated: coverage claims must say when and how they were checked", () => {
  assert.throws(() => createMarketPolicy({ targets: [{ country: "uae", name: "x", languages: ["en"] }] }), MarketPolicyError);
  assert.throws(() => createMarketPolicy({ targets: [{ country: "AE", name: "x", languages: ["en-US"] }] }), MarketPolicyError);
  assert.throws(() => createMarketPolicy({ targets: [{ country: "AE", name: "x", languages: [] }] }), MarketPolicyError);
  assert.throws(() => createMarketPolicy({ targets: [{ country: "AE", name: "x", languages: ["en"] }, { country: "AE", name: "y", languages: ["ar"] }] }), MarketPolicyError);
  const base = { sourceId: "google_trends_web", platform: "google_search", country: "AE" };
  for (const bad of [
    { ...base, status: "verified", checkedAt: null, evidence: "x" },
    { ...base, status: "verified", checkedAt: "2026-10-01T00:00:00Z", evidence: " " },
    { ...base, status: "verified", checkedAt: "yesterday", evidence: "x" },
    { ...base, status: "maybe", checkedAt: null, evidence: null },
    { ...base, sourceId: "tiktok_scraper", status: "unverified", checkedAt: null, evidence: null },
    { ...base, platform: "tiktok", status: "unverified", checkedAt: null, evidence: null },
  ]) {
    assert.throws(() => createMarketPolicy({ coverage: [bad] }), MarketPolicyError, JSON.stringify(bad));
  }
  assert.throws(() => createMarketPolicy({ coverage: [verified("google_trends_web", "google_search", "AE"), verified("google_trends_web", "google_search", "AE")] }), MarketPolicyError);
});

test("markets outside the targets are insufficient, however strong the evidence", () => {
  const group = groupOf(observe({ id: "ae", country: "AE", endAgoMs: HOUR }));
  const onlyIndia = createMarketPolicy({ targets: [{ country: "IN", name: "India", languages: ["en"] }], authorizations: APPROVED, coverage: [verified("google_trends_web", "google_search", "AE")] });
  const result = classify(group, onlyIndia);
  assert.equal(result.level, "insufficient");
  assert.deepEqual(result.reasons, ["unsupported_market"]);
});

test("Simplified and Traditional Chinese never merge, and scripts keep their marks", () => {
  const hans = observe({ id: "hans", source: "manual_research", country: "IN", language: "zh-Hans", text: "中秋节礼盒", endAgoMs: HOUR });
  const hant = observe({ id: "hant", source: "manual_research", country: "IN", language: "zh-Hant", text: "中秋節禮盒", endAgoMs: HOUR });
  assert.equal(groupObservationsByTrend([hans, hant]).length, 2);
  assert.equal(normalizeSubjectText("topic", "Tết Trung Thu"), "tết trung thu", "Vietnamese diacritics preserved");
  assert.equal(normalizeSubjectText("topic", "ลอยกระทง"), "ลอยกระทง", "Thai script preserved");
});

test("all-expired evidence is insufficient", () => {
  const result = classify(groupOf(observe({ id: "old", endAgoMs: 31 * DAY })));
  assert.deepEqual([result.level, result.reasons], ["insufficient", ["all_evidence_expired"]]);
  assert.deepEqual(result.expiredObservationIds, ["old"]);
  assert.deepEqual(result.supportingSourceIds, []);
});

test("unavailable metrics are never treated as evidence (or as zero)", () => {
  const result = classify(groupOf(observe({ id: "empty", endAgoMs: HOUR, metrics: { interest_index: { status: "unavailable", reason: "below_reporting_threshold" } } })));
  assert.deepEqual([result.level, result.reasons], ["insufficient", ["no_usable_evidence"]]);
  const notCollected = classify(groupOf(observe({ id: "nc", endAgoMs: HOUR, metrics: null })));
  assert.equal(notCollected.level, "insufficient");
});

test("one fresh, complete quantitative source is medium; corroboration by a second fresh source is high", () => {
  const google = observe({ id: "g", endAgoMs: HOUR, language: "und" });
  const single = classify(groupOf(google));
  assert.deepEqual([single.level, single.reasons], ["medium", ["complete_required_metrics", "fresh_evidence", "single_source"]]);

  // A country-level manual report ("und") corroborates Google Trends for the same country.
  const manualUnd = observe({ id: "m-und", source: "manual_research", language: "und", endAgoMs: HOUR });
  const both = classify(groupOf(observe({ id: "g2", endAgoMs: HOUR }), manualUnd));
  assert.equal(both.level, "high");
  assert.deepEqual(both.reasons, ["complete_required_metrics", "corroborated_by_multiple_sources", "fresh_evidence"]);
  assert.deepEqual(both.supportingSourceIds, ["google_trends_web", "manual_research"]);
});

test("missing required metrics cap a single source at low", () => {
  const partial = observe({ id: "yt-partial", source: "youtube_data_api", endAgoMs: HOUR, metrics: { chart_rank: { status: "measured", value: 4 }, view_count: { status: "unavailable", reason: "collection_failed" } } });
  const result = classify(groupOf(partial));
  assert.equal(result.level, "low");
  assert.ok(result.reasons.includes("missing_required_metrics"));
});

test("a single qualitative report is low; stale-only evidence is low", () => {
  const manual = classify(groupOf(observe({ id: "m", source: "manual_research", language: "ar", endAgoMs: HOUR })));
  assert.deepEqual([manual.level, manual.reasons], ["low", ["fresh_evidence", "qualitative_evidence_only", "single_source"]]);
  const stale = classify(groupOf(observe({ id: "s", endAgoMs: 10 * DAY })));
  assert.equal(stale.level, "low");
  assert.ok(stale.reasons.includes("stale_evidence_only"));
});

test("expired observations are ignored but reported; aging complete evidence is medium", () => {
  const result = classify(groupOf(observe({ id: "aging", endAgoMs: 5 * DAY }), observe({ id: "expired", endAgoMs: 40 * DAY })));
  assert.equal(result.level, "medium");
  assert.ok(result.reasons.includes("aging_evidence"));
  assert.deepEqual(result.usableObservationIds, ["aging"]);
  assert.deepEqual(result.expiredObservationIds, ["expired"]);
});

test("confidence output contains categories and ids only — never a fabricated score", () => {
  const result = classify(groupOf(observe({ id: "g", endAgoMs: HOUR })));
  assert.deepEqual(Object.keys(result).sort(), ["expiredObservationIds", "level", "reasons", "supportingSourceIds", "unauthorizedObservationIds", "uncoveredObservationIds", "usableObservationIds"]);
  const numbers = JSON.stringify(result).match(/:\s*-?\d/g);
  assert.equal(numbers, null, "no numeric fields in the assessment");
});

test("classification is deterministic and order-independent", () => {
  const a = observe({ id: "a", endAgoMs: HOUR });
  const b = observe({ id: "b", source: "manual_research", language: "und", endAgoMs: 2 * HOUR });
  const c = observe({ id: "c", endAgoMs: 9 * DAY });
  const expected = JSON.stringify(classify(groupObservationsByTrend([a, b, c])[0]));
  for (let seed = 1; seed <= 10; seed += 1) {
    assert.equal(JSON.stringify(classify(groupObservationsByTrend(shuffle([a, b, c], seed))[0])), expected);
  }
});

/* ──────────────────────────────────────────────────────────────
   Isolation
   ────────────────────────────────────────────────────────────── */

function sourceFiles(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (name === "node_modules" || name.startsWith(".")) return [];
    return statSync(full).isDirectory() ? sourceFiles(full) : /\.(ts|tsx|mjs|js)$/.test(name) ? [full] : [];
  });
}

const PURE_TREND_FILES = ["claim-check.ts", "confidence.ts", "dedupe.ts", "freshness.ts", "industry.ts", "opportunity.ts", "relevance.ts", "schema.ts", "types.ts"];
// Stage 2B: server-only storage modules. They reach the database only through
// the injected TrendDatabase port (db.ts) — no client, network or environment.
const SERVER_TREND_FILES = ["business-trends.ts", "collection-runner.ts", "daily-job.ts", "db.ts", "discovery.ts", "governance.ts", "policy-store.ts", "read-model.ts", "storage.ts", "supabase-rpc.ts", "universal-collection.ts", "workflow-context.ts"];
// The single module allowed to bind the trend RPCs to Voom's Supabase admin client.
const RPC_ADAPTER = "supabase-rpc.ts";
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

test("lib/trends holds exactly the pure domain, server-only storage, and reviewed connector modules", () => {
  assert.deepEqual(readdirSync(path.join(ROOT, "lib/trends")).sort(), [...PURE_TREND_FILES, ...SERVER_TREND_FILES, "connectors"].sort());
});

test("lib/trends server-only modules: server-only, injected database access, no network, environment, clock, randomness or AI", () => {
  const dir = path.join(ROOT, "lib/trends");
  for (const file of SERVER_TREND_FILES) {
    const src = stripComments(readFileSync(path.join(dir, file), "utf8"));
    assert.match(src, /^import "server-only";/, `${file}: server-only first`);
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|node:http|node:https|node:net|node:fs|node:child_process/, `${file}: no network or file I/O`);
    assert.doesNotMatch(src, /createClient\(|@supabase\/|SUPABASE_[A-Z_]+|service_role_key|secret/i, `${file}: no database client construction or credentials`);
    if (file !== RPC_ADAPTER) assert.doesNotMatch(src, /createAdminClient|@\/utils\/supabase/, `${file}: only ${RPC_ADAPTER} touches the admin client`);
    assert.doesNotMatch(src, /openai|anthropic|openrouter|getAiConfig|@\/lib\/(ai|mara|voom|media|coordinator)/i, `${file}: no AI or MARA`);
    assert.doesNotMatch(src, /process\.env|Date\.now\(|Math\.random\(|new Date\(\)/, `${file}: no environment, clock or randomness`);
    assert.doesNotMatch(src, /"use client"|"use server"/, `${file}: not a client or action module`);
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const specifier of imports) {
      const allowed = /^\.\/[a-z-]+$/.test(specifier)
        || (file === "discovery.ts" && specifier === "./connectors/wikidata-events")
        || (file === "universal-collection.ts" && ["./connectors/public-holidays", "./connectors/wikimedia-pageviews"].includes(specifier))
        || (file === RPC_ADAPTER && specifier === "@/utils/supabase/admin");
      assert.ok(allowed, `${file} imports only sibling modules: ${specifier}`);
    }
  }
});

test("lib/trends is pure: no network, database, AI, environment, clock, randomness or server-only code", () => {
  const dir = path.join(ROOT, "lib/trends");
  const files = PURE_TREND_FILES;
  for (const file of files) {
    const src = readFileSync(path.join(dir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|WebSocket|node:http|node:https|node:net|node:fs|node:child_process/, `${file}: no I/O`);
    assert.doesNotMatch(src, /supabase|createClient|createAdminClient|\.from\(|\.rpc\(/i, `${file}: no database`);
    assert.doesNotMatch(src, /openai|anthropic|openrouter|getAiConfig|@\/lib\/(ai|mara|voom|media|coordinator)/i, `${file}: no AI or MARA`);
    assert.doesNotMatch(src, /process\.env|Date\.now\(|Math\.random\(|new Date\(\)/, `${file}: no environment, clock or randomness`);
    assert.doesNotMatch(src, /server-only|"use client"|"use server"/, `${file}: framework-independent`);
    const imports = [...src.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    for (const specifier of imports) {
      assert.match(specifier, /^(zod|\.\/[a-z]+)$/, `${file} imports only zod and sibling modules: ${specifier}`);
      assert.equal(SERVER_TREND_FILES.includes(`${specifier.slice(2)}.ts`), false, `${file} must not import server-only module ${specifier}`);
    }
  }
});

// The only app code that may touch the trend engine: MARA's planning prompt
// and service. Runtime reads and validation stay behind
// VOOM_TREND_CONTEXT_ENABLED, which is off by default.
const TREND_TYPE_IMPORTERS = new Map([
  [path.join("lib", "voom", "workflow", "prompt.ts"), 'import type { TrendPromptContext } from "@/lib/trends/opportunity";'],
  [path.join("lib", "voom", "workflow", "service.ts"), [
    'import type { TrendPromptContext } from "@/lib/trends/opportunity";',
    'import { checkTrendGroundedContent, checkTrendUsage } from "@/lib/trends/claim-check";',
    'import { loadOwnerTrendPromptContext, type TrendWorkflowClient } from "@/lib/trends/workflow-context";',
    'import { loadBusinessTrendIdeas } from "@/lib/trends/business-trends";',
    'import { MAX_TREND_IDEAS_PER_RUN } from "@/lib/trends/relevance";',
    'import type { TrendRpcClient } from "@/lib/trends/supabase-rpc";',
  ]],
  // The daily collection cron route (disabled by default, unscheduled).
  [path.join("app", "api", "cron", "trend-collection", "route.ts"), [
    'import { runDailyTrendJob } from "@/lib/trends/daily-job";',
    'import { createTrendAdminRpcClient } from "@/lib/trends/supabase-rpc";',
  ]],
]);

test("app code reaches the trend engine only through MARA's flag-gated workflow boundary", () => {
  const roots = ["app", "components", "lib", "utils"].map((d) => path.join(ROOT, d));
  for (const file of roots.flatMap(sourceFiles)) {
    if (file.includes(`${path.sep}lib${path.sep}trends${path.sep}`)) continue;
    const relative = path.relative(ROOT, file);
    const references = readFileSync(file, "utf8").split("\n").filter((line) => /lib\/trends/.test(line));
    const allowed = TREND_TYPE_IMPORTERS.get(relative);
    assert.deepEqual(references, allowed ? (Array.isArray(allowed) ? allowed : [allowed]) : [], `${relative} must not depend on lib/trends`);
  }
});
