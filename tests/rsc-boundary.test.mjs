/**
 * RSC server/client boundary regression tests.
 *
 * Guards the failure class that 500'd the entire authenticated Preview:
 *
 *   Error: Attempted to call cx() from the server but cx is on the client.
 *          It's not possible to invoke a client function from the server.
 *
 * `components/voom/workspace/WorkspaceSkeleton.tsx` (server-rendered through
 * `app/app/(shell)/loading.tsx`) invoked `cx()` imported from the client
 * module `components/voom/ui/primitives`. Ordinary React render tests missed
 * it, because a plain renderer happily executes client modules on the server —
 * the Next.js RSC runtime does not: imports from a `"use client"` module are
 * client *references*, and invoking one from the server throws.
 *
 * Two complementary guards, because either one alone can rot:
 *
 *   1. RUNTIME SIMULATION — loads the REAL loading/skeleton modules through a
 *      module runtime that turns every `"use client"` module into Next-style
 *      throwing client references (the exact production error), then renders
 *      `app/app/(shell)/loading.tsx` for real. A positive control proves the
 *      simulator still reproduces the mechanism.
 *
 *   2. STATIC INVOCATION AUDIT — parses every non-client module under app/,
 *      components/ and lib/ with the TypeScript AST and fails on any CALL of
 *      an identifier imported (directly or through a re-export chain) from a
 *      `"use client"` module. JSX use of client components is legal RSC
 *      composition and is NOT flagged (jsx() takes them as arguments; the
 *      violation is calling them as helpers).
 *
 * The loading surface itself is held to the stricter contract: no value
 * imports from client modules at all — it must stay a fully server-rendered
 * boundary.
 */
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";

const ROOT = fileURLToPath(new URL("../", import.meta.url)).replace(/\/$/, "");
const LOADING_ENTRY = "@/app/app/(shell)/loading";
const SKELETON_FILE = path.join(ROOT, "components/voom/workspace/WorkspaceSkeleton.tsx");
const LOADING_FILE = path.join(ROOT, "app/app/(shell)/loading.tsx");

const CLIENT_ERROR = (name) =>
  `Attempted to call ${name}() from the server but ${name} is on the client. It's not possible to invoke a client function from the server.`;

/* ────────────────────────────────────────────────────────────────────────
   Shared module-graph helpers (resolution + "use client" detection)
   ──────────────────────────────────────────────────────────────────────── */

const RESOLUTION_SUFFIXES = ["", ".tsx", ".ts", ".jsx", ".js", "/index.tsx", "/index.ts", "/index.js"];

function resolveCandidate(base) {
  for (const suffix of RESOLUTION_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

function resolveSpecifier(specifier, fromFile) {
  let base = null;
  if (specifier.startsWith("@/")) base = path.join(ROOT, specifier.slice(2));
  else if ((specifier.startsWith("./") || specifier.startsWith("../")) && fromFile) {
    base = path.join(path.dirname(fromFile), specifier);
  }
  return base ? resolveCandidate(base) : null;
}

const sourceCache = new Map();
function sourceOf(file) {
  if (!sourceCache.has(file)) sourceCache.set(file, readFileSync(file, "utf8"));
  return sourceCache.get(file);
}

/** A module's runtime directive is its first statement, before any comments. */
function hasUseClientDirective(text) {
  const withoutComments = text.replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)+/, "");
  return /^["']use client["']/.test(withoutComments);
}

const clientModuleCache = new Map();
function isClientModule(file) {
  if (!clientModuleCache.has(file)) clientModuleCache.set(file, hasUseClientDirective(sourceOf(file)));
  return clientModuleCache.get(file);
}

function parseModule(file) {
  const text = sourceOf(file);
  const kind = file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true, kind);
}

function isTypeOnlySpecifier(spec) {
  return spec.isTypeOnly;
}

function moduleExportsNames(file, seen = new Set()) {
  if (seen.has(file)) return [];
  seen.add(file);
  const names = [];
  const source = parseModule(file);
  for (const statement of source.statements) {
    if (ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
        if (statement.name) names.push(statement.name.text);
      } else if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) {
          if (ts.isIdentifier(declaration.name)) names.push(declaration.name.text);
        }
      }
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) names.push(el.name.text);
      } else if (!statement.exportClause && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        // export * from "./m" — m's exports leak through.
        const target = resolveSpecifier(statement.moduleSpecifier.text, file);
        if (target) names.push(...moduleExportsNames(target, seen));
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) names.push("default");
  }
  return names;
}

/**
 * Is `name`, imported from `originFile`, ultimately backed by a `"use client"`
 * module? Walks re-export chains (`export { x } from`, `export * from`,
 * `import { x } … export { x }`).
 */
