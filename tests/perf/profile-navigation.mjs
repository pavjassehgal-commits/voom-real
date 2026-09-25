/**
 * VOOM navigation data-path profiler — BEFORE/AFTER measurement instrument.
 *
 * Runs the REAL server modules of every authenticated navigation (shell
 * layouts + Today/Plan pages + getOperatingData + workflow snapshot +
 * coordinator + performance + readiness) against an instrumented Supabase
 * double with realistic seeded rows and a configurable per-round-trip latency,
 * inside a faithful model of Next.js request semantics (per-request `cache()`
 * memoization via tests/perf/request-scope.mjs).
 *
 * Every fetch is traced with start/end timestamps, so the output shows the
 * request's true data waterfall: total round trips, duplicated reads, the
 * sequential critical path and how much of the work actually overlaps.
 *
 * Usage:
 *   node tests/perf/profile-navigation.mjs            # RTT profiles 25/120/300ms
 *   node tests/perf/profile-navigation.mjs --rtt 120  # one profile only
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { installRuntime } from "./runtime.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");

installRuntime();

// REAL application modules — imported after the hooks are in place.
const [
  { runInRequestScope },
  { beginScenario, scenario, endScenario },
  { OWNER_A },
  serverData,
  operatingData,
  workflowRead,
  coordService,
  perfData,
  readinessLib,
  todayView,
] = await Promise.all([
  import("./request-scope.mjs"),
  import("./fake-context.mjs"),
  import("./seed.mjs"),
  import("@/lib/voom/server-data"),
  import("@/lib/voom/operating-data"),
  import("@/lib/voom/workflow/read"),
  import("@/lib/coordinator/service"),
  import("@/lib/performance/data"),
  import("@/lib/social/readiness"),
  import("@/lib/voom/today-view"),
]);

/* Page compositions mirror the real page files, with tiny feature detection so
 * the SAME runner measures both the pre-optimization and post-optimization
 * code faithfully (the page files themselves are the source of truth). */
