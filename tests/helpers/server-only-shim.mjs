/**
 * Test-only resolver shim for the `server-only` package.
 *
 * Voom's server modules start with `import "server-only"`, which Next resolves
 * during bundling but bare Node cannot. That is why most existing suites assert
 * on source text rather than importing these modules.
 *
 * Security-critical crypto deserves REAL behavioural tests, not string
 * matching, so this registers a resolve hook that maps `server-only` to an
 * empty module. It affects the test process only — nothing in the shipped app
 * imports this file.
 */
import { registerHooks } from "node:module";

const EMPTY = "data:text/javascript,export{}";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