function bindingIsClientBacked(originFile, name, depth = 0) {
  if (!originFile || depth > 8) return false;
  if (isClientModule(originFile)) return true;
  const source = parseModule(originFile);
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && statement.importClause && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveSpecifier(statement.moduleSpecifier.text, originFile);
      const clause = statement.importClause;
      if (clause.isTypeOnly) continue;
      if (clause.name && name === "default" && target && bindingIsClientBacked(target, "default", depth + 1)) return true;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const el of clause.namedBindings.elements) {
          if (isTypeOnlySpecifier(el)) continue;
          if (el.name.text === name && target && bindingIsClientBacked(target, el.propertyName?.text ?? el.name.text, depth + 1)) return true;
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const target = resolveSpecifier(statement.moduleSpecifier.text, originFile);
      if (!target) continue;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const el of statement.exportClause.elements) {
          if (el.name.text === name) {
            if (bindingIsClientBacked(target, el.propertyName?.text ?? el.name.text, depth + 1)) return true;
          }
        }
      } else if (!statement.exportClause) {
        if (bindingIsClientBacked(target, name, depth + 1)) return true;
      }
    }
    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const el of statement.exportClause.elements) {
        if (el.name.text !== name) continue;
        const local = el.propertyName?.text ?? el.name.text;
        // Local re-export: the local binding may itself be an import.
        for (const other of source.statements) {
          if (ts.isImportDeclaration(other) && ts.isStringLiteral(other.moduleSpecifier) && other.importClause && !other.importClause.isTypeOnly) {
            const target = resolveSpecifier(other.moduleSpecifier.text, originFile);
            const bindings = other.importClause.namedBindings;
            if (bindings && ts.isNamedImports(bindings)) {
              for (const el2 of bindings.elements) {
                if (isTypeOnlySpecifier(el2)) continue;
                if (el2.name.text === local && target && bindingIsClientBacked(target, el2.propertyName?.text ?? el2.name.text, depth + 1)) return true;
              }
            }
          }
        }
      }
    }
  }
  return false;
}

/* ────────────────────────────────────────────────────────────────────────
   Layer 2 — RSC client-reference runtime (reproduces the production error)
   ──────────────────────────────────────────────────────────────────────── */

const MODULE_DOUBLES = {
  "server-only": "data:text/javascript,export{}",
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
  "next/image": `data:text/javascript,${encodeURIComponent(`
    export default function Image() { return null; }
  `)}`,
};

/** Emits a module of throwing client references — Next's server-side view of
 *  a `"use client"` module: every export is a client reference that refuses
 *  to be invoked from the server with the exact production error. */
function clientReferenceModule(file) {
  const names = [...new Set(moduleExportsNames(file))];
  const lines = [
    "function __clientRef(name) {",
    "  return function clientReference() {",
    "    throw new Error(`Attempted to call ${name}() from the server but ${name} is on the client. It's not possible to invoke a client function from the server.`);",
    "  };",
    "}",
  ];
  for (const name of names) {
    if (name === "default") lines.push("export default __clientRef('default');");
    else lines.push(`export const ${name} = __clientRef(${JSON.stringify(name)});`);
  }
  if (!names.includes("default")) lines.push("export default __clientRef('default');");
  return lines.join("\n");
}

