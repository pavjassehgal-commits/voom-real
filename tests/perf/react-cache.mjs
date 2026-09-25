/**
 * Test-runtime stand-in for the `react` module on the server data path.
 *
 * Only `cache` is imported by Voom's server modules; the real client build of
 * React exports `cache` as a pass-through outside a render, which would hide
 * request-memoization behaviour from the harness. This module re-exports the
 * real React surface (by relative path, so the `react` alias never re-enters
 * this file) and replaces `cache` with the request-scoped model in
 * `request-scope.mjs`, matching Next.js runtime semantics.
 */
export * from "../../node_modules/react/index.js";
export { requestCache as cache } from "./request-scope.mjs";
