/**
 * Per-scenario context for the instrumented Supabase doubles. The aliased
 * `@/utils/supabase/server` / `@/utils/supabase/admin` modules (see runtime.mjs)
 * hand out these clients, so the REAL application modules run against the
 * traced, latency-injected store.
 */
import { createFakeClients, Trace } from "./fake-supabase.mjs";
import { seedStore, OWNER_A } from "./seed.mjs";

let current = null;

export function beginScenario({ rttMs = 120, now = new Date(), claims, store } = {}) {
  const trace = new Trace({ rttMs });
  const resolvedClaims = claims ?? { sub: OWNER_A, email: "perf@example.com" };
  const resolvedStore = store ?? seedStore(now);
  current = {
    trace,
    store: resolvedStore,
    now,
    claims: resolvedClaims,
    ...createFakeClients({ store: resolvedStore, trace, claims: resolvedClaims }),
  };
  return current;
}

export function scenario() {
  if (!current) throw new Error("perf harness: call beginScenario() first");
  return current;
}

export function endScenario() {
  const finished = current;
  current = null;
  return finished;
}
