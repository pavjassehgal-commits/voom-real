/**
 * Trend Intelligence Engine — Stage 1: observation validation (lib/trends/schema.ts).
 *
 * WHAT THIS FILE PINS
 *   - only registered sources, the platforms and subject kinds they cover,
 *     and well-formed markets are accepted (strict identification);
 *   - each source's language rule: "und" when the source reports no
 *     language; ISO 639-1 or "und" when language is optional;
 *   - metrics are the source's own keys, finite, integer where declared and
 *     within the declared range; strings, NaN and Infinity are rejected;
 *   - a missing metric becomes `unavailable/not_collected` — never 0 — while
 *     a measured 0 stays a measured 0;
 *   - timestamps must be real calendar instants with a timezone, the window
 *     must be ordered and precede retrieval, and nothing may be in the future;
 *   - every observation carries attributed evidence from its own source, with
 *     a public https link where the source requires one;
 *   - output is deterministic and timestamps are normalized to UTC.
 * Pure: no network, database, AI or clock reads.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const { parseTrendObservation, parseTrendObservations, parseInstant } = await import("../lib/trends/schema.ts");
const { TREND_SOURCES } = await import("../lib/trends/types.ts");

const NOW = "2026-10-11T12:00:00Z";

function googleRaw(overrides = {}) {
  return {
    id: "gt-1",
    sourceId: "google_trends_web",
    platform: "google_search",
    market: { country: "AE", language: "und" },
    subject: { kind: "search_query", text: "Ramadan Recipes" },
    window: { start: "2026-10-04T00:00:00Z", end: "2026-10-11T00:00:00Z" },
    retrievedAt: "2026-10-11T06:00:00Z",
    metrics: { interest_index: { status: "measured", value: 87 } },
    evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "Google Trends", retrievedAt: "2026-10-11T06:00:00Z" }],
    ...overrides,
  };
}

function manualRaw(overrides = {}) {
  return {
    id: "mr-1",
    sourceId: "manual_research",
    platform: "instagram",
    market: { country: "AE", language: "ar" },
    subject: { kind: "hashtag", text: "#EidOutfits" },
    window: { start: "2026-10-09T00:00:00Z", end: "2026-10-10T00:00:00Z" },
    retrievedAt: "2026-10-10T09:00:00Z",
    evidence: [{ sourceId: "manual_research", url: "https://www.instagram.com/explore/tags/eidoutfits/", attribution: "Instagram public tag page", retrievedAt: "2026-10-10T09:00:00Z" }],
    ...overrides,
  };
}

const parse = (raw, now = NOW) => parseTrendObservation(raw, { now });
const codes = (result) => (result.ok ? [] : result.issues.map((issue) => issue.code));

/* ──────────────────────────────────────────────────────────────
   Accepted input
   ────────────────────────────────────────────────────────────── */

test("a valid Google Trends observation is accepted and normalized", () => {
  const result = parse(googleRaw());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value, {
    id: "gt-1",
    sourceId: "google_trends_web",
    platform: "google_search",
    market: { country: "AE", language: "und" },
    subject: { kind: "search_query", text: "Ramadan Recipes", normalized: "ramadan recipes" },
    item: null,
    window: { start: "2026-10-04T00:00:00.000Z", end: "2026-10-11T00:00:00.000Z" },
    retrievedAt: "2026-10-11T06:00:00.000Z",
    metrics: { interest_index: { status: "measured", value: 87, definitionVersion: "google_trends_web.interest_index.v1" } },
    evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "Google Trends", retrievedAt: "2026-10-11T06:00:00.000Z" }],
  });
});

test("timestamps with offsets are normalized to UTC", () => {
  const result = parse(googleRaw({ window: { start: "2026-10-04T04:00:00+04:00", end: "2026-10-11T04:00:00+04:00" }, retrievedAt: "2026-10-11T10:00:00+04:00" }));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.value.window.start, "2026-10-04T00:00:00.000Z");
  assert.equal(result.value.retrievedAt, "2026-10-11T06:00:00.000Z");
});

