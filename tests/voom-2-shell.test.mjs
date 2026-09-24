/**
 * Voom 2.0 — Phase 1: Design System + Application Shell
 * Focused shell tests for foundation PR.
 *
 * Verifies:
 * - Primary navigation destinations
 * - Active navigation state
 * - Preservation of secondary/legacy route access
 * - Business/account context
 * - Responsive navigation behavior
 * - No fake/dead controls introduced
 * - Design system tokens
 * - No forbidden visual concepts (Dubai skyline, chatbot, etc)
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

// ──────────────────────────────────────────────────────────────────
// Primary navigation destinations
// ──────────────────────────────────────────────────────────────────
test("Voom 2.0 primary navigation destinations exist", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  const primary = [
    { id: "today", label: "Today" },
    { id: "plan", label: "Marketing Plan" },
    { id: "studio", label: "Create" },
    { id: "calendar", label: "Calendar" },
    { id: "performance", label: "Performance" },
  ];
  for (const { id } of primary) {
    assert.match(nav, new RegExp(`id:\\s*"${id}"`), `Primary must include ${id}`);
  }
  // Primary group must exist
  assert.match(nav, /g:\s*"Primary"/, "NAV must have Primary group");
});

test("Voom 2.0 secondary navigation destinations exist", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  for (const id of ["campaigns", "contacts", "connections"]) {
    assert.match(nav, new RegExp(`id:\\s*"${id}"`), `Secondary must include ${id}`);
  }
  assert.match(nav, /g:\s*"Secondary"/, "NAV must have Secondary group");
});

test("Voom 2.0 utility navigation destinations exist", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  assert.match(nav, /id:\s*"settings"/, "Utility must include settings");
  assert.match(nav, /g:\s*"Utility"/, "NAV must have Utility group");
});

// ──────────────────────────────────────────────────────────────────
// Active navigation state
// ──────────────────────────────────────────────────────────────────
test("active navigation state is preserved and accessible", async () => {
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  // Must use aria-current for active state
  assert.match(sidebar, /aria-current/, "Sidebar must use aria-current for active state");
  // Must use pageIdFromPath to derive active id
  assert.match(sidebar, /pageIdFromPath/, "Sidebar must derive active from pathname");
  // Must have clear selected state styling
  assert.match(sidebar, /bg-\[var\(--sidebar-bg-active\)\]|sidebar-bg-active/, "Sidebar must have active bg token");

  const nav = await read("components/voom/shell/nav.ts");
  assert.match(nav, /pageIdFromPath/, "nav.ts must export pageIdFromPath");
  // pageIdFromPath must handle /app and subpaths
  const { pageIdFromPath } = await import("../components/voom/shell/nav.ts");
  assert.equal(pageIdFromPath("/app"), "today");
  assert.equal(pageIdFromPath("/app/"), "today");
  assert.equal(pageIdFromPath("/app/today"), "today");
  assert.equal(pageIdFromPath("/app/plan"), "plan");
  assert.equal(pageIdFromPath("/app/calendar"), "calendar");
  assert.equal(pageIdFromPath("/app/performance"), "performance");
  assert.equal(pageIdFromPath("/app/campaigns"), "campaigns");
  assert.equal(pageIdFromPath("/app/settings"), "settings");
});

test("BottomBar mirrors primary navigation", async () => {
  const bottom = await read("components/voom/shell/BottomBar.tsx");
  for (const id of ["today", "plan", "studio", "calendar", "performance"]) {
    assert.match(bottom, new RegExp(`"${id}"`), `BottomBar must include ${id}`);
  }
  assert.match(bottom, /aria-current/, "BottomBar must use aria-current");
  assert.match(bottom, /md:hidden/, "BottomBar must be hidden on desktop");
});

// ──────────────────────────────────────────────────────────────────
// Preservation of secondary/legacy route access
// ──────────────────────────────────────────────────────────────────
test("legacy routes remain accessible — approvals and automations preserved", async () => {
  const nav = await read("components/voom/shell/nav.ts");
  // Approvals and Automations must still be in NAV (System group) for safe access
  assert.match(nav, /id:\s*"approvals"/, "Approvals must remain reachable");
  assert.match(nav, /id:\s*"automations"/, "Automations must remain reachable");
  assert.match(nav, /System/, "Legacy should be in System group");

  // Store must still map them
  const store = await read("lib/voom/store.tsx");
  assert.match(store, /approvals:\s*"\/app\/approvals"/);
  assert.match(store, /automations:\s*"\/app\/automations"/);

  // Routes must exist
  const approvalsPage = await read("app/app/(shell)/approvals/page.tsx");
  assert.match(approvalsPage, /ApprovalsBoard/);
  const automationsPage = await read("app/app/(shell)/automations/page.tsx");
  assert.match(automationsPage, /Automations/);
});

test("removed routes still resolve without dead links", async () => {
  const reelsRoute = await read("app/app/(shell)/reels/page.tsx");
  assert.match(reelsRoute, /redirect\("\/app\/studio"\)/, "reels must redirect to studio");
  const adsPage = await read("app/app/(shell)/ads/page.tsx");
  assert.match(adsPage, /isn’t set up for your business yet/);
  assert.match(adsPage, /no ad account is connected/);
  // No fake numbers in ads page
  assert.doesNotMatch(adsPage, /AED \d.*ROAS|Allocation.*\d%/);
});

test("social provider routes remain reachable via connections hub", async () => {
  const connections = await read("app/app/(shell)/connections/page.tsx");
  // Connections page should exist and be real
  assert.ok(connections.length > 0);

  // Instagram, TikTok, YouTube routes must still exist
  const ig = await read("app/app/(shell)/instagram/page.tsx");
  const tiktok = await read("app/app/(shell)/tiktok/page.tsx");
  const youtube = await read("app/app/(shell)/youtube/page.tsx");
  assert.ok(ig.length > 0 && tiktok.length > 0 && youtube.length > 0);

  const store = await read("lib/voom/store.tsx");
  assert.match(store, /instagram:\s*"\/app\/instagram"/);
  assert.match(store, /tiktok:\s*"\/app\/tiktok"/);
  assert.match(store, /youtube:\s*"\/app\/youtube"/);
});

// ──────────────────────────────────────────────────────────────────
// Business / account context
// ──────────────────────────────────────────────────────────────────
test("business/account context preserved in shell", async () => {
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  // Must show plan context
  assert.match(sidebar, /plan/, "Sidebar must preserve plan context");
  assert.match(sidebar, /displayName|email/, "Sidebar must preserve account context");
  assert.match(sidebar, /Plans & billing|See plans|Plans/, "Sidebar must preserve billing access");

  const topbar = await read("components/voom/shell/Topbar.tsx");
  // Topbar must preserve profile menu with real data
  assert.match(topbar, /displayName|email/, "Topbar must preserve account context");
  assert.match(topbar, /getPlanConfig|planName/, "Topbar must preserve plan context");
  assert.match(topbar, /Plans & billing|Brand settings/, "Topbar must preserve settings access");
});

// ──────────────────────────────────────────────────────────────────
// Responsive navigation behavior
// ──────────────────────────────────────────────────────────────────
test("responsive navigation behavior is preserved", async () => {
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  assert.match(sidebar, /md:hidden/, "Sidebar must have mobile overlay");
  assert.match(sidebar, /-translate-x-\[105%\]/, "Sidebar must collapse on mobile");
  assert.match(sidebar, /md:sticky/, "Sidebar must be sticky on desktop");
  assert.match(sidebar, /transition-transform/, "Sidebar must have transition");

  const appShell = await read("components/voom/shell/AppShell.tsx");
  assert.match(appShell, /flex/, "AppShell must be flex");
  assert.match(appShell, /min-h-dvh/, "AppShell must be full height");
  assert.match(appShell, /max-w-\[1280px\]|max-w-\[1320px\]/, "AppShell must have max-width");

  const topbar = await read("components/voom/shell/Topbar.tsx");
  assert.match(topbar, /sticky/, "Topbar must be sticky");
  assert.match(topbar, /backdrop-blur/, "Topbar must have blur for restrained effect");
});

// ──────────────────────────────────────────────────────────────────
// No fake/dead controls
// ──────────────────────────────────────────────────────────────────
test("no fake or dead controls introduced", async () => {
  const topbar = await read("components/voom/shell/Topbar.tsx");
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  const appShell = await read("components/voom/shell/AppShell.tsx");

  // Search must be real (api/search), not decorative
  assert.match(topbar, /\/api\/search/, "Search must be real");
  assert.doesNotMatch(topbar, /isn't available in this version/);

  // Notifications must be real (api/voom/workflow)
  assert.match(topbar, /\/api\/voom\/workflow/, "Notifications must be real");
  assert.doesNotMatch(topbar, /notif: 3/);

  // No fake Dubai skyline or location imagery
  const allShell = topbar + sidebar + appShell;
  assert.doesNotMatch(allShell, /Dubai|skyline|Burj|Marina.*Cafe/i);

  // No chatbot UI
  assert.doesNotMatch(allShell, /Ask MARA|chat input|floating.*assistant/i);
  // Check for chat input patterns
  assert.doesNotMatch(allShell, /MARA.*chat|chatbot/i);

  // No giant AI gradients in shell (voom-grad is okay for logo, but not flood)
  // Ensure shell doesn't have giant gradient backgrounds
  assert.doesNotMatch(sidebar, /voom-grad.*h-full|bg-gradient.*from-purple|bg-gradient.*ai/i);
});

test("MARA visual language is calm and operational, not chatbot", async () => {
  const primitives = await read("components/voom/ui/primitives.tsx");
  // Must have MARA dot/status treatment
  assert.match(primitives, /MaraDot|MaraStatus|voom-dot-green/, "Must have MARA operational treatment");
  assert.match(primitives, /green-dot|green-soft|MARA active/, "MARA treatment must use green operational color");

  // Must NOT have chatbot patterns
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  const topbar = await read("components/voom/shell/Topbar.tsx");
  const all = primitives + sidebar + topbar;
  assert.doesNotMatch(all, /Ask MARA|chat input|floating AI|robot|avatar.*MARA/i);
});

// ──────────────────────────────────────────────────────────────────
// Design system tokens
// ──────────────────────────────────────────────────────────────────
test("Voom 2.0 design system tokens are established", async () => {
  const css = await read("app/globals.css");

  // Neutral near-white workspace — the rejected cream/beige direction must not return.
  assert.match(css, /--bg:\s*#f7f8fb/, "Must have a clean neutral near-white bg");
  assert.doesNotMatch(css, /--bg:\s*#f6f5ef|#f7f5ef|#f8f6f0|#faf8f4/, "Workspace must not use the rejected cream palette");
  // Near-black / graphite navigation shell
  assert.match(css, /--sidebar-bg:\s*#080a12/, "Must have navy-graphite sidebar bg");

  // Crisp dark typography
  assert.match(css, /--text:\s*#111522/, "Must have crisp neutral dark text");

  // Restrained borders
  assert.match(css, /--line:/, "Must have line tokens");
  assert.match(css, /--line-2:/, "Must have line-2 tokens");

  // Subtle shadows
  assert.match(css, /--shadow:/, "Must have shadow token");
  assert.match(css, /--shadow-sm:/, "Must have shadow-sm token");
  assert.match(css, /--shadow-lg:/, "Must have shadow-lg token");

  // Premium rounded surfaces
  assert.match(css, /--r-lg:\s*20px|18px|24px/, "Must have premium radius");
  assert.match(css, /--r:\s*14px|16px/, "Must have radius token");

  // Green operational state
  assert.match(css, /--green:/, "Must have green operational token");
  assert.match(css, /--green-soft:/, "Must have green-soft token");
  assert.match(css, /--green-dot:/, "Must have green-dot token");

  // Semantic tokens, not hardcoded everywhere
  assert.match(css, /--sidebar-bg-active/, "Must have sidebar active token");
  assert.match(css, /--sidebar-text/, "Must have sidebar text tokens");

  // Atmospheric iridescence — subtle, code-native and never photography.
  assert.match(css, /--atmosphere|atmospheric/, "Must have atmospheric accent");
  assert.match(css, /--iridescent:/, "Must establish iridescence as the primary visual identity");
  for (const stop of ["#2dd7ee", "#3578ff", "#7447ff", "#db3ee5", "#ff5d86", "#ff9b4a"]) {
    assert.match(css, new RegExp(stop, "i"), `Iridescent spectrum must include ${stop}`);
  }
  assert.doesNotMatch(css, /url\(.*dubai|url\(.*skyline|photo/i);

  // Near-white may be clean and neutral, but the workspace is not raw #fff.
  const bgMatch = css.match(/:root\s*{[^}]*--bg:\s*([^;]+);/s);
  if (bgMatch) {
    assert.doesNotMatch(bgMatch[1], /#ffffff|#fff\b/, "Workspace bg must remain a dimensional near-white");
  }
});

test("iridescent identity remains decorative, restrained and motion-safe", async () => {
  const css = await read("app/globals.css");
  const appShell = await read("components/voom/shell/AppShell.tsx");
  const primitives = await read("components/voom/ui/primitives.tsx");

  assert.match(appShell, /aria-hidden="true"/, "decorative light volumes must be hidden from assistive technology");
  assert.match(appShell, /pointer-events-none/, "decorative light volumes must never obstruct controls");
  assert.match(css, /prefers-reduced-motion:\s*reduce/, "atmospheric motion must respect reduced motion");
  assert.doesNotMatch(css + appShell, /three|webgl|canvas/i, "the shell must not add a heavy 3D runtime");
  assert.match(primitives, /VoomMark/, "the shell must expose the Voom iridescent brand mark");
});

test("surfaces use soft neutral, subtle border, restrained shadow", async () => {
  const primitives = await read("components/voom/ui/primitives.tsx");
  assert.match(primitives, /rounded-\[var\(--r-lg\)\]|rounded-\[var\(--r-md\)\]/, "Card must use radius token");
  assert.match(primitives, /border.*line|border-line/, "Card must use line token");
  assert.match(primitives, /shadow-\[var\(--shadow/, "Card must use shadow token");
  assert.match(primitives, /bg-surface/, "Card must use surface token");
});

test("accessibility is preserved", async () => {
  const sidebar = await read("components/voom/shell/Sidebar.tsx");
  const topbar = await read("components/voom/shell/Topbar.tsx");
  const primitives = await read("components/voom/ui/primitives.tsx");

  // Keyboard navigation
  assert.match(sidebar, /focus-visible/, "Sidebar must have focus-visible");
  assert.match(topbar, /focus-visible/, "Topbar must have focus-visible");
  assert.match(primitives, /focus-visible/, "Primitives must have focus-visible");

  // Semantic navigation
  assert.match(sidebar, /aria-label.*navigation|role="navigation"|nav/, "Sidebar must have semantic nav");

  // Button distinction
  assert.match(sidebar, /<button/, "Sidebar must use buttons");
  assert.match(topbar, /<button/, "Topbar must use buttons");

  // Reduced motion
  const css = await read("app/globals.css");
  assert.match(css, /prefers-reduced-motion/, "Must have reduced-motion support");
});
