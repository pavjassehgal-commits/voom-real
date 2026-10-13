/**
 * Trend Intelligence Engine — Stage 1.5: identity, source permissions and
 * metric definitions.
 *
 * WHAT THIS FILE PINS
 *   - content-item identity (provider id, namespaced by platform) is distinct
 *     from topic identity (normalized text): identical titles never make two
 *     videos duplicates, and a retitled video stays one item;
 *   - the same id string on two platforms is never the same item;
 *   - countries and languages stay isolated even for the same item;
 *   - schema support, documented API availability, verified coverage,
 *     Voom's approval and connection status are separate facts — only an
 *     explicit, recorded approval plus verified coverage lets data count;
 *   - unavailable metrics stay unavailable;
 *   - metric definitions are source-specific and versioned: Google Trends
 *     website and API values are different measures, and YouTube's view
 *     count before and after 2026-08-24 never shares a definition.
 * Pure and deterministic: no network, database, AI or clock reads.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import test from "node:test";

const { parseTrendObservation } = await import("../lib/trends/schema.ts");
const { itemKey, topicKey, trendKey, dedupeObservations, groupObservationsByTrend } = await import("../lib/trends/dedupe.ts");
const { classifyTrendConfidence, createMarketPolicy, sourceAuthorizationStatus, MarketPolicyError } = await import("../lib/trends/confidence.ts");
const { TREND_SOURCES, DEFAULT_SOURCE_AUTHORIZATIONS, YOUTUBE_VIEW_COUNT_CHANGE } = await import("../lib/trends/types.ts");

const NOW = "2026-10-11T12:00:00Z";
const HOUR = 3_600_000;
const at = (offsetMs) => new Date(Date.parse(NOW) + offsetMs).toISOString();

function parseOk(raw, now = NOW) {
  const result = parseTrendObservation(raw, { now });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
}
const codes = (raw, now = NOW) => {
  const result = parseTrendObservation(raw, { now });
  return result.ok ? [] : result.issues.map((issue) => issue.code);
};

/** A YouTube chart observation. */
function youtube({ id, videoId, title = "Eid outfit ideas", country = "AE", endAgo = HOUR, retrievedAgo, metrics, url }) {
  const end = at(-endAgo);
  return {
    id,
    sourceId: "youtube_data_api",
    platform: "youtube",
    market: { country, language: "und" },
    subject: { kind: "video", text: title, providerItemId: videoId },
    window: { start: end, end },
    retrievedAt: retrievedAgo === undefined ? end : at(-retrievedAgo),
    metrics: metrics ?? { chart_rank: { status: "measured", value: 1 }, view_count: { status: "measured", value: 5000 } },
    evidence: [{ sourceId: "youtube_data_api", url: url ?? `https://www.youtube.com/watch?v=${videoId}`, attribution: "YouTube", retrievedAt: end }],
  };
}

/** A manual-research observation of an item or topic on any platform. */
function manual({ id, platform = "youtube", kind = "video", text = "Eid outfit ideas", itemId, country = "AE", language = "und", url = "https://example.com/evidence" }) {
  const end = at(-HOUR);
  return {
    id,
    sourceId: "manual_research",
    platform,
    market: { country, language },
    subject: { kind, text, ...(itemId === undefined ? {} : { providerItemId: itemId }) },
    window: { start: end, end },
    retrievedAt: end,
    evidence: [{ sourceId: "manual_research", url, attribution: "Reviewer", retrievedAt: end }],
  };
}

const VID_A = "aaaaaaaaaa1";
const VID_B = "bbbbbbbbbb2";

/* ──────────────────────────────────────────────────────────────
   Content-item identity vs topic identity
   ────────────────────────────────────────────────────────────── */

test("different videos with identical titles are NOT duplicates", () => {
  const a = parseOk(youtube({ id: "a", videoId: VID_A }));
  const b = parseOk(youtube({ id: "b", videoId: VID_B }));
  assert.equal(topicKey(a), topicKey(b), "same topic text");
  assert.notEqual(itemKey(a), itemKey(b), "different items");
  assert.notEqual(trendKey(a), trendKey(b), "different trends");
  const result = dedupeObservations([a, b]);
  assert.deepEqual(result.kept.map((o) => o.id).sort(), ["a", "b"]);
  assert.deepEqual(result.duplicates, []);
  assert.equal(groupObservationsByTrend([a, b]).length, 2);
});

