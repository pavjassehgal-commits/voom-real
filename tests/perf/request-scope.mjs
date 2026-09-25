/**
 * Request-scope model for the performance harness.
 *
 * Next.js runs every request (RSC render, route handler) inside its own React
 * request cache scope: `cache()` from "react" memoizes per request — including
 * in-flight promises — and NEVER shares entries across requests. In bare Node
 * the client build of `react` exports `cache` as a pass-through, so this module
 * models the Next.js runtime semantics faithfully:
 *
 *   - inside `runInRequestScope(fn)` calls with equal arguments are memoized;
 *   - outside a request scope nothing is memoized (pass-through);
 *   - scopes are isolated: no entry can ever leak into another scope, which is
 *     what keeps cached authenticated reads owner-safe in production.
 *
 * The harness aliases the `react` module to `tests/perf/react-cache.mjs`
 * (a thin re-export built on this) so the REAL application modules exercise
 * the same memoization behaviour they have under Next.js.
 */
import { AsyncLocalStorage } from "node:async_hooks";

const SCOPE = new AsyncLocalStorage();
const RESULT = Symbol("request-cache-result");

/** Runs `fn` inside a fresh request cache scope (one Next.js request). */
export function runInRequestScope(fn) {
  return SCOPE.run(new Map(), fn);
}

/** True when called inside `runInRequestScope`. */
export function inRequestScope() {
  return SCOPE.getStore() !== undefined;
}

/**
 * Models React `cache()`: per-request memoization keyed by function identity
 * and argument identity (exactly like React's implementation). Concurrent
 * calls with the same keys share one in-flight promise.
 */
export function requestCache(fn) {
  return function cached(...args) {
    const store = SCOPE.getStore();
    if (!store) return fn.apply(null, args);
    let node = store;
    for (const arg of [fn, ...args]) {
      if (!node.has(arg)) node.set(arg, new Map());
      node = node.get(arg);
    }
    if (!node.has(RESULT)) {
      // Cache the in-flight promise so parallel callers deduplicate too.
      node.set(RESULT, Promise.resolve().then(() => fn.apply(null, args)));
    }
    return node.get(RESULT);
  };
}