test("a valid qualitative manual-research observation is accepted with no metrics", () => {
  const result = parse(manualRaw());
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.metrics, {});
  assert.equal(result.value.subject.normalized, "eidoutfits", "hashtag # removed and lower-cased for comparison");
  assert.equal(result.value.subject.text, "#EidOutfits", "the display text is preserved");
});

/* ──────────────────────────────────────────────────────────────
   Missing data — never zero
   ────────────────────────────────────────────────────────────── */

test("a missing metric becomes unavailable/not_collected, never zero", () => {
  const result = parse({ ...googleRaw(), metrics: undefined });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.metrics.interest_index, { status: "unavailable", reason: "not_collected" });
});

test("explicit unavailable reasons are preserved, and a measured zero stays a measured zero", () => {
  const youtube = {
    id: "yt-1",
    sourceId: "youtube_data_api",
    platform: "youtube",
    market: { country: "IN", language: "und" },
    subject: { kind: "video", text: "Diwali sweets in 60 seconds", providerItemId: "abc123DEF_-" },
    window: { start: "2026-10-11T00:00:00Z", end: "2026-10-11T06:00:00Z" },
    retrievedAt: "2026-10-11T06:00:00Z",
    metrics: {
      chart_rank: { status: "measured", value: 3 },
      view_count: { status: "measured", value: 0 },
      like_count: { status: "unavailable", reason: "hidden_by_owner" },
    },
    evidence: [{ sourceId: "youtube_data_api", url: "https://www.youtube.com/watch?v=abc123DEF_-", attribution: "YouTube", retrievedAt: "2026-10-11T06:00:00Z" }],
  };
  const result = parse(youtube);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(result.value.metrics, {
    chart_rank: { status: "measured", value: 3, definitionVersion: "youtube_data_api.chart_rank.v1" },
    view_count: { status: "measured", value: 0, definitionVersion: "youtube_data_api.view_count.v2" },
    like_count: { status: "unavailable", reason: "hidden_by_owner" },
    comment_count: { status: "unavailable", reason: "not_collected" },
  });
  assert.deepEqual(result.value.item, { platform: "youtube", kind: "video", providerItemId: "abc123DEF_-" });
});

test("bare numbers, nulls, strings, NaN and Infinity are never accepted as metric values", () => {
  for (const value of [87, null, "87", { status: "measured", value: "87" }, { status: "measured", value: Number.NaN }, { status: "measured", value: Number.POSITIVE_INFINITY }, { status: "measured" }, { status: "unavailable" }, { status: "unavailable", reason: "made_up" }, { status: "zero" }]) {
    const result = parse(googleRaw({ metrics: { interest_index: value } }));
    assert.equal(result.ok, false, `accepted ${JSON.stringify(value)}`);
  }
});

/* ──────────────────────────────────────────────────────────────
   Source-specific metric definitions
   ────────────────────────────────────────────────────────────── */

test("metrics must be the source's own, in range and integer where declared", () => {
  assert.deepEqual(codes(parse(googleRaw({ metrics: { interest_index: { status: "measured", value: 87 }, view_count: { status: "measured", value: 5 } } }))), ["unknown_metric"]);
  assert.deepEqual(codes(parse(googleRaw({ metrics: { search_volume: { status: "measured", value: 1000 } } }))), ["unknown_metric"]);
  assert.deepEqual(codes(parse(googleRaw({ metrics: { interest_index: { status: "measured", value: 101 } } }))), ["metric_out_of_range"]);
  assert.deepEqual(codes(parse(googleRaw({ metrics: { interest_index: { status: "measured", value: -1 } } }))), ["metric_out_of_range"]);
  assert.deepEqual(codes(parse(googleRaw({ metrics: { interest_index: { status: "measured", value: 50.5 } } }))), ["metric_not_integer"]);
  assert.deepEqual(codes(parse(manualRaw({ metrics: { views: { status: "measured", value: 1 } } }))), ["unknown_metric"], "qualitative sources carry no numbers");
});

