import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("toasts carry their own surface and text colour, so they never inherit an unreadable pairing", async () => {
  const [host, css] = await Promise.all([read("components/voom/ui/ToastHost.tsx"), read("app/globals.css")]);
  // The host sits outside .voom-shell/.voom-public: no global surface/text utilities.
  assert.doesNotMatch(host, /bg-surface|text-text|border-line/, "no legacy global tokens on the toast");
  assert.match(css, /\.voom-toast \{[\s\S]*?background: var\(--toast-bg\);[\s\S]*?color: var\(--toast-text\);/);
  for (const kind of ["ok", "err", "warn", "info"]) assert.match(css, new RegExp(`\\.voom-toast--${kind} \\{`), `${kind} is styled`);
  // Dark only in the dark workspace; the setup/public screens are light-only.
  assert.match(css, /:root\[data-theme="dark"\] body:not\(:has\(\.voom-public\)\) \.voom-toast-host \{/);
});

test("toasts keep essential buttons clear and are announced", async () => {
  const [host, css, wizard] = await Promise.all([read("components/voom/ui/ToastHost.tsx"), read("app/globals.css"), read("components/voom/onboarding/OnboardingWizard.tsx")]);
  assert.match(wizard, /<footer data-toast-clearance/, "setup's Back / Continue footer opts in to clearance");
  assert.match(css, /body:has\(\[data-toast-clearance\]\) \.voom-toast-host \{ bottom: calc\(86px/);
  assert.match(css, /body:has\(\.voom-shell\) \.voom-toast-host \{ bottom: calc\(80px/, "above the 68px mobile bottom bar");
  assert.match(host, /aria-live="polite"/);
  assert.match(host, /role=\{t\.kind === "err" \? "alert" : "status"\}/);
});
