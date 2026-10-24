import assert from "node:assert/strict";
import test from "node:test";
import { readFile, stat } from "node:fs/promises";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("homepage hero serves the original artwork unre-encoded and never stretched", async () => {
  const page = await read("app/page.tsx");
  assert.match(page, /src="\/redesign\/landing-hero\.jpg"/);
  assert.match(page, /\bunoptimized\b/, "Next must not re-encode the already-compressed original");
  assert.match(page, /max-w-\[1012px\]/, "framed, not full-bleed: ≥1.5 source px per CSS px");
  const { size } = await stat(new URL("../public/redesign/landing-hero.jpg", import.meta.url));
  assert.equal(size, 85944, "the exact bytes exported from the Figma file");
});

test("homepage motion is CSS-only, layout-safe and removed for reduced motion", async () => {
  const [page, css] = await Promise.all([read("app/page.tsx"), read("app/globals.css")]);
  assert.doesNotMatch(page, /"use client"/, "a server component: content renders without JavaScript");
  const block = css.slice(css.indexOf("Homepage (app/page.tsx)"));
  const frames = [...block.matchAll(/@keyframes voom-home-[\w-]+ \{([^@]*?)\}\s*\}?/g)].map((m) => m[1]).join(" ");
  assert.doesNotMatch(frames, /\b(width|height|top|left|margin|padding)\s*:/, "only opacity / transform / scale / background animate");
  assert.match(block, /@media \(prefers-reduced-motion: reduce\) \{[\s\S]*?\.voom-home-in, \.voom-home-hero-img \{ animation: none !important; \}/);
  for (const href of ["/login", "/signup", "/privacy", "/terms", "/data-deletion"]) assert.match(page, new RegExp(`href="${href}"`));
});
