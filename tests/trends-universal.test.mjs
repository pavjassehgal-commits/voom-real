/**
 * Universal Trend Intelligence: multi-industry sources, governed collection
 * and business-specific relevance. Local PGlite (0051 base + 0055–0058) with deterministic source fixtures; no network.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { createTrendDb, MARA_CONTEXT_SQL, rpcClient } from "./helpers/trend-db.mjs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const WIKIDATA_SQL = read("../supabase/migrations/0057_wikidata_event_source.sql");
const UNIVERSAL_SQL = read("../supabase/migrations/0058_universal_trend_sources.sql");
const UNIVERSAL_ROLLBACK_SQL = read("../supabase/proposed/0058_universal_trend_sources.rollback.sql");

const { discoverPublicHolidays } = await import("../lib/trends/connectors/public-holidays.ts");
const { discoverTopWikipediaArticles } = await import("../lib/trends/connectors/wikimedia-pageviews.ts");
const { runUniversalTrendCollection } = await import("../lib/trends/universal-collection.ts");
const { runWikidataEventDiscovery } = await import("../lib/trends/discovery.ts");
const { loadBusinessTrendIdeas } = await import("../lib/trends/business-trends.ts");
const relevance = await import("../lib/trends/relevance.ts");
const industry = await import("../lib/trends/industry.ts");

const NOW = new Date("2026-10-13T06:00:00.000Z");

const US_HOLIDAYS_2026 = [
  { date: "2026-10-12", name: "Columbus Day", global: true, types: ["Public"] },
  { date: "2026-11-11", name: "Veterans Day", global: true, types: ["Public"] },
  { date: "2026-11-26", name: "Thanksgiving Day", global: true, types: ["Public"] },
  { date: "2026-11-03", name: "Election Day", global: false, counties: ["US-NY"], types: ["Public"] },
  { date: "2026-12-25", name: "Christmas Day", global: true, types: ["Public"] },
];
const GB_HOLIDAYS_2026 = [
  { date: "2026-11-30", name: "Saint Andrew's Day", global: false, counties: ["GB-SCT"], types: ["Public"] },
  { date: "2026-12-25", name: "Christmas Day", global: true, types: ["Public"] },
];
const TOP_ARTICLES = [
  ["Main_Page", 6_000_000], ["Special:Search", 700_000], ["Halloween", 310_000], ["Formula_One", 150_000],
  ["Deaths_in_2026", 140_000], ["Mathematics", 120_000], ["Pumpkin_spice", 91_000], ["Met_Gala", 80_000],
  ["2026_United_States_elections", 75_000], ["Skin_care", 40_000], ["Interior_design", 30_000], ["Diwali", 28_000],
  ["Pet_food", 12_000], ["Taylor_Swift", 11_000], ["Wikipedia:Featured_pictures", 9_000],
].map(([article, views], index) => ({ article, views, rank: index + 1 }));
const GP_BINDINGS = { results: { bindings: [{
  event: { value: "http://www.wikidata.org/entity/Q115910679" }, label: { value: "2026 Abu Dhabi Grand Prix" },
  starts: { value: "2026-12-04T00:00:00Z|11" }, ends: { value: "2026-12-06T00:00:00Z|11" },
}] } };

/** Routes the three public sources to fixtures and counts every request. */
function fixtureNetwork() {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    const json = (body) => ({ ok: true, status: 200, async json() { return body; } });
    if (url.startsWith("https://date.nager.at/api/v3/PublicHolidays/2026/US")) return json(US_HOLIDAYS_2026);
    if (url.startsWith("https://date.nager.at/api/v3/PublicHolidays/2026/GB")) return json(GB_HOLIDAYS_2026);
    if (url.startsWith("https://date.nager.at/api/v3/PublicHolidays/2026/AE")) return { ok: true, status: 204, async json() { throw new Error("no body"); } };
    if (url === "https://wikimedia.org/api/rest_v1/metrics/pageviews/top/en.wikipedia/all-access/2026/10/12") {
      return json({ items: [{ project: "en.wikipedia", access: "all-access", year: "2026", month: "10", day: "12", articles: TOP_ARTICLES }] });
    }
    if (url.startsWith("https://query.wikidata.org/sparql")) return json(GP_BINDINGS);
    return { ok: false, status: 500, async json() { return {}; } };
  };
  return { fetch, calls };
}

