import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const { discoverWikidataEvents, WIKIDATA_EVENTS_ENDPOINT } = await import("../lib/trends/connectors/wikidata-events.ts");
const { runWikidataEventDiscovery } = await import("../lib/trends/discovery.ts");

const NOW = new Date("2026-10-12T12:00:00.000Z");
const liveShape = {
  head: { vars: ["event", "label", "firstStart", "starts", "ends", "website"] },
  results: { bindings: [{
    event: { type: "uri", value: "http://www.wikidata.org/entity/Q123456" },
    label: { type: "literal", value: "Dubai Community Fitness Week" },
    starts: { type: "literal", value: "2026-11-01T00:00:00Z|11" },
    ends: { type: "literal", value: "2026-11-07T00:00:00Z|11" },
    website: { type: "uri", value: "https://example.org/event" },
  }] },
};

test("Wikidata connector makes one bounded attributed request and returns validated qualitative evidence", async () => {
  const calls = [];
  const result = await discoverWikidataEvents({
    now: NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: true, async json() { return liveShape; } };
    },
  });
  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.startsWith(WIKIDATA_EVENTS_ENDPOINT));
  assert.match(calls[0].init.headers["User-Agent"], /Voom-Trend-Intelligence/);
  assert.equal(result.status, "ok");
  assert.equal(result.events.length, 1);
  const event = result.events[0];
  assert.equal(event.observation.sourceId, "wikidata_events");
  assert.deepEqual(event.observation.metrics, {});
  assert.equal(event.observation.evidence[0].attribution, "Wikidata (CC0)");
  assert.equal(event.observation.evidence[0].url, "https://www.wikidata.org/entity/Q123456");
  assert.deepEqual(event.eventWindow, { start: "2026-11-01", end: "2026-11-07" });
});

test("connector rejects ended, duplicate, malformed and insecure records without inventing data", async () => {
  const bad = structuredClone(liveShape);
  bad.results.bindings = [
    ...liveShape.results.bindings,
    liveShape.results.bindings[0],
    { event: { value: "https://www.wikidata.org/entity/Q9" }, label: { value: "Ended event" }, starts: { value: "2026-01-01T00:00:00Z|11" }, ends: { value: "2026-01-02T00:00:00Z|11" } },
    { event: { value: "javascript:alert(1)" }, label: { value: "Bad" }, starts: { value: "2026-11-01T00:00:00Z|11" } },
  ];
  const result = await discoverWikidataEvents({ now: NOW, fetch: async () => ({ ok: true, async json() { return bad; } }) });
  assert.equal(result.status, "ok");
  assert.equal(result.events.length, 1);
  assert.equal(result.rejected, 3);
});

test("discovery stores observations but returns review candidates without approving them", async () => {
  const calls = [];
  const client = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: {
        status: "stored", observation_id: "11111111-1111-4111-8111-111111111111", revision: 1,
        item_key: null, topic_key: "topic|web|AE|en|topic|dubai community fitness week",
        trend_key: "topic|web|AE|en|topic|dubai community fitness week",
        expires_at: "2026-10-26T12:00:00Z", delete_after: "2026-11-11T12:00:00Z",
      }, error: null };
    },
  };
  const result = await runWikidataEventDiscovery({ client, now: NOW, fetch: async () => ({ ok: true, async json() { return liveShape; } }) });
  assert.equal(result.status, "completed");
  assert.equal(result.storage.counts.stored, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, "trend_store_observation");
  assert.equal(Object.hasOwn(result.reviewCandidates[0], "status"), false, "connector cannot approve review candidates");
});

test("source failures are fail-closed and never call storage", async () => {
  let stored = false;
  const result = await runWikidataEventDiscovery({
    client: { async rpc() { stored = true; return { data: null, error: null }; } },
    now: NOW,
    fetch: async () => ({ ok: false, async json() { return {}; } }),
  });
  assert.deepEqual(result, { status: "source_failed", source: { status: "failed", code: "http_error", events: [], rejected: 0, rejectedReasons: {} } });
  assert.equal(stored, false);
});

test("0057 adds only the registry row and does not approve or verify the connector", async () => {
  const db = await createSupabaseLite({ stopBefore: "0055" });
  const base = readFileSync(new URL("../supabase/proposed/0055_trend_intelligence.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/proposed/0057_wikidata_event_source.sql", import.meta.url), "utf8");
  await db.db.exec(base);
  await db.db.exec(migration);
  await db.db.exec(migration);
  const source = (await db.db.query("select * from public.trend_sources where source_id = 'wikidata_events'")).rows[0];
  assert.deepEqual(source.platforms, ["web"]);
  assert.equal(source.fresh_for, "1 day");
  assert.equal((await db.db.query("select count(*)::int n from public.trend_source_authorizations where source_id = 'wikidata_events'")).rows[0].n, 0);
  assert.equal((await db.db.query("select count(*)::int n from public.trend_source_coverage where source_id = 'wikidata_events'")).rows[0].n, 0);
});

test("0057 refuses conflicting registry data and rollback is dependency-safe", async () => {
  const base = readFileSync(new URL("../supabase/proposed/0055_trend_intelligence.sql", import.meta.url), "utf8");
  const migration = readFileSync(new URL("../supabase/proposed/0057_wikidata_event_source.sql", import.meta.url), "utf8");
  const rollback = readFileSync(new URL("../supabase/proposed/0057_wikidata_event_source.rollback.sql", import.meta.url), "utf8");

  const conflict = await createSupabaseLite({ stopBefore: "0055" });
  await conflict.db.exec(base);
  await conflict.db.exec(`insert into public.trend_sources
    (source_id, platforms, subject_kinds, language_scope, requires_evidence_url, max_retention_days, fresh_for, stale_after, expires_after)
    values ('wikidata_events', array['web'], array['topic'], 'optional', true, 99, interval '1 day', interval '3 days', interval '14 days')`);
  await assert.rejects(() => conflict.db.exec(migration), /conflicting wikidata_events source definition/);
  await conflict.db.exec("rollback");
  assert.equal((await conflict.db.query("select max_retention_days from public.trend_sources where source_id='wikidata_events'")).rows[0].max_retention_days, 99);

  const protectedDb = await createSupabaseLite({ stopBefore: "0055" });
  await protectedDb.db.exec(base);
  await protectedDb.db.exec(migration);
  await protectedDb.db.exec(`insert into public.trend_source_authorizations
    (source_id,status,decided_at,decided_by,reference)
    values ('wikidata_events','approved',now(),'test owner','test approval')`);
  await assert.rejects(() => protectedDb.db.exec(rollback), /foreign key|violates foreign key constraint/i);
  await protectedDb.db.exec("rollback");
  assert.equal((await protectedDb.db.query("select count(*)::int n from public.trend_sources where source_id='wikidata_events'")).rows[0].n, 1);
  assert.equal((await protectedDb.db.query("select count(*)::int n from public.trend_source_authorizations where source_id='wikidata_events'")).rows[0].n, 1);

  await protectedDb.db.exec("delete from public.trend_source_authorizations where source_id='wikidata_events'");
  await protectedDb.db.exec(rollback);
  assert.equal((await protectedDb.db.query("select count(*)::int n from public.trend_sources where source_id='wikidata_events'")).rows[0].n, 0);
  assert.equal((await protectedDb.db.query("select count(*)::int n from public.trend_sources")).rows[0].n, 4);
});