test("the same video reported twice for the same window is one observation, even if retitled", () => {
  const first = parseOk(youtube({ id: "first", videoId: VID_A, title: "Eid outfit ideas", retrievedAgo: HOUR / 2 }));
  const retitled = parseOk(youtube({ id: "retitled", videoId: VID_A, title: "EID OUTFITS 2026 (new!)", retrievedAgo: 0 }));
  assert.notEqual(topicKey(first), topicKey(retitled));
  assert.equal(trendKey(first), trendKey(retitled));
  const result = dedupeObservations([first, retitled]);
  assert.deepEqual(result.kept.map((o) => o.id), ["retitled"], "the newest retrieval is kept");
  assert.deepEqual(result.duplicates, [{ keptId: "retitled", droppedId: "first", reason: "same_source_same_trend_same_window" }]);
});

test("the same video in different windows, or from different sources, is one trend with several observations", () => {
  const earlier = parseOk(youtube({ id: "t1", videoId: VID_A, endAgo: 3 * HOUR }));
  const later = parseOk(youtube({ id: "t2", videoId: VID_A, endAgo: HOUR }));
  const reviewer = parseOk(manual({ id: "m1", itemId: VID_A, url: `https://youtu.be/${VID_A}` }));
  const result = dedupeObservations([earlier, later, reviewer]);
  assert.equal(result.kept.length, 3, "different windows and sources are not duplicates");
  const groups = groupObservationsByTrend(result.kept);
  assert.equal(groups.length, 1);
  assert.deepEqual(groups[0].item, { platform: "youtube", kind: "video", providerItemId: VID_A });
  assert.deepEqual(groups[0].sourceIds, ["manual_research", "youtube_data_api"]);
});

test("the same id string on different platforms is never the same item", () => {
  const sharedId = "12345678901"; // valid as both a YouTube and a TikTok id
  const onYouTube = parseOk(youtube({ id: "yt", videoId: sharedId }));
  const onTikTok = parseOk(manual({ id: "tt", platform: "tiktok", itemId: sharedId }));
  assert.notEqual(itemKey(onYouTube), itemKey(onTikTok));
  assert.equal(groupObservationsByTrend([onYouTube, onTikTok]).length, 2);
  assert.deepEqual(dedupeObservations([onYouTube, onTikTok]).duplicates, []);
});

test("provider ids are exact and case-sensitive", () => {
  const lower = parseOk(youtube({ id: "l", videoId: "abcdefghijk" }));
  const upper = parseOk(youtube({ id: "u", videoId: "ABCDEFGHIJK" }));
  assert.notEqual(itemKey(lower), itemKey(upper));
});

test("the same video in different countries or languages never shares a group", () => {
  const ae = parseOk(youtube({ id: "ae", videoId: VID_A, country: "AE" }));
  const inn = parseOk(youtube({ id: "in", videoId: VID_A, country: "IN" }));
  assert.equal(itemKey(ae), itemKey(inn), "one item globally");
  assert.notEqual(trendKey(ae), trendKey(inn), "but separate trends per market");
  const en = parseOk(manual({ id: "en", platform: "tiktok", itemId: "998877", language: "en" }));
  const ar = parseOk(manual({ id: "ar", platform: "tiktok", itemId: "998877", language: "ar" }));
  const und = parseOk(manual({ id: "und", platform: "tiktok", itemId: "998877", language: "und" }));
  assert.equal(groupObservationsByTrend([ae, inn, en, ar, und]).length, 5);
});

