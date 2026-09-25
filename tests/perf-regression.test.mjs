/**
 * Performance regression tests — navigation data path.
 *
 * Guard the architectural problems that made authenticated navigation take
 * tens of seconds from ever returning:
 *
 *   - independent owner-scoped reads stay PARALLEL (not a sequential waterfall);
 *   - the Instagram media preview N+1 stays ONE batched storage round trip;
 *   - duplicate reads within one request stay eliminated (one performance
 *     model, one business resolution chain per render);
 *   - request memoization is request-SCOPED: it deduplicates within one
 *     request, can never leak across users/businesses, and never outlives the
 *     request (mutations are visible to the very next request);
 *   - normal navigation data loading makes ZERO external provider/API calls;
 *   - the route-level loading boundary stays in place inside the shell;
 *   - shell navigation stays on Next <Link> (prefetch) — no hard page loads.
 *
 * These run the REAL server modules against the instrumented double in
 * tests/perf (see tests/perf/profile-navigation.mjs for the full profiler).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { installRuntime } from "./perf/runtime.mjs";

installRuntime();

const { runInRequestScope } = await import("./perf/request-scope.mjs");
const { beginScenario, scenario, endScenario } = await import("./perf/fake-context.mjs");
const { OWNER_A, OWNER_B, seedStore } = await import("./perf/seed.mjs");
const operatingData = await import("@/lib/voom/operating-data");
const perfData = await import("@/lib/performance/data");
const { createClient } = await import("@/utils/supabase/server");

const RTT = 40; // ms per simulated round trip
const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

/** Runs one simulated request against a seeded account; returns trace+result. */
async function measure(fn, { owner = OWNER_A, store } = {}) {
  beginScenario({ rttMs: RTT, claims: { sub: owner, email: `${owner}@example.com` }, store });
  const result = await runInRequestScope(fn);
  const finished = endScenario();
  return { trace: finished.trace, result };
}

const overlaps = (a, b) => a.start < b.end && b.start < a.end;

const todayRequest = async () => {
  const data = await operatingData.getOperatingData();
  if (data) await data.performance;
  return data;
};

// ──────────────────────────────────────────────────────────────────────────
// 1. Independent reads stay parallel
// ──────────────────────────────────────────────────────────────────────────

test("independent navigation reads run concurrently — the waterfall never returns", async () => {
  const { trace } = await measure(todayRequest);

  // A sequential waterfall of this request's reads would cost ~45 round trips.
  // The parallel wave must keep the critical path near one batch (~≤12).
  assert.ok(
    trace.criticalPathRtts <= 12,
    `navigation data path degenerated to ${trace.criticalPathRtts.toFixed(1)} sequential round trips`,
  );
  assert.ok(trace.maxConcurrency >= 5, `independent reads stopped overlapping (max concurrency ${trace.maxConcurrency})`);
});

test("the coordinator's state reads overlap instead of serialising", async () => {
  const coordService = await import("@/lib/coordinator/service");
  const { trace } = await measure(async () => {
    await coordService.runCoordinatorForOwner(scenario().admin, OWNER_A, "biz-1", { trigger: "ui_read" });
  });
  assert.ok(trace.maxConcurrency >= 5, `coordinator reads serialised (max concurrency ${trace.maxConcurrency})`);
  assert.ok(trace.criticalPathRtts <= 6, `coordinator critical path regressed to ${trace.criticalPathRtts.toFixed(1)} RTTs`);
});

test("workflow snapshot reads and signed URLs overlap the rest of the request", async () => {
  const { trace } = await measure(todayRequest);
  const signOps = trace.ops.filter((op) => op.label.startsWith("storage.sign"));
  const dbOps = trace.ops.filter((op) => op.label.startsWith("rest:"));
  assert.ok(signOps.length > 0 && dbOps.length > 0);
  assert.ok(
    signOps.some((signOp) => dbOps.some((dbOp) => overlaps(signOp, dbOp))),
    "storage signing no longer overlaps database reads",
  );
});

// ──────────────────────────────────────────────────────────────────────────
// 2. Media preview N+1 eliminated
// ──────────────────────────────────────────────────────────────────────────