const GOVERNANCE = `
  insert into public.trend_source_authorizations (source_id, status, decided_at, decided_by, reference) values
    ('public_holidays_nager', 'approved', now(), 'owner:test', 'LEGAL-NAGER'),
    ('wikimedia_pageviews', 'approved', now(), 'owner:test', 'LEGAL-WIKIMEDIA'),
    ('wikidata_events', 'approved', now(), 'owner:test', 'LEGAL-WIKIDATA');
  insert into public.trend_source_coverage (source_id, platform, country, status, checked_at, evidence, checked_by) values
    ('public_holidays_nager', 'web', 'US', 'verified', now(), 'COVERAGE-US', 'owner:test'),
    ('public_holidays_nager', 'web', 'GB', 'verified', now(), 'COVERAGE-GB', 'owner:test'),
    ('public_holidays_nager', 'web', 'AE', 'verified', now(), 'COVERAGE-AE', 'owner:test'),
    ('wikimedia_pageviews', 'web', 'ZZ', 'verified', now(), 'COVERAGE-ZZ', 'owner:test'),
    ('wikidata_events', 'web', 'AE', 'verified', now(), 'COVERAGE-AE', 'owner:test');
`;

async function universalDb({ governance = true } = {}) {
  const { db } = await createTrendDb();
  await db.exec(MARA_CONTEXT_SQL);
  await db.exec(WIKIDATA_SQL);
  await db.exec(UNIVERSAL_SQL);
  if (governance) await db.exec(GOVERNANCE);
  return db;
}

async function collectedDb() {
  const db = await universalDb();
  const net = fixtureNetwork();
  const report = await runUniversalTrendCollection({ client: rpcClient(db), now: NOW, fetch: net.fetch, holidayCountries: ["US", "GB", "AE"] });
  const wikidata = await runWikidataEventDiscovery({ client: rpcClient(db), now: NOW, fetch: net.fetch });
  assert.equal(wikidata.status, "completed");
  return { db, report, net };
}

const BUSINESSES = {
  restaurant: { brandName: "Copper Kettle Cafe", industry: "Restaurant", description: "Neighbourhood cafe and bakery in Chicago serving brunch and pastries.", targetCustomer: ["Local families"], goal: "More weekend bookings" },
  fashion: { brandName: "Thread & Bloom", industry: "Fashion boutique", description: "Independent womenswear boutique selling dresses and accessories online.", targetCustomer: ["Women who love vintage style"], goal: "Grow online sales" },
  automotive: { brandName: "Gulf Gloss", industry: "Car detailing", description: "Premium car detailing and ceramic coating in Abu Dhabi and Dubai.", targetCustomer: ["Car owners"], goal: "More bookings" },
  beauty: { brandName: "Glow Room", industry: "Beauty salon", description: "Skincare facials and nail studio in Boston.", targetCustomer: ["Busy professionals"], goal: "Fill weekday appointments" },
  home: { brandName: "Hearth & Loom", industry: "Home products", description: "Online store for candles, rugs and interior decor.", targetCustomer: ["New homeowners"], goal: "Grow repeat customers" },
  pets: { brandName: "Happy Paws", industry: "Pet shop", description: "Pet store with healthy dog and cat food.", targetCustomer: ["Dog owners"], goal: "Grow awareness" },
  unknown: { brandName: "Acme Co", industry: "", description: "We help people.", targetCustomer: [], goal: "" },
};

/* ── Connectors ─────────────────────────────────────────────────── */

