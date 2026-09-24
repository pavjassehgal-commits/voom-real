/**
 * Client bundle for the rendered-surface harness.
 *
 * To prove hydration behaviour (BLOCKER 3) the browser needs the app's real
 * client code. The repository intentionally has no bundler dependency for
 * tests, so this walks the REAL module graph — the same resolution rules the
 * harness runtime uses — transpiles the TypeScript with the project's own
 * compiler and emits one self-executing CommonJS bundle (React included from
 * node_modules). Nothing is written to disk and nothing ships to production.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

const ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const nodeRequire = createRequire(pathToFileURL(path.join(ROOT, "package.json")));

const STUBS = {
  "server-only": "module.exports = {};",
  "next/navigation": `
    export const usePathname = () => window.location.pathname;
    export const useRouter = () => ({ push() {}, replace() {}, refresh() {}, prefetch() {}, back() {} });
    export const useSearchParams = () => new URLSearchParams(window.location.search);
    export function redirect() {}
    export function notFound() { throw new Error("notFound"); }
  `,
  "next/cache": `
    export function revalidatePath() {}
    export function revalidateTag() {}
    export function unstable_cache(fn) { return fn; }
    export function unstable_noStore() {}
  `,
  "next/headers": `
    export async function cookies() { return { get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }; }
    export async function headers() { return new Headers(); }
    export async function draftMode() { return { isEnabled: false, enable() {}, disable() {} }; }
  `,
  "next/link": `
    import { createElement } from "react";
    export default function Link({ href, children, prefetch, replace, scroll, shallow, locale, legacyBehavior, passHref, ...rest }) {
      return createElement("a", { href, ...rest }, children);
    }
  `,
};

const SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", "/index.tsx", "/index.ts", "/index.js"];

function resolveFile(base) {
  for (const suffix of SUFFIXES) {
    const candidate = `${base}${suffix}`;
    try {
      if (readFileSync(candidate)) return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

function transpile(file) {
  const source = readFileSync(file, "utf8");
  if (/\.json$/.test(file)) return `module.exports = ${source};`;
  if (file.startsWith(path.join(ROOT, "node_modules"))) return source; // already CommonJS
  const { outputText } = ts.transpileModule(source, {
    fileName: file,
    compilerOptions: {
      jsx: ts.JsxEmit.ReactJSX,
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });
  return outputText;
}

const REQUIRE_PATTERN = /require\(\s*(["'])([^"']+)\1\s*\)/g;

/**
 * Bundles the module graph reachable from `entrySource`, which is compiled as a
 * module at the repository root (so `@/…` and `./…` both resolve).
 */
export function buildClientBundle(entrySource) {
  const modules = new Map(); // id -> { source, dependencies: Map<specifier, id> }

  function add(id, file, importerDirectory) {
    if (modules.has(id)) return modules.get(id);
    const record = { id, source: transpile(file), dependencies: new Map(), directory: importerDirectory };
    modules.set(id, record);
    // Requires are read from the COMMONJS the module will actually execute.
    for (const match of record.source.matchAll(REQUIRE_PATTERN)) {
      const specifier = match[2];
      const resolved = resolveModule(specifier, importerDirectory);
      if (!resolved) throw new Error(`client bundle cannot resolve "${specifier}" from ${id}`);
      record.dependencies.set(specifier, resolved.id);
    }
    return record;
  }

  function resolveModule(specifier, importerDirectory) {
    const stub = STUBS[specifier];
    if (stub) {
      const id = `stub:${specifier}`;
      const record = { id, source: stub, dependencies: new Map(), directory: importerDirectory, stub: true };
      if (!modules.has(id)) {
        modules.set(id, record);
        const transpiled = ts.transpileModule(stub, {
          compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
        }).outputText;
        record.source = transpiled;
        for (const match of transpiled.matchAll(REQUIRE_PATTERN)) {
          const nested = resolveModule(match[2], importerDirectory);
          if (nested) record.dependencies.set(match[2], nested.id);
        }
      }
      return record;
    }
    if (/\.(css|png|jpg|jpeg|svg|webp|gif)$/.test(specifier)) {
      const id = "asset:empty";
      if (!modules.has(id)) modules.set(id, { id, source: "module.exports = {};", dependencies: new Map(), directory: importerDirectory });
      return modules.get(id);
    }
    let file = null;
    if (specifier.startsWith("@/")) file = resolveFile(path.join(ROOT, specifier.slice(2)));
    else if (specifier.startsWith(".")) file = resolveFile(path.resolve(importerDirectory, specifier));
    else {
      try {
        file = nodeRequire.resolve(specifier, { paths: [ROOT] });
      } catch {
        file = null;
      }
      if (!file && specifier.startsWith("next/")) file = null;
    }
    if (!file) return null;
    const record = add(file, file, path.dirname(file));
    return record;
  }

  const entryId = path.join(ROOT, "__voom_test_entry__.tsx");
  modules.set(entryId, { id: entryId, source: null, dependencies: new Map(), directory: ROOT });
  const entryTranspiled = ts.transpileModule(entrySource, {
    fileName: entryId,
    compilerOptions: { jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
  }).outputText;
  const entry = modules.get(entryId);
  entry.source = entryTranspiled;
  for (const match of entryTranspiled.matchAll(REQUIRE_PATTERN)) {
    const resolved = resolveModule(match[2], ROOT);
    if (!resolved) throw new Error(`client bundle cannot resolve entry dependency "${match[2]}"`);
    entry.dependencies.set(match[2], resolved.id);
  }

  const table = [...modules.values()].map(
    (record) => `${JSON.stringify(record.id)}: [function(module, exports, require){\n${record.source}\n}, ${JSON.stringify(Object.fromEntries(record.dependencies))}]`,
  );
  return `(function(){
  window.process = window.process || { env: { NODE_ENV: "development" }, platform: "browser", version: "" };
  var defs = { ${table.join(",\n")} };
  var cache = {};
  function load(id) {
    if (cache[id]) return cache[id].exports;
    var definition = defs[id];
    if (!definition) throw new Error("module not bundled: " + id);
    var module = cache[id] = { exports: {} };
    definition[0](module, module.exports, function(specifier) {
      var target = definition[1][specifier];
      if (!target) throw new Error("unresolved import '" + specifier + "' from " + id);
      return load(target);
    });
    return module.exports;
  }
  window.__voomBundleEntry = ${JSON.stringify(entryId)};
  load(${JSON.stringify(entryId)});
})();`;
}