test("every stored visual is signed in ONE batched storage round trip", async () => {
  const { trace, result } = await measure(async () => {
    const data = await operatingData.getOperatingData();
    return data;
  });
  const signOps = trace.ops.filter((op) => op.label.startsWith("storage.sign"));
  const withPreview = result.snapshot.items.filter((item) => item.mediaPreviewUrl);
  assert.equal(signOps.length, 1, `expected one batched sign call, got ${signOps.length}`);
  assert.ok(withPreview.length >= 10, "seed must exercise many stored visuals");
  for (const item of withPreview) {
    assert.match(item.mediaPreviewUrl, /signed|token=/, "previews are real signed URLs");
  }
  // Every Instagram item with media still gets its preview — nothing dropped.
  assert.equal(withPreview.length, result.snapshot.items.filter((item) => item.hasMedia && item.channel === "instagram").length);
});

// ──────────────────────────────────────────────────────────────────────────
// 3. Duplicate reads within one request stay eliminated
// ──────────────────────────────────────────────────────────────────────────

test("Today's request reads the performance model exactly once", async () => {
  const { trace } = await measure(todayRequest);
  const counts = trace.counts();
  assert.equal(counts["rest:instagram_performance_snapshots"] ?? 0, 1, "the performance model is read twice per request again");
});

test("getOperatingData does not re-read the businesses row the layouts resolved", async () => {
  const { trace } = await measure(async () => {
    const serverData = await import("@/lib/voom/server-data");
    await serverData.getBusinessRecord();
    await operatingData.getOperatingData();
  });
  const counts = trace.counts();
  // One session read for the layouts/shared record + one coordinator-internal
  // read. The old triple-read (layout + snapshot + coordinator) must not return.
  assert.ok((counts["rest:businesses"] ?? 0) <= 2, `businesses read ${counts["rest:businesses"]}× per request`);
});

// ──────────────────────────────────────────────────────────────────────────
// 4. Request-scoped memoization: dedupe inside, isolation and freshness outside
// ──────────────────────────────────────────────────────────────────────────

test("repeated getOperatingData in one request shares ONE read set", async () => {
  const { trace } = await measure(async () => {
    const [a, b] = await Promise.all([operatingData.getOperatingData(), operatingData.getOperatingData()]);
    assert.equal(a, b, "both callers must share the same request-scoped computation");
    await a.performance;
    return a;
  });
  assert.ok(trace.ops.length < 40, `request memoization failed (${trace.ops.length} round trips for one logical read)`);
});

test("the memo never outlives a request: the next request sees fresh state", async () => {
  const store = seedStore(new Date());
  const first = await measure(todayRequest, { store });
  assert.ok(first.result);

  // A real mutation (a new pending approval) between two requests…
  store.get("mara_pending_actions").push({
    id: "act-fresh",
    owner_user_id: OWNER_A,
    tool_name: "propose_calendar_item",
    summary: "Just created",
    old_value: null,
    new_value: {},
    sanitized_arguments: {},
    status: "pending",
    result_summary: null,
    error_summary: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    executed_at: null,
  });

  const second = await measure(async () => {
    const data = await operatingData.getOperatingData();
    return data;
  }, { store });
  assert.ok(
    second.result.actions.some((action) => action.id === "act-fresh"),
    "a cached cross-request read hid a fresh approval from the next request",
  );
});

test("request memoization is owner-scoped — one account can never serve another", async () => {
  const store = seedStore(new Date());
  const asA = await measure(todayRequest, { owner: OWNER_A, store });
  const asB = await measure(todayRequest, { owner: OWNER_B, store });

  assert.equal(asA.result.user.id, OWNER_A);
  assert.equal(asB.result.user.id, OWNER_B);
  assert.equal(asB.result.business.brand_name, "Other Owner Brand");
  assert.ok(
    asB.result.snapshot.items.every((item) => item.draftId.startsWith("draft-b-")),
    "owner B's snapshot leaked owner A's items",
  );
  assert.ok(!asA.result.snapshot.items.some((item) => item.draftId.startsWith("draft-b-")));
  // And the shared performance promise is owner-pure too.
  const perfB = await asB.result.performance;
  assert.equal(perfB.items.length, 0, "owner B must not inherit owner A's measurements");
  const perfA = await asA.result.performance;
  assert.ok(perfA.items.length > 0);
});

// ──────────────────────────────────────────────────────────────────────────
// 5. Navigation never calls external provider/API endpoints
// ──────────────────────────────────────────────────────────────────────────