test("public holidays: only nationwide public holidays inside the horizon, dated in the evidence URL", async () => {
  const net = fixtureNetwork();
  const us = await discoverPublicHolidays({ now: NOW, country: "US", fetch: net.fetch });
  assert.equal(us.status, "ok");
  assert.deepEqual(us.holidays.map((h) => [h.name, h.date]), [["Veterans Day", "2026-11-11"], ["Thanksgiving Day", "2026-11-26"]]);
  assert.equal(us.rejected, 3, "past, regional and out-of-horizon holidays are dropped");
  const evidence = us.holidays[1].observation.evidence[0];
  assert.equal(evidence.url, "https://date.nager.at/api/v3/PublicHolidays/2026/US#2026-11-26");
  assert.equal(us.holidays[1].observation.market.country, "US");
  const ae = await discoverPublicHolidays({ now: NOW, country: "AE", fetch: net.fetch });
  assert.equal(ae.status, "no_data", "an unsupported country is reported, not invented");
  assert.equal((await discoverPublicHolidays({ now: NOW, country: "U5", fetch: net.fetch })).status, "failed");
  assert.equal((await discoverPublicHolidays({ now: NOW, country: "FR", fetch: net.fetch })).code, "http_error");
});

test("Wikipedia attention: keeps brand-safe, business-relevant articles with their measured views; drops the rest", async () => {
  const net = fixtureNetwork();
  const result = await discoverTopWikipediaArticles({ now: NOW, fetch: net.fetch });
  assert.equal(result.status, "ok");
  assert.equal(result.day, "2026-10-12");
  assert.deepEqual(result.kept.map((k) => k.observation.subject.text),
    ["Halloween", "Formula One", "Pumpkin spice", "Met Gala", "Skin care", "Interior design", "Diwali", "Pet food"]);
  assert.equal(result.dropped.unsafe_topic, 2, "deaths and elections are never kept");
  assert.equal(result.dropped.not_a_topic, 3);
  assert.equal(result.dropped.no_business_signal, 2);
  const pumpkin = result.kept.find((k) => k.article === "Pumpkin_spice").observation;
  assert.deepEqual(pumpkin.market, { country: "ZZ", language: "en" });
  assert.equal(pumpkin.metrics.daily_views.value, 91000);
  assert.match(pumpkin.evidence[0].url, /per-article\/en\.wikipedia\/all-access\/all-agents\/Pumpkin_spice\/daily\/20261012\/20261012$/);
  assert.equal((await discoverTopWikipediaArticles({ now: NOW, language: "xx", fetch: net.fetch })).code, "unsupported_language");
});

/* ── Governed collection ────────────────────────────────────────── */

test("without owner approval and coverage, collection makes no request and stores nothing", async () => {
  const db = await universalDb({ governance: false });
  const net = fixtureNetwork();
  const report = await runUniversalTrendCollection({ client: rpcClient(db), now: NOW, fetch: net.fetch, holidayCountries: ["US", "GB"] });
  assert.equal(net.calls.length, 0);
  assert.ok(report.markets.every((m) => m.status === "not_authorized"));
  assert.equal(Number((await db.query("select count(*) n from public.trend_observations")).rows[0].n), 0);
});

test("approved sources are collected once, rate-limited, and stored through the governed RPC", async () => {
  const { db, report, net } = await collectedDb();
  const byMarket = Object.fromEntries(report.markets.map((m) => [`${m.source}:${m.market}`, m]));
  assert.equal(byMarket["public_holidays_nager:US"].stored, 2);
  assert.equal(byMarket["public_holidays_nager:GB"].stored, 0);
  assert.equal(byMarket["public_holidays_nager:AE"].status, "no_data");
  assert.equal(byMarket["wikimedia_pageviews:ZZ/en"].stored, 8);
  assert.equal(report.approvalsCreated, 0);
  assert.equal(report.contextsCreated, 0);
  const before = net.calls.length;
  const again = await runUniversalTrendCollection({ client: rpcClient(db), now: new Date(NOW.getTime() + 3_600_000), fetch: net.fetch, holidayCountries: ["US"] });
  assert.equal(net.calls.length, before, "a second run within 20 hours makes no request");
  assert.ok(again.markets.every((m) => m.status === "skipped_recently_collected"));
  assert.equal(Number((await db.query("select count(*) n from public.trend_mara_contexts")).rows[0].n), 0, "never creates MARA contexts");
});