let rscRuntimeInstalled = false;
function installRscRuntime() {
  if (rscRuntimeInstalled) return;
  rscRuntimeInstalled = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const doubled = MODULE_DOUBLES[specifier];
      if (doubled) return { url: doubled, shortCircuit: true };
      const fromFile = context.parentURL?.startsWith("file:") ? fileURLToPath(context.parentURL.split("?")[0]) : null;
      const resolved = resolveSpecifier(specifier, fromFile);
      if (resolved) return { url: pathToFileURL(resolved).href, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url.startsWith("file:") && url.endsWith(".css")) return { format: "module", source: "export{}", shortCircuit: true };
      if (url.startsWith("file:") && /\.(tsx|ts)$/.test(url)) {
        const file = fileURLToPath(url);
        const raw = readFileSync(file, "utf8");
        if (hasUseClientDirective(raw)) {
          // The RSC boundary: client modules become client *references* —
          // their code never runs on the server and calling their exports
          // throws exactly like the Next.js server runtime.
          return { format: "module", source: clientReferenceModule(file), shortCircuit: true };
        }
        const { outputText } = ts.transpileModule(raw, {
          fileName: file,
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

/* ────────────────────────────────────────────────────────────────────────
   Layer 1 — static invocation audit
   ──────────────────────────────────────────────────────────────────────── */

function collectSourceFiles(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collectSourceFiles(full, out);
    else if (/\.tsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Returns violations: server modules that CALL a client-backed binding. */
function auditServerModulesForClientHelperCalls() {
  const violations = [];
  const roots = ["app", "components", "lib"].map((d) => path.join(ROOT, d));
  for (const root of roots) {
    for (const file of collectSourceFiles(root)) {
      if (isClientModule(file)) continue;
      const source = parseModule(file);
      /** localName → true when the binding is client-backed */
      const clientBindings = new Map();
      const namespaceBindings = new Map();
      for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
        const clause = statement.importClause;
        if (!clause || clause.isTypeOnly) continue;
        const target = resolveSpecifier(statement.moduleSpecifier.text, file);
        if (clause.name && target && bindingIsClientBacked(target, "default")) {
          clientBindings.set(clause.name.text, "default");
        }
        if (clause.namedBindings) {
          if (ts.isNamedImports(clause.namedBindings)) {
            for (const el of clause.namedBindings.elements) {
              if (el.isTypeOnly) continue;
              const imported = el.propertyName?.text ?? el.name.text;
              if (target && bindingIsClientBacked(target, imported)) clientBindings.set(el.name.text, imported);
            }
          } else if (ts.isNamespaceImport(clause.namedBindings)) {
            if (target && isClientModule(target)) namespaceBindings.set(clause.namedBindings.name.text, target);
          }
        }
      }
      const checkCallee = (callee, node) => {
        if (ts.isIdentifier(callee) && clientBindings.has(callee.text)) {
          const imported = clientBindings.get(callee.text);
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${path.relative(ROOT, file)}:${line + 1} calls \`${callee.text}()\` imported from a "use client" module (${imported})`);
          return;
        }
        if (
          ts.isPropertyAccessExpression(callee) &&
          ts.isIdentifier(callee.expression) &&
          namespaceBindings.has(callee.expression.text)
        ) {
          const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
          violations.push(`${path.relative(ROOT, file)}:${line + 1} calls \`${callee.expression.text}.${callee.name.text}()\` imported from a "use client" module`);
        }
      };
      const visit = (node) => {
        if (ts.isCallExpression(node)) checkCallee(node.expression, node);
        else if (ts.isNewExpression(node) && node.expression) checkCallee(node.expression, node);
        else if (ts.isTaggedTemplateExpression(node)) checkCallee(node.tag, node);
        ts.forEachChild(node, visit);
      };
      ts.forEachChild(source, visit);
    }
  }
  return violations;
}

/** Value (non-type) imports of `file` that come from `"use client"` modules. */
function valueImportsFromClientModules(file) {
  const hits = [];
  const source = parseModule(file);
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const clause = statement.importClause;
    if (!clause || clause.isTypeOnly) continue;
    const target = resolveSpecifier(statement.moduleSpecifier.text, file);
    if (!target || !isClientModule(target)) continue;
    hits.push({ specifier: statement.moduleSpecifier.text, target: path.relative(ROOT, target) });
  }
  return hits;
}

/* ────────────────────────────────────────────────────────────────────────
   Tests
   ──────────────────────────────────────────────────────────────────────── */

test("RSC simulator reproduces the production client-reference failure mechanism", async () => {
  installRscRuntime();
  // Positive control: the client module primitives DOES export cx; through
  // the RSC boundary it must throw the exact production error when invoked.
  const primitives = await import("@/components/voom/ui/primitives");
  assert.throws(
    () => primitives.cx("a", "b"),
    (error) => {
      assert.equal(error.message, CLIENT_ERROR("cx"));
      return true;
    },
    "the simulator must reproduce the Next.js client-reference error exactly",
  );
});

test("shell loading.tsx renders through the RSC boundary without invoking client helpers", async () => {
  installRscRuntime();
  const loading = await import(LOADING_ENTRY);
  // This is the exact composition every (shell) route streams on navigation.
  // Before the fix this threw `Attempted to call cx() from the server…` here.
  const markup = renderToStaticMarkup(createElement(loading.default));
  assert.match(markup, /role="status"/);
  assert.match(markup, /aria-busy="true"/);
  assert.match(markup, /bg-surface-2/);
  assert.match(markup, /Loading workspace/);
});

test("every WorkspaceSkeleton export renders through the RSC boundary", async () => {
  installRscRuntime();
  const skeleton = await import("@/components/voom/workspace/WorkspaceSkeleton");
  for (const Component of [skeleton.WorkspaceSkeleton, skeleton.WorkspaceHeaderSkeleton, skeleton.WorkspacePanelSkeleton, skeleton.default]) {
    const markup = renderToStaticMarkup(createElement(Component));
    assert.ok(markup.length > 0, "skeleton parts must render real geometry");
    assert.doesNotMatch(markup, /followers|impressions|reached|scheduled|approved|AED|\d+K\b/i, "skeleton must never invent product data");
  }
});

test("the PR #70 loading surface has zero value imports from client modules", () => {
  for (const [name, file] of [["app/app/(shell)/loading.tsx", LOADING_FILE], ["components/voom/workspace/WorkspaceSkeleton.tsx", SKELETON_FILE]]) {
    assert.ok(existsSync(file), `${name} must exist`);
    assert.equal(hasUseClientDirective(sourceOf(file)), false, `${name} must stay server-rendered (do not mark it "use client")`);
    const clientImports = valueImportsFromClientModules(file);
    assert.deepEqual(clientImports, [], `${name} must not import from client modules (server-safe helpers live in lib/voom/cx)`);
  }
});

test("WorkspaceSkeleton composes classes through the server-safe cx helper", () => {
  const source = sourceOf(SKELETON_FILE);
  assert.match(source, /import \{ cx \} from "@\/lib\/voom\/cx"/, "use the established server-safe pattern from workspace/ui.tsx and TodayDashboard");
});

test("repo-wide: server modules never call helpers imported from client modules", () => {
  const violations = auditServerModulesForClientHelperCalls();
  assert.deepEqual(
    violations,
    [],
    `server code invoked client-module helpers (the RSC client-proxy failure class):\n  ${violations.join("\n  ")}`,
  );
});