test("topics are identified by text; items must carry a valid provider id", () => {
  assert.deepEqual(codes(youtube({ id: "x", videoId: undefined })), ["provider_item_id_required"]);
  assert.deepEqual(codes(manual({ id: "x", platform: "instagram", kind: "hashtag", text: "#eid", itemId: "abc" })), ["provider_item_id_not_allowed"]);
  assert.deepEqual(codes(manual({ id: "x", platform: "google_search", kind: "topic", text: "eid", itemId: "abc" })), ["provider_item_id_not_allowed"]);
  for (const bad of ["short", "aaaaaaaaaa12", "aaaa aaaaaa", "aaaaaaaaaa!", ""]) {
    assert.ok(codes(youtube({ id: "x", videoId: bad, url: "https://example.com/evidence" })).includes("invalid_provider_item_id"), bad);
  }
  assert.deepEqual(codes(manual({ id: "x", platform: "tiktok", itemId: "12ab" })), ["invalid_provider_item_id"], "TikTok ids are numeric");
  // A sound may carry an id, or be a topic-like mention without one.
  const withId = parseOk(manual({ id: "s1", platform: "tiktok", kind: "sound", text: "Original sound", itemId: "7001" }));
  const withoutId = parseOk(manual({ id: "s2", platform: "tiktok", kind: "sound", text: "Original sound" }));
  assert.deepEqual(withId.item, { platform: "tiktok", kind: "sound", providerItemId: "7001" });
  assert.equal(withoutId.item, null);
  assert.notEqual(trendKey(withId), trendKey(withoutId));
  // Topic observations have no item at all.
  assert.equal(parseOk(manual({ id: "t", platform: "google_search", kind: "topic", text: "eid gifts" })).item, null);
});

test("evidence links must point at the observation's own video", () => {
  assert.deepEqual(codes(youtube({ id: "x", videoId: VID_A, url: `https://www.youtube.com/watch?v=${VID_B}` })), ["evidence_item_mismatch"]);
  assert.deepEqual(codes(youtube({ id: "x", videoId: VID_A, url: `https://youtu.be/${VID_B}` })), ["evidence_item_mismatch"]);
  assert.deepEqual(codes(youtube({ id: "x", videoId: VID_A, url: `https://www.youtube.com/shorts/${VID_B}` })), ["evidence_item_mismatch"]);
  assert.deepEqual(codes(youtube({ id: "x", videoId: VID_A, url: `https://m.youtube.com/watch?v=${VID_A}&t=10` })), []);
  assert.deepEqual(codes(youtube({ id: "x", videoId: VID_A, url: "https://www.youtube.com/@somechannel" })), [], "a non-video link is not a mismatch");
});

/* ──────────────────────────────────────────────────────────────
   Source registry: five separate facts
   ────────────────────────────────────────────────────────────── */

test("the registry separates schema support, API availability and connection", () => {
  for (const source of Object.values(TREND_SOURCES)) {
    assert.equal(source.dataSchema, "supported");
    assert.ok(["connected", "not_connected"].includes(source.connection));
    assert.ok(["generally_available", "restricted_alpha", "no_public_api", "not_applicable"].includes(source.apiAvailability.status));
    assert.ok(source.apiAvailability.note.length > 20);
    assert.ok(Number.isFinite(Date.parse(source.apiAvailability.checkedAt)));
    assert.equal(Object.hasOwn(source, "authorized"), false, "approval is never a static registry fact");
  }
  assert.equal(TREND_SOURCES.google_trends_api.apiAvailability.status, "restricted_alpha");
  assert.equal(TREND_SOURCES.google_trends_web.apiAvailability.status, "no_public_api");
  assert.equal(TREND_SOURCES.youtube_data_api.apiAvailability.status, "generally_available");
  assert.equal(TREND_SOURCES.wikidata_events.connection, "connected");
  assert.deepEqual(DEFAULT_SOURCE_AUTHORIZATIONS, []);
});

const verified = (sourceId, platform, country) => ({ sourceId, platform, country, status: "verified", checkedAt: "2026-10-01T00:00:00Z", evidence: "test fixture" });
const decision = (sourceId, status, extra = {}) => ({ sourceId, status, decidedAt: "2026-10-01T00:00:00Z", decidedBy: "test", reference: "test record", ...extra });

test("a documented, generally available API is still not permission to use its data", () => {
  const obs = parseOk(youtube({ id: "y", videoId: VID_A }));
  const [group] = groupObservationsByTrend([obs]);
  const coveredButNotApproved = createMarketPolicy({ coverage: [verified("youtube_data_api", "youtube", "AE")] });
  assert.equal(sourceAuthorizationStatus("youtube_data_api", coveredButNotApproved), "not_reviewed");
  const result = classifyTrendConfidence(group, { now: NOW, markets: coveredButNotApproved });
  assert.deepEqual([result.level, result.reasons], ["insufficient", ["source_not_authorized"]]);
  assert.deepEqual(result.unauthorizedObservationIds, ["y"]);
});