test("0058 is reversible and refuses to roll back while its sources are referenced", async () => {
  const db = await universalDb({ governance: false });
  await db.exec(UNIVERSAL_ROLLBACK_SQL);
  assert.equal(Number((await db.query("select count(*) n from public.trend_sources where source_id in ('public_holidays_nager','wikimedia_pageviews')")).rows[0].n), 0);
  await db.exec(UNIVERSAL_SQL);
  await db.exec(GOVERNANCE);
  await assert.rejects(db.exec(UNIVERSAL_ROLLBACK_SQL), /rollback refused/);
});

/* ── Relevance for arbitrary businesses ─────────────────────────── */

test("profiles use only what the business wrote: industries and named places, never the timezone or guesses", () => {
  const detailing = relevance.businessTrendProfile({ industry: "Car detailing", description: "Paint correction and ceramic coating." });
  assert.deepEqual(detailing.industries, ["automotive"]);
  assert.deepEqual(detailing.markets, []);
  assert.equal(detailing.marketBasis, "not_stated");
  const cafe = relevance.businessTrendProfile(BUSINESSES.restaurant);
  assert.deepEqual(cafe.industries, ["food_beverage"]);
  assert.deepEqual(cafe.markets, [{ country: "US", mentioned: "chicago" }]);
  assert.deepEqual(relevance.businessTrendProfile(BUSINESSES.unknown).industries, []);
  assert.deepEqual(industry.marketsMentioned("Serving Abu Dhabi, Dubai and London"), [{ country: "AE", mentioned: "abu dhabi" }, { country: "GB", mentioned: "london" }]);
});

test("Replenish evidence is tailored across unrelated industries (restaurant, fashion, automotive, beauty, home, pets)", async () => {
  const { db } = await collectedDb();
  const ideas = {};
  for (const [key, business] of Object.entries(BUSINESSES)) {
    ideas[key] = await loadBusinessTrendIdeas(rpcClient(db), business, NOW, { max: 3 });
  }
  const topics = (key) => ideas[key].status === "matched" ? ideas[key].ideas.map((i) => i.context.topic) : [];
  const first = (key) => ideas[key].ideas[0];

  // Restaurant in Chicago: food attention first, then its own country's holidays.
  assert.equal(first("restaurant").context.topic, "Pumpkin spice");
  assert.equal(first("restaurant").basis.kind, "industry_match");
  assert.deepEqual(first("restaurant").basis.matchedIndustries, ["food_beverage"]);
  assert.ok(topics("restaurant").includes("Veterans Day"));
  // Fashion with no stated location: fashion attention, and no country's holidays.
  assert.equal(first("fashion").context.topic, "Met Gala");
  assert.ok(!topics("fashion").some((t) => ["Veterans Day", "Thanksgiving Day"].includes(t)));
  // Car detailing in Abu Dhabi/Dubai: automotive signals only.
  assert.ok(["Formula One", "2026 Abu Dhabi Grand Prix"].includes(first("automotive").context.topic));
  assert.ok(topics("automotive").includes("2026 Abu Dhabi Grand Prix"));
  assert.ok(topics("automotive").includes("Formula One"));
  // Industry matches rank first; anything after them is only a clearly labelled cultural moment.
  const kinds = ideas.automotive.ideas.map((i) => i.basis.kind);
  assert.deepEqual(kinds.slice(0, 2), ["industry_match", "industry_match"]);
  assert.ok(ideas.automotive.ideas.slice(0, 2).every((i) => i.basis.matchedIndustries.includes("automotive")));
  assert.ok(kinds.slice(2).every((kind) => kind === "cultural_moment"));
  // Beauty salon in Boston and an online home store.
  assert.equal(first("beauty").context.topic, "Skin care");
  assert.ok(topics("beauty").includes("Veterans Day"), "US holiday for a business that names a US city");
  assert.equal(first("home").context.topic, "Interior design");
  assert.equal(first("pets").context.topic, "Pet food");

  // No cross-industry leakage.
  assert.ok(!topics("restaurant").includes("Met Gala"));
  assert.ok(!topics("fashion").includes("Formula One"));
  assert.ok(!topics("automotive").includes("Pumpkin spice"));
  assert.ok(!topics("home").includes("Skin care"));
  // Every business with nothing specific still gets a clearly worldwide cultural moment, never an industry claim.
  assert.equal(ideas.unknown.status, "matched");
  assert.ok(ideas.unknown.ideas.every((i) => i.basis.kind === "cultural_moment" && i.context.market.country === "ZZ"));
  // Unsafe or irrelevant topics never reach anyone.
  for (const result of Object.values(ideas)) {
    for (const idea of result.ideas ?? []) assert.doesNotMatch(idea.context.topic, /Deaths|election|Mathematics|Taylor Swift/i);
  }
});

