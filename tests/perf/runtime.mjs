/**
 * Module runtime for the navigation performance harness.
 *
 * Registers Node resolve/load hooks that let bare Node import the REAL Voom
 * server modules (TypeScript, `@/` aliases, `server-only`) exactly like
 * `tests/helpers/rendered-surface.mjs` does — and additionally aliases:
 *
 *   - `@/utils/supabase/server` → instrumented session client
 *   - `@/utils/supabase/admin`  → instrumented service client
 *   - `react`                   → real React + request-scoped `cache()` model
 *
 * so the real call graph runs against the traced, latency-injected store and
 * Next.js request memoization semantics are preserved.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const PERF = path.join(ROOT, "tests/perf");

const MODULE_DOUBLES = {
  "server-only": "data:text/javascript,export{}",
  "react": pathToFileURL(path.join(PERF, "react-cache.mjs")).href,
  "@/utils/supabase/server": pathToFileURL(path.join(PERF, "alias/supabase-server.mjs")).href,
  "@/utils/supabase/admin": pathToFileURL(path.join(PERF, "alias/supabase-admin.mjs")).href,
  "next/navigation": `data:text/javascript,${encodeURIComponent(`
    export const usePathname = () => "/app/today";
    export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} });
    export const useSearchParams = () => new URLSearchParams();
    export function redirect() {}
    export function notFound() { throw new Error("notFound"); }
  `)}`,
  "next/cache": `data:text/javascript,${encodeURIComponent(`
    export function revalidatePath() {}
    export function revalidateTag() {}
    export function unstable_cache(fn) { return fn; }
    export function unstable_noStore() {}
  `)}`,
  "next/headers": `data:text/javascript,${encodeURIComponent(`
    export async function cookies() { return { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }; }
    export async function headers() { return new Headers(); }
  `)}`,
  "next/link": `data:text/javascript,${encodeURIComponent(`
    import { createElement } from "react";
    export default function Link({ href, children, ...rest }) { return createElement("a", { href, ...rest }, children); }
  `)}`,
};

const RESOLUTION_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".json", "/index.tsx", "/index.ts", "/index.js"];

function resolveCandidate(base) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

let registered = false;

export function installRuntime() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const doubled = MODULE_DOUBLES[specifier];
      if (doubled) return { url: doubled, shortCircuit: true };
      let base = null;
      if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2));
      else if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL?.startsWith("file:")) {
        base = path.join(path.dirname(fileURLToPath(context.parentURL)), specifier);
      } else if (specifier.startsWith("file:")) base = fileURLToPath(specifier.split("?")[0]);
      if (base) {
        const resolved = resolveCandidate(base);
        if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export{}", shortCircuit: true };
      if (url.startsWith("file:") && /\.(tsx|ts)$/.test(url)) {
        const { outputText } = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), {
          fileName: fileURLToPath(url),
          compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
            esModuleInterop: true,
            skipLibCheck: true,
          },
        });
        return { format: "module", source: outputText, shortCircuit: true };
      }
      return nextLoad(url, context);
    },
  });
}