test("not-approved and under-review sources never count; approved ones do", () => {
  const coverage = [verified("youtube_data_api", "youtube", "AE"), verified("manual_research", "youtube", "AE")];
  const yt = parseOk(youtube({ id: "y", videoId: VID_A }));
  const man = parseOk(manual({ id: "m", itemId: VID_A }));
  const [group] = groupObservationsByTrend([yt, man]);
  for (const status of ["not_approved", "under_review"]) {
    const policy = createMarketPolicy({ coverage, authorizations: [decision("youtube_data_api", status), decision("manual_research", "approved")] });
    const result = classifyTrendConfidence(group, { now: NOW, markets: policy });
    assert.deepEqual(result.supportingSourceIds, ["manual_research"], status);
    assert.deepEqual(result.unauthorizedObservationIds, ["y"], status);
  }
  const both = createMarketPolicy({ coverage, authorizations: [decision("youtube_data_api", "approved"), decision("manual_research", "approved")] });
  const result = classifyTrendConfidence(group, { now: NOW, markets: both });
  assert.equal(result.level, "high");
  assert.deepEqual(result.unauthorizedObservationIds, []);
});

test("approvals must be recorded: when, by whom and where", () => {
  for (const bad of [
    decision("youtube_data_api", "approved", { reference: null }),
    decision("youtube_data_api", "approved", { reference: "  " }),
    decision("youtube_data_api", "approved", { decidedAt: null }),
    decision("youtube_data_api", "approved", { decidedAt: "last week" }),
    decision("youtube_data_api", "not_approved", { decidedBy: "" }),
    decision("youtube_data_api", "maybe"),
    decision("tiktok_research", "approved"),
  ]) {
    assert.throws(() => createMarketPolicy({ authorizations: [bad] }), MarketPolicyError, JSON.stringify(bad));
  }
  assert.throws(() => createMarketPolicy({ authorizations: [decision("manual_research", "approved"), decision("manual_research", "not_approved")] }), MarketPolicyError);
  assert.doesNotThrow(() => createMarketPolicy({ authorizations: [{ sourceId: "google_trends_api", status: "under_review", decidedAt: null, decidedBy: null, reference: null }] }));
});

/* ──────────────────────────────────────────────────────────────
   Unavailable metrics
   ────────────────────────────────────────────────────────────── */

function googleApi({ id = "ga", metrics, retrievedAt = at(-HOUR) } = {}) {
  return {
    id,
    sourceId: "google_trends_api",
    platform: "google_search",
    market: { country: "AE", language: "und" },
    subject: { kind: "search_query", text: "eid gifts" },
    window: { start: at(-7 * 24 * HOUR), end: retrievedAt },
    retrievedAt,
    metrics,
    evidence: [{ sourceId: "google_trends_api", url: null, attribution: "Google Trends API (alpha)", retrievedAt }],
  };
}

test("unavailable metrics stay unavailable and carry no definition or value", () => {
  const obs = parseOk(googleApi({ metrics: { scaled_interest: { status: "unavailable", reason: "below_reporting_threshold" } } }));
  assert.deepEqual(obs.metrics.scaled_interest, { status: "unavailable", reason: "below_reporting_threshold" });
  assert.equal(parseTrendObservation(googleApi({ metrics: { scaled_interest: { status: "unavailable", reason: "not_collected", value: 0 } } }), { now: NOW }).ok, false);
  assert.equal(parseTrendObservation(googleApi({ metrics: { scaled_interest: { status: "unavailable", reason: "not_collected", definitionVersion: "google_trends_api.scaled_interest.alpha" } } }), { now: NOW }).ok, false);
  const policy = createMarketPolicy({ coverage: [verified("google_trends_api", "google_search", "AE")], authorizations: [decision("google_trends_api", "approved")] });
  const [group] = groupObservationsByTrend([obs]);
  assert.deepEqual(classifyTrendConfidence(group, { now: NOW, markets: policy }).reasons, ["no_usable_evidence"]);
});