test("every fact is written from stored, attributed data and carries the right caveats", async () => {
  const { db } = await collectedDb();
  const restaurant = await loadBusinessTrendIdeas(rpcClient(db), BUSINESSES.restaurant, NOW, { max: 3 });
  const pumpkin = restaurant.ideas.find((i) => i.context.topic === "Pumpkin spice").context;
  assert.equal(pumpkin.facts[0].statement, "\"Pumpkin spice\" was among the most-viewed English Wikipedia articles on 2026-10-12, with 91000 views, according to Wikimedia pageview statistics.");
  assert.deepEqual(pumpkin.facts[0].sources, ["Wikimedia pageviews"]);
  assert.ok(pumpkin.caveats.some((c) => /Wikipedia reader attention only/.test(c)));
  assert.ok(pumpkin.caveats.some((c) => /Worldwide signal/.test(c)));
  const veterans = restaurant.ideas.find((i) => i.context.topic === "Veterans Day").context;
  assert.equal(veterans.facts[0].statement, "Veterans Day is a public holiday in the United States on 2026-11-11, according to the Nager.Date public holiday calendar.");
  assert.deepEqual(veterans.eventWindow, { start: "2026-11-11", end: "2026-11-11" });
  assert.ok(veterans.caveats.some((c) => /mentions chicago/.test(c)), "the market basis is disclosed");
  const automotive = await loadBusinessTrendIdeas(rpcClient(db), BUSINESSES.automotive, NOW, { max: 3 });
  const gp = automotive.ideas.find((i) => i.context.topic === "2026 Abu Dhabi Grand Prix").context;
  assert.equal(gp.facts[0].statement, "2026 Abu Dhabi Grand Prix is listed in Wikidata as an upcoming event in the United Arab Emirates.");
  assert.equal(gp.eventWindow, null, "no unreviewed date is stated");
  for (const idea of [...restaurant.ideas, ...automotive.ideas]) {
    assert.ok(idea.context.caveats.length <= 4);
    assert.ok(idea.context.facts.every((f) => f.statement.length <= 300 && f.sources.length >= 1));
  }
});

test("invalidated or expired evidence disappears from matching immediately; no evidence means evergreen", async () => {
  const { db } = await collectedDb();
  const id = (await db.query("select id from public.trend_observations where subject_text = 'Met Gala'")).rows[0].id;
  await db.query("select public.trend_invalidate_observation($1, 'wrong_item', 'staff:test', 'T-1')", [id]);
  const fashion = await loadBusinessTrendIdeas(rpcClient(db), BUSINESSES.fashion, NOW, { max: 3 });
  assert.ok(!(fashion.ideas ?? []).some((i) => i.context.topic === "Met Gala"));
  const later = await loadBusinessTrendIdeas(rpcClient(db), BUSINESSES.restaurant, new Date(NOW.getTime() + 60 * 86_400_000), { max: 3 });
  assert.equal(later.status, "evergreen", "expired evidence is never used");
  const empty = relevance.selectTrendIdeasForBusiness(relevance.businessTrendProfile(BUSINESSES.restaurant), [], { now: NOW.getTime() });
  assert.deepEqual([empty.status, empty.reason], ["evergreen", "no_usable_evidence"]);
});