test("every registered source declares its connector state and valid metric definitions", () => {
  for (const source of Object.values(TREND_SOURCES)) {
    assert.ok(["connected", "not_connected"].includes(source.connection));
    const keys = new Set();
    for (const metric of source.metrics) {
      assert.ok(!keys.has(metric.key), `${source.id}.${metric.key} is unique`);
      keys.add(metric.key);
      assert.ok(["relative_index", "scaled_interest", "count", "rank"].includes(metric.unit));
      assert.ok(metric.versions.length >= 1, `${source.id}.${metric.key} has at least one definition version`);
      for (const version of metric.versions) {
        assert.ok(version.definition.length > 20, `${version.id} explains its own meaning`);
        assert.ok(version.id.startsWith(`${source.id}.${metric.key}.`), `${version.id} is namespaced to its source and metric`);
      }
      // Versions are in time order and never overlap.
      for (let i = 1; i < metric.versions.length; i += 1) assert.equal(metric.versions[i].effectiveFrom, metric.versions[i - 1].effectiveUntil);
      assert.ok(metric.max === null || metric.max > metric.min);
    }
  }
  assert.equal(TREND_SOURCES.wikidata_events.connection, "connected");
});

/* ──────────────────────────────────────────────────────────────
   Source, platform, subject and market identification
   ────────────────────────────────────────────────────────────── */

test("unknown sources and mismatched platforms or subject kinds are rejected", () => {
  assert.deepEqual(codes(parse(googleRaw({ sourceId: "tiktok_scraper" }))), ["unknown_source"]);
  assert.deepEqual(codes(parse(googleRaw({ platform: "tiktok" }))), ["platform_not_supported_by_source"]);
  assert.deepEqual(codes(parse(googleRaw({ platform: "myspace" }))), ["unknown_platform"]);
  assert.deepEqual(codes(parse(googleRaw({ subject: { kind: "hashtag", text: "#eid" } }))), ["subject_kind_not_supported_by_source"]);
  assert.deepEqual(codes(parse(googleRaw({ subject: { kind: "meme", text: "x" } }))), ["unknown_subject_kind"]);
});

test("markets must be well formed and respect the source's language rule", () => {
  for (const country of ["ae", "UAE", "U1", "", "GB "]) {
    assert.deepEqual(codes(parse(googleRaw({ market: { country, language: "und" } }))), ["invalid_country"], country);
  }
  assert.deepEqual(codes(parse(googleRaw({ market: { country: "AE", language: "en" } }))), ["language_must_be_undetermined"]);
  assert.equal(parse(manualRaw({ market: { country: "AE", language: "und" } })).ok, true, "manual research may record a country-level trend");
  for (const language of ["zh-Hans", "zh-Hant", "fil", "ms", "id", "th", "vi", "tr", "hi", "ar", "en"]) {
    assert.equal(parse(manualRaw({ market: { country: "HK", language } })).ok, true, language);
  }
  for (const language of ["EN", "eng", "en-US", "", "zh", "zh-hant", "tl", "hi-IN", "fr"]) {
    assert.deepEqual(codes(parse(manualRaw({ market: { country: "AE", language } }))), ["invalid_language"], language);
  }
});

test("subjects must contain meaningful text", () => {
  for (const text of ["", "   ", "#", "##", "​​", "a\u0007b", "x".repeat(201)]) {
    assert.deepEqual(codes(parse(manualRaw({ subject: { kind: "hashtag", text } }))), ["invalid_subject"], JSON.stringify(text));
  }
});

test("unknown fields anywhere are rejected", () => {
  assert.equal(parse({ ...googleRaw(), score: 99 }).ok, false);
  assert.equal(parse(googleRaw({ market: { country: "AE", language: "und", city: "Dubai" } })).ok, false);
  assert.equal(parse(googleRaw({ evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "Google Trends", retrievedAt: "2026-10-11T06:00:00Z", merchantId: "m1" }] })).ok, false);
  assert.equal(parse(null).ok, false);
  assert.equal(parse("google_trends_web").ok, false);
});

/* ──────────────────────────────────────────────────────────────
   Evidence timestamps and attribution
   ────────────────────────────────────────────────────────────── */

