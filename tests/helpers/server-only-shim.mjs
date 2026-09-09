/**
 * Test-only resolver shim for Next-specific module specifiers.
 *
 * Voom's server modules start with `import "server-only"` and use the `@/`
 * path alias, which Next resolves during bundling but bare Node cannot. That
 * is why most existing suites assert on source text rather than importing
 * these modules.
 *
 * Security- and correctness-critical logic deserves REAL behavioural tests,
 * not string matching, so this registers resolve hooks that map `server-only`
 * to an empty module and `@/<path>` to the repository's own files. It affects
 * the test process only — nothing in the shipped app imports this file.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { registerHooks } from "node:module";

const EMPTY = "data:text/javascript,export{}";
const ROOT = new URL("../../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") return { url: EMPTY, shortCircuit: true };
    if (specifier.startsWith("@/")) {
      // All @/ imports in this codebase are extensionless .ts files.
      const withTs = new URL(`${specifier.replace(/^@\//, "")}.ts`, ROOT);
      if (existsSync(fileURLToPath(withTs))) return { url: withTs.href, shortCircuit: true };
      return { url: new URL(specifier.replace(/^@\//, ""), ROOT).href, shortCircuit: true };
    }
    // Extensionless relative imports (./video-job) also need the .ts suffix.
    if ((specifier.startsWith("./") || specifier.startsWith("../")) && !/\.[a-z]+$/.test(specifier) && context.parentURL) {
      const withTs = new URL(`${specifier}.ts`, context.parentURL);
      if (existsSync(fileURLToPath(withTs))) return { url: withTs.href, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