test("matched ideas pass MARA's real grounding and claim checks for every industry's Reel/video slot", async () => {
  const service = await import("../lib/voom/workflow/service.ts");
  const timezone = await import("../lib/voom/timezone.ts");
  const { db } = await collectedDb();
  const date = "2026-10-14";
  const slot = { date, slotKey: `${date}|instagram_reel`, index: 0, channel: "instagram", format: "reel", contentType: "reel", publishAt: timezone.localToUtcIso(date, 18 * 60, "Asia/Dubai") };
  for (const key of ["restaurant", "fashion", "automotive", "beauty", "home", "pets"]) {
    const business = BUSINESSES[key];
    const selection = await loadBusinessTrendIdeas(rpcClient(db), business, NOW, { max: 2 });
    assert.equal(selection.status, "matched", key);
    const opportunity = selection.ideas[0].context;
    const captured = [];
    const content = await service.generateWorkflowPlannedContent({
      business: { brand_name: business.brandName, brand_description: business.description, industry: business.industry, target_customer: business.targetCustomer, main_goal: business.goal },
      goal: business.goal || "Grow awareness", cadence: "3x_week", timeZone: "Asia/Dubai", slot, plannedConcepts: [], performance: null,
      trendOpportunity: opportunity,
      provider: { async structured(request) {
        const payload = JSON.parse(request.messages[1].content);
        captured.push(payload);
        const topic = payload.trendOpportunity.topic;
        return request.parse({
          concept: `${topic} with ${business.brandName}`,
          hook: `Here is how ${business.brandName} marks ${topic}.`,
          caption: `${topic} is on people's minds. Here is a simple way ${business.brandName} fits in.`,
          cta: "Follow for more.", hashtags: [business.brandName.replace(/[^A-Za-z]/g, "")],
          description: "", script: ["Open with the moment", "Show the product", "Share one practical tip", "Invite viewers in"],
          visualBrief: "Vertical, brand-owned visuals; no third-party logos or partnership claims.",
        });
      } },
    });
    assert.match(content.concept, new RegExp(opportunity.topic.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), key);
    assert.equal(captured[0].trendOpportunity.facts[0].statement, opportunity.facts[0].statement, "MARA receives exactly the stored, attributed fact");
  }
});