test("normal navigation data loading makes zero external fetch calls", async () => {
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    calls.push(String(args[0]));
    throw new Error(`unexpected external call during navigation: ${args[0]}`);
  };
  try {
    await measure(todayRequest);
    const { getOperatingData } = operatingData;
    await measure(async () => {
      const data = await getOperatingData();
      if (data) await data.performance;
      const readiness = await (await import("@/lib/social/readiness")).readSocialChannelReadiness(scenario().admin, OWNER_A);
      assert.ok(readiness.length > 0);
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.deepEqual(calls, [], "navigation hit an external provider/API");
});

// ──────────────────────────────────────────────────────────────────────────
// 6. Route-level loading boundary stays in place
// ──────────────────────────────────────────────────────────────────────────

test("the shell keeps a loading boundary for streamed navigation feedback", async () => {
  const loading = await read("app/app/(shell)/loading.tsx");
  assert.match(loading, /WorkspaceRouteSkeleton|WorkspaceSkeleton/, "the shell loading state must use the workspace skeleton");

  const skeleton = await import("@/components/voom/workspace/WorkspaceSkeleton");
  const react = await import("react");
  const { renderToStaticMarkup } = await import("react-dom/server");
  const markup = renderToStaticMarkup(react.createElement(skeleton.default));
  assert.match(markup, /role="status"/, "loading UI must announce itself to assistive tech");
  assert.match(markup, /bg-surface-2/, "loading UI must use the Voom design tokens");
  // Placeholder geometry only — never invented product data.
  assert.doesNotMatch(markup, /followers|impressions|reached|scheduled|approved|AED|\d+K\b/i);
});

// ──────────────────────────────────────────────────────────────────────────
// 7. Navigation uses Next <Link> with prefetch — no hard page loads
// ──────────────────────────────────────────────────────────────────────────

test("sidebar and bottom bar navigate with prefetching Next links", async () => {
  const [sidebar, bottom, topbar] = await Promise.all([
    read("components/voom/shell/Sidebar.tsx"),
    read("components/voom/shell/BottomBar.tsx"),
    read("components/voom/shell/Topbar.tsx"),
  ]);
  for (const [name, source] of [["Sidebar", sidebar], ["BottomBar", bottom]]) {
    assert.match(source, /from "next\/link"/, `${name} must import next/link`);
    assert.match(source, /<Link\b/, `${name} destinations must render links`);
    assert.match(source, /prefetch/, `${name} links must prefetch`);
    assert.doesNotMatch(source, /window\.location\.(assign|href)|location\.replace/, `${name} must not hard-navigate`);
  }
  assert.doesNotMatch(topbar + sidebar + bottom, /window\.location\.(assign|href)/, "shell navigation must not hard-navigate");
});

test("workspace screens do not hard-reload to move between app routes", async () => {
  const pages = await Promise.all([
    read("app/app/(shell)/settings/page.tsx"),
    read("app/app/(shell)/today/page.tsx"),
    read("app/app/(shell)/plan/page.tsx"),
  ]);
  for (const source of pages) {
    assert.doesNotMatch(source, /window\.location\.(assign|href\s*=)|location\.replace\(/);
  }
});

// ──────────────────────────────────────────────────────────────────────────
// 8. Page compositions stay on the shared read path
// ──────────────────────────────────────────────────────────────────────────

test("Today derives from the one shared operating read", async () => {
  const page = await read("app/app/(shell)/today/page.tsx");
  assert.match(page, /getOperatingData/);
  assert.match(page, /await data\.performance/, "Today must consume the shared performance read");
  assert.doesNotMatch(page, /loadPerformanceReport/, "Today must not trigger a second performance read");
});

test("loadPerformanceReport itself stays parallel and dedupe-safe", async () => {
  const { trace } = await measure(async () => perfData.loadPerformanceReport(await createClient(), OWNER_A));
  assert.equal(trace.ops.length, 3, "the report's three reads changed shape unexpectedly");
  assert.ok(trace.criticalPathRtts <= 3);
  const snapshotOp = trace.ops.find((op) => op.label === "rest:instagram_performance_snapshots");
  const publishedOp = trace.ops.find((op) => op.label === "rest:instagram_publish_queue");
  assert.ok(overlaps(snapshotOp, publishedOp), "independent performance reads stopped overlapping");
});