/* ──────────────────────────────────────────────────────────────
   Metric definitions — source-specific and versioned
   ────────────────────────────────────────────────────────────── */

test("Google Trends website and API values are different measures and cannot be swapped", () => {
  assert.deepEqual(codes(googleApi({ metrics: { interest_index: { status: "measured", value: 80 } } })), ["unknown_metric"], "the website index is not an API metric");
  const web = {
    ...googleApi({ metrics: undefined }),
    sourceId: "google_trends_web",
    metrics: { scaled_interest: { status: "measured", value: 80 } },
    evidence: [{ sourceId: "google_trends_web", url: "https://trends.google.com/trends/explore?geo=AE&q=eid%20gifts", attribution: "Google Trends", retrievedAt: at(-HOUR) }],
  };
  assert.deepEqual(codes(web), ["unknown_metric"], "the API scale is not a website metric");
  // The API scale is not capped at 100 and need not be an integer; the website index is both.
  assert.equal(parseOk(googleApi({ metrics: { scaled_interest: { status: "measured", value: 1234.5 } } })).metrics.scaled_interest.value, 1234.5);
  assert.deepEqual(codes({ ...web, metrics: { interest_index: { status: "measured", value: 50.5 } } }), ["metric_not_integer"]);
  assert.deepEqual(codes({ ...web, metrics: { interest_index: { status: "measured", value: 101 } } }), ["metric_out_of_range"]);
  assert.notEqual(TREND_SOURCES.google_trends_web.metrics[0].unit, TREND_SOURCES.google_trends_api.metrics[0].unit);
});

test("YouTube view counts are tagged with the definition in force at retrieval", () => {
  const change = Date.parse(YOUTUBE_VIEW_COUNT_CHANGE);
  const before = new Date(change - HOUR).toISOString();
  const metricsAt = (version) => ({
    chart_rank: { status: "measured", value: 1 },
    view_count: { status: "measured", value: 100, ...(version ? { definitionVersion: version } : {}) },
  });
  const atRetrieval = (iso, version) => ({
    ...youtube({ id: "v", videoId: VID_A, metrics: metricsAt(version) }),
    window: { start: iso, end: iso },
    retrievedAt: iso,
    evidence: [{ sourceId: "youtube_data_api", url: `https://www.youtube.com/watch?v=${VID_A}`, attribution: "YouTube", retrievedAt: iso }],
  });
  assert.equal(parseOk(atRetrieval(before)).metrics.view_count.definitionVersion, "youtube_data_api.view_count.v1");
  assert.equal(parseOk(atRetrieval(YOUTUBE_VIEW_COUNT_CHANGE)).metrics.view_count.definitionVersion, "youtube_data_api.view_count.v2", "the change date itself uses the new definition");
  assert.equal(parseOk(atRetrieval(at(-HOUR))).metrics.view_count.definitionVersion, "youtube_data_api.view_count.v2");
  assert.deepEqual(codes(atRetrieval(at(-HOUR), "youtube_data_api.view_count.v1")), ["metric_definition_not_in_effect"], "an old definition claimed for new data");
  assert.deepEqual(codes(atRetrieval(before, "youtube_data_api.view_count.v2")), ["metric_definition_not_in_effect"], "a new definition claimed for old data");
  assert.deepEqual(codes(atRetrieval(at(-HOUR), "youtube_data_api.view_count.v3")), ["unknown_metric_definition"]);
  assert.deepEqual(codes(atRetrieval(at(-HOUR), "youtube_data_api.like_count.v1")), ["unknown_metric_definition"], "another metric's definition");
  assert.deepEqual(codes(atRetrieval(at(-HOUR), "google_trends_web.interest_index.v1")), ["unknown_metric_definition"], "another source's definition");
});

test("every measured value is bound to exactly one definition version, deterministically", () => {
  const raw = youtube({ id: "d", videoId: VID_A });
  const first = JSON.stringify(parseOk(raw).metrics);
  for (let i = 0; i < 5; i += 1) assert.equal(JSON.stringify(parseOk(raw).metrics), first);
  const obs = parseOk(raw);
  for (const value of Object.values(obs.metrics)) {
    if (value.status === "measured") assert.match(value.definitionVersion, /^youtube_data_api\.[a-z_]+\.v\d$/);
  }
});