test("real-world precision: names, place-specific titles and film floods do not leak into unrelated businesses", async () => {
  assert.equal(industry.momentTitle("Summer H. Howell"), null, "a person named Summer is not a season");
  assert.equal(industry.momentTitle("Diwali 2026"), "diwali");
  assert.equal(industry.momentTitle("Thanksgiving (Canada)"), "thanksgiving");
  assert.deepEqual(industry.classifyText("Tom Cruise").industries, [], "a surname is not a travel signal");
  const day = "2026-10-12";
  const attention = (id, text, views) => ({
    storageId: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`, sourceId: "wikimedia_pageviews", platform: "web",
    market: { country: "ZZ", language: "en" }, subject: { text }, window: { start: `${day}T00:00:00.000Z`, end: "2026-10-13T00:00:00.000Z" },
    retrievedAt: NOW.toISOString(), freshness: { expiresAt: "2026-10-20T00:00:00.000Z" },
    metrics: { daily_views: { status: "measured", value: views } },
    evidence: [{ sourceId: "wikimedia_pageviews", url: "https://wikimedia.org/x", attribution: "Wikimedia pageviews", retrievedAt: NOW.toISOString() }],
  });
  const observations = [attention(1, "Thanksgiving (Canada)", 48_947), attention(2, "Summer H. Howell", 48_687), attention(3, "Tom Cruise", 18_235), attention(4, "Halloween", 30_000)];
  const pick = (business) => {
    const selection = relevance.selectTrendIdeasForBusiness(relevance.businessTrendProfile(business), observations, { now: NOW.getTime(), max: 3 });
    return selection.status === "matched" ? selection.ideas.map((i) => i.context.topic) : [];
  };
  assert.deepEqual(pick({ industry: "Restaurant", description: "Family restaurant in Manchester" }), ["Halloween"]);
  assert.deepEqual(pick({ industry: "Restaurant", description: "Family restaurant in Toronto" }), ["Thanksgiving (Canada)", "Halloween"]);
  assert.deepEqual(pick({ industry: "Travel agency", description: "Holidays and tours" }), ["Halloween"]);
  const near = [attention(5, "Formula One", 150_000), attention(6, "2026 Formula One World Championship", 30_000)];
  const cars = relevance.selectTrendIdeasForBusiness(relevance.businessTrendProfile({ industry: "Car detailing" }), near, { now: NOW.getTime(), max: 3 });
  assert.deepEqual(cars.ideas.map((i) => i.context.topic), ["Formula One"], "near-duplicate topics are offered once");

  // A day dominated by films keeps at most four per industry, leaving room for other industries.
  const films = Array.from({ length: 12 }, (_, i) => ({ article: `Movie_${i}_(2026_film)`, views: 100_000 - i, rank: i + 1 }));
  const list = [...films, { article: "Pumpkin_spice", views: 5_000, rank: 13 }, { article: "List_of_highest-grossing_films", views: 4_000, rank: 14 }];
  const result = await discoverTopWikipediaArticles({ now: NOW, fetch: async () => ({ ok: true, status: 200, async json() { return { items: [{ articles: list }] }; } }) });
  assert.equal(result.kept.filter((k) => k.industries.includes("events_entertainment")).length, 4);
  assert.ok(result.kept.some((k) => k.article === "Pumpkin_spice"));
  assert.ok(!result.kept.some((k) => k.article.startsWith("List_of")));
});

test("Wikipedia attention can never be presented as Instagram, TikTok, search or general popularity", async () => {
  const { checkTrendGroundedContent } = await import("../lib/trends/claim-check.ts");
  const service = await import("../lib/voom/workflow/service.ts");
  const timezone = await import("../lib/voom/timezone.ts");
  const { db } = await collectedDb();
  const selection = await loadBusinessTrendIdeas(rpcClient(db), BUSINESSES.restaurant, NOW, { max: 1 });
  const context = selection.ideas[0].context;
  assert.equal(context.topic, "Pumpkin spice");
  const business = { name: "Copper Kettle Cafe", description: BUSINESSES.restaurant.description, industry: "Restaurant", goal: "", targetCustomer: [] };
  const copy = (caption) => ({ concept: "Pumpkin spice at the cafe", hook: "", caption, cta: "", hashtags: [], description: "", script: [], visualBrief: "" });
  for (const claim of ["Pumpkin spice is trending on TikTok.", "Pumpkin spice went viral this week.", "Pumpkin spice is huge on Instagram.", "The most-searched flavour: Pumpkin spice."]) {
    const result = checkTrendGroundedContent(copy(claim), context, business);
    assert.ok(result.findings.some((f) => f.kind === "popularity_claim"), claim);
  }
  assert.equal(checkTrendGroundedContent(copy("Pumpkin spice season is here at Copper Kettle Cafe."), context, business).clean, true);

  // Through MARA's real generation path the same claim is rejected, never stored.
  const date = "2026-10-14";
  await assert.rejects(() => service.generateWorkflowPlannedContent({
    business: { brand_name: "Copper Kettle Cafe", brand_description: BUSINESSES.restaurant.description, industry: "Restaurant", target_customer: [] },
    goal: "Grow awareness", cadence: "3x_week", timeZone: "Asia/Dubai", plannedConcepts: [], performance: null, trendOpportunity: context,
    slot: { date, slotKey: `${date}|tiktok_video`, index: 0, channel: "tiktok", format: "video", contentType: "video", publishAt: timezone.localToUtcIso(date, 18 * 60, "Asia/Dubai") },
    provider: { async structured(request) { return request.parse({
      concept: "Pumpkin spice at Copper Kettle Cafe", hook: "Pumpkin spice is all over TikTok right now.", caption: "Pumpkin spice is trending, so we made one.",
      cta: "Visit us.", hashtags: ["PumpkinSpice"], description: "", script: ["Open", "Show the drink", "Explain", "Invite"], visualBrief: "Cafe counter.",
    }); } },
  }), /content_generation_failed/);
});