const todayPageSrc = readFileSync(path.join(ROOT, "app/app/(shell)/today/page.tsx"), "utf8");
const planPageSrc = readFileSync(path.join(ROOT, "app/app/(shell)/plan/page.tsx"), "utf8");
const TODAY_USES_SHARED_PERFORMANCE = /data\.performance/.test(todayPageSrc);
const PLAN_PARALLEL = /Promise\.all\(/.test(planPageSrc);

const sessionClient = () => scenario().session;

async function proxyChain() {
  // proxy.ts updateSession → supabase.auth.getClaims()
  await sessionClient().auth.getClaims();
}

async function appLayoutChain() {
  // app/app/layout.tsx
  await sessionClient().auth.getClaims();
  await Promise.all([serverData.getProfileRecord(), serverData.getBusinessRecord()]);
}

async function shellLayoutChain() {
  // app/app/(shell)/layout.tsx
  await serverData.getBusinessRecord();
}

async function todayPageChain() {
  const data = await operatingData.getOperatingData();
  if (!data) return null;
  const { buildTodayView } = todayView;
  const view = buildTodayView(data.snapshot, data.summary, data.coordinator);
  const performance = TODAY_USES_SHARED_PERFORMANCE && data.performance
    ? data.performance
    : await perfData.loadPerformanceReport(sessionClient(), data.user.id);
  return { items: data.snapshot.items.length, view, performance };
}

async function planReadiness() {
  const user = await serverData.getCurrentUser();
  if (!user) return null;
  return readinessLib.readSocialChannelReadiness(scenario().admin, user.id);
}

async function planPageChain() {
  if (PLAN_PARALLEL) {
    const [data, readiness] = await Promise.all([operatingData.getOperatingData(), planReadiness()]);
    return data ? { items: data.snapshot.items.length, readiness } : null;
  }
  const data = await operatingData.getOperatingData();
  if (!data) return null;
  const readiness = await planReadiness();
  return { items: data.snapshot.items.length, readiness };
}

async function run(name, fn, { rttMs, now }) {
  beginScenario({ rttMs, now, claims: { sub: OWNER_A, email: "perf@example.com" } });
  const t0 = performance.now();
  const result = await runInRequestScope(fn);
  const wall = performance.now() - t0;
  const finished = endScenario();
  return { name, wall, trace: finished.trace, result };
}

function report(entry, { timeline = false } = {}) {
  const { name, wall, trace, result } = entry;
  const signOps = trace.ops.filter((op) => op.label.startsWith("storage.sign")).reduce((sum, op) => sum + Number(/(\d+) path/.exec(op.detail)?.[1] ?? 1), 0);
  console.log(`\n== ${name} ==`);
  console.log(`  wall: ${wall.toFixed(0)}ms   round trips: ${trace.ops.length}   effective critical-path RTTs: ${trace.criticalPathRtts.toFixed(1)}   max concurrency: ${trace.maxConcurrency}`);
  console.log(`  storage sign calls: ${trace.ops.filter((op) => op.label.startsWith("storage.sign")).length} (paths signed: ${signOps})`);
  const dupes = trace.duplicates();
  console.log(`  reads by table: ${JSON.stringify(trace.counts())}`);
  if (dupes.length) console.log(`  DUPLICATE reads in one request: ${dupes.join(", ")}`);
  if (result?.items !== undefined) console.log(`  snapshot items surfaced: ${result.items}`);
  if (timeline) {
    console.log(`  timeline:`);
    console.log(trace.timeline(48));
  }
}

const args = process.argv.slice(2);
const rttArg = args.includes("--rtt") ? Number(args[args.indexOf("--rtt") + 1]) : null;
const RTTS = rttArg ? [rttArg] : [25, 120, 300];
const SHOW_TIMELINE_AT = 120;

console.log("VOOM navigation data-path profile");
console.log(`page composition detected: today ${TODAY_USES_SHARED_PERFORMANCE ? "uses shared getOperatingData().performance" : "loads loadPerformanceReport() after getOperatingData()"}, plan ${PLAN_PARALLEL ? "parallel (Promise.all)" : "sequential"}`);
console.log(`simulated round-trip latencies: ${RTTS.map((r) => `${r}ms`).join(", ")} (Supabase REST + storage + auth)`);
console.log("note: module boot / Vercel function cold-start / TLS setup are NOT included in these numbers.");

const SCENARIOS = [
  ["cold direct request → /app/today", async () => { await proxyChain(); await appLayoutChain(); await shellLayoutChain(); return todayPageChain(); }],
  ["warm direct request → /app/today", async () => { await proxyChain(); await appLayoutChain(); await shellLayoutChain(); return todayPageChain(); }],
  ["client navigation Plan → Today (RSC)", async () => { await proxyChain(); await appLayoutChain(); await shellLayoutChain(); return todayPageChain(); }],
  ["client navigation Today → Plan (RSC)", async () => { await proxyChain(); await appLayoutChain(); await shellLayoutChain(); return planPageChain(); }],
  ["shell/layout data only (proxy+layouts)", async () => { await proxyChain(); await appLayoutChain(); await shellLayoutChain(); }],
  ["page server data only → Today", async () => todayPageChain()],
  ["page server data only → Plan", async () => planPageChain()],
  ["getOperatingData() alone", async () => { const data = await operatingData.getOperatingData(); return data ? { items: data.snapshot.items.length } : null; }],
  ["loadWorkflowSnapshot() alone", async () => { const snap = await workflowRead.loadWorkflowSnapshot(scenario().admin, OWNER_A); return { items: snap.items.length }; }],
  ["runCoordinatorForOwner(ui_read) alone", async () => { const res = await coordService.runCoordinatorForOwner(scenario().admin, OWNER_A, "biz-1", { trigger: "ui_read" }); return { gaps: res.evaluation.gaps.length }; }],
  ["loadPerformanceReport() alone", async () => perfData.loadPerformanceReport(sessionClient(), OWNER_A)],
  ["readSocialChannelReadiness() alone", async () => readinessLib.readSocialChannelReadiness(scenario().admin, OWNER_A)],
];

// Warm the module graph so "cold" measures the first request, not import cost.
await run("module warmup", () => SCENARIOS[0][1](), { rttMs: 1, now: new Date() });

const summary = [];
for (const rttMs of RTTS) {
  const now = new Date();
  console.log(`\n${"=".repeat(72)}\nROUND-TRIP LATENCY ${rttMs}ms\n${"=".repeat(72)}`);
  for (const [name, fn] of SCENARIOS) {
    const entry = await run(name, fn, { rttMs, now });
    report(entry, { timeline: rttMs === SHOW_TIMELINE_AT && (name.startsWith("client navigation Plan") || name.startsWith("cold") || name === "getOperatingData() alone") });
    summary.push({ rttMs, name, wall: entry.wall, ops: entry.trace.ops.length, critical: entry.trace.criticalPathRtts, maxConc: entry.trace.maxConcurrency, dupes: entry.trace.duplicates().join(" ") });
  }
}

console.log(`\n${"=".repeat(72)}\nSUMMARY (wall ms at simulated round-trip latency)\n${"=".repeat(72)}`);
const names = [...new Set(summary.map((row) => row.name))];
console.log(`scenario${" ".repeat(44)}${RTTS.map((r) => `${String(r) + "ms".padEnd(6)}`).join("")}  ops  critRTT`);
for (const name of names) {
  const rows = summary.filter((row) => row.name === name);
  const cells = RTTS.map((rtt) => `${(rows.find((row) => row.rttMs === rtt)?.wall ?? 0).toFixed(0)}ms`.padEnd(8)).join("");
  const ops = rows[0].ops;
  const crit = rows[0].critical.toFixed(1);
  console.log(`${name.padEnd(48)}${cells}${String(ops).padEnd(5)}${crit}`);
}