test("timestamps must be real instants with a timezone", () => {
  for (const value of ["2026-10-11", "2026-10-11T06:00:00", "2026-02-30T00:00:00Z", "2026-13-01T00:00:00Z", "2026-10-11T24:00:00Z", "yesterday", "1760162400000"]) {
    assert.equal(parseInstant(value), null, value);
    assert.ok(codes(parse(googleRaw({ retrievedAt: value }))).includes("invalid_timestamp"), value);
  }
  assert.equal(parseInstant("2028-02-29T00:00:00Z"), Date.UTC(2028, 1, 29), "leap day is a real date");
});

test("windows must be ordered and precede retrieval; nothing may be in the future", () => {
  assert.deepEqual(codes(parse(googleRaw({ window: { start: "2026-10-11T00:00:00Z", end: "2026-10-04T00:00:00Z" } }))), ["window_inverted"]);
  assert.deepEqual(codes(parse(googleRaw({ window: { start: "2026-10-04T00:00:00Z", end: "2026-10-11T08:00:00Z" } }))), ["window_after_retrieval"]);
  assert.deepEqual(
    codes(parse(googleRaw({ retrievedAt: "2026-10-11T13:00:00Z", evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "Google Trends", retrievedAt: "2026-10-11T06:00:00Z" }] }))),
    ["retrieved_in_future"],
  );
  // Within the 5-minute clock skew is tolerated.
  assert.equal(parse(googleRaw({ retrievedAt: "2026-10-11T12:04:00Z", window: { start: "2026-10-04T00:00:00Z", end: "2026-10-11T12:04:00Z" } })).ok, true);
});

test("evidence must be present, attributed, from the same source, and linked when required", () => {
  assert.equal(parse(googleRaw({ evidence: [] })).ok, false);
  assert.deepEqual(codes(parse(googleRaw({ evidence: [{ sourceId: "manual_research", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "Google Trends", retrievedAt: "2026-10-11T06:00:00Z" }] }))), ["evidence_source_mismatch"]);
  assert.deepEqual(codes(parse(googleRaw({ evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=ramadan%20recipes", attribution: "   ", retrievedAt: "2026-10-11T06:00:00Z" }] }))), ["missing_attribution"]);
  assert.deepEqual(codes(parse(manualRaw({ evidence: [{ sourceId: "manual_research", url: null, attribution: "Reviewer note", retrievedAt: "2026-10-10T09:00:00Z" }] }))), ["evidence_url_required"]);
  for (const url of ["http://example.com/trend", "javascript:alert(1)", "https://user:pass@example.com/x", "not a url", "ftp://example.com"]) {
    assert.deepEqual(codes(parse(manualRaw({ evidence: [{ sourceId: "manual_research", url, attribution: "Page", retrievedAt: "2026-10-10T09:00:00Z" }] }))), ["evidence_url_invalid"], url);
  }
});

/* ──────────────────────────────────────────────────────────────
   Robustness and determinism
   ────────────────────────────────────────────────────────────── */

test("an invalid evaluation time is refused rather than guessed", () => {
  for (const now of ["not a date", Number.NaN, new Date("invalid")]) {
    assert.deepEqual(codes(parseTrendObservation(googleRaw(), { now })), ["invalid_now"]);
  }
});

test("batch parsing keeps input order and reports rejected indexes", () => {
  const result = parseTrendObservations([googleRaw({ id: "a" }), googleRaw({ id: "b", sourceId: "nope" }), manualRaw({ id: "c" })], { now: NOW });
  assert.deepEqual(result.valid.map((observation) => observation.id), ["a", "c"]);
  assert.deepEqual(result.rejected.map((item) => [item.index, item.issues[0].code]), [[1, "unknown_source"]]);
});

test("the same input always yields the same output", () => {
  const first = JSON.stringify(parse(googleRaw()));
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(parse(googleRaw())), first);
});

test("input objects are not mutated", () => {
  const raw = googleRaw({ metrics: undefined });
  const snapshot = JSON.stringify(raw);
  parse(raw);
  assert.equal(JSON.stringify(raw), snapshot);
});
