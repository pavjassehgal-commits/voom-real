import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Legal pages (Meta compliance set): /privacy, /terms, /data-deletion.
// They must be public, unauthenticated, truthful about current Voom behavior,
// and use the single centralized support email constant.

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
// Collapse JSX line-wrapping so prose assertions match rendered text, not formatting.
const flatRead = async (path) => (await read(path)).replace(/\s+/g, " ");

const PAGES = [
  { path: "app/privacy/page.tsx", route: "/privacy", title: /Privacy Policy/ },
  { path: "app/terms/page.tsx", route: "/terms", title: /Terms of Service/ },
  { path: "app/data-deletion/page.tsx", route: "/data-deletion", title: /Data Deletion/ },
];

test("legal pages exist as top-level public routes with metadata titles", async () => {
  for (const page of PAGES) {
    const source = await flatRead(page.path);
    assert.match(source, /export const metadata: Metadata = \{/, `${page.path} must export metadata`);
    assert.match(source, /title: .+Voom/, `${page.path} must set a title including Voom`);
    assert.match(source, page.title, `${page.path} title must describe the page`);
    assert.match(source, /description:/, `${page.path} must set a description`);
    assert.match(source, /export default function/, `${page.path} must default-export a page`);
  }
});

test("legal pages never gate on auth, redirect to login or /app, or touch the database", async () => {
  const sources = await Promise.all([
    ...PAGES.map((page) => flatRead(page.path)),
    flatRead("app/components/legal.tsx"),
  ]);
  const all = sources.join("\n");
  assert.doesNotMatch(all, /getCurrentUser|createClient|getClaims|createAdminClient/);
  assert.doesNotMatch(all, /redirect\(/);
  assert.doesNotMatch(all, /href="\/login"|href="\/app"|\/auth\/callback/);
  // Public pages must stay server-rendered and static-friendly.
  assert.doesNotMatch(all, /"use client"/);
});

test("support email is defined once, centrally, and referenced through the constant", async () => {
  const contact = await read("lib/legal/contact.ts");
  assert.match(contact, /export const SUPPORT_EMAIL = "support@voom\.app";/);
  assert.match(contact, /LEGAL_LAST_UPDATED/);

  const sources = await Promise.all([
    ...PAGES.map((page) => flatRead(page.path)),
    flatRead("app/components/legal.tsx"),
  ]);
  for (const source of sources) {
    // The address itself must never be hardcoded outside lib/legal/contact.ts.
    assert.doesNotMatch(source, /support@voom\.app/);
  }
  assert.match(sources[3], /SUPPORT_EMAIL/, "app/components/legal.tsx must import the constant");
  // privacy@voom.app was explicitly not confirmed to exist — it must appear nowhere.
  for (const source of sources) {
    assert.doesNotMatch(source, /privacy@voom\.app/);
  }
});

test("legal shell is Voom-styled, mobile responsive, and cross-links the three pages", async () => {
  const shell = await read("app/components/legal.tsx");
  assert.match(shell, /from "\.\/Logo"/);
  assert.match(shell, /min-h-screen/);
  assert.match(shell, /max-w-3xl/);
  // Responsive breakpoints beyond the base styles.
  assert.match(shell, /sm:px-6|sm:py-14/);
  assert.match(shell, /sm:flex-row/);
  assert.match(shell, /font-display/);
  assert.match(shell, /text-balance/);
  // Cross-navigation between the three legal routes and home.
  const flatShell = shell.replace(/\s+/g, " ");
  for (const route of ["/privacy", "/terms", "/data-deletion", "/"]) {
    assert.match(flatShell, new RegExp(`href="${route}"`));
  }
});

test("Privacy Policy truthfully covers current Voom data flows", async () => {
  const privacy = await flatRead("app/privacy/page.tsx");
  // Every category of data the product actually handles today.
  assert.match(privacy, /Account and business data/);
  assert.match(privacy, /Instagram connection data/);
  assert.match(privacy, /instagram_business_basic/);
  assert.match(privacy, /instagram_business_content_publish/);
  assert.match(privacy, /AES-256-GCM/);
  assert.match(privacy, /Marketing plans and content/);
  assert.match(privacy, /content calendars/);
  assert.match(privacy, /Media you provide or generate/);
  assert.match(privacy, /Contacts and audiences/);
  assert.match(privacy, /Resend/);
  assert.match(privacy, /ClickSend/);
  assert.match(privacy, /AI providers/);
  assert.match(privacy, /Groq, OpenAI, Google \(Gemini\), NVIDIA/);
  assert.match(privacy, /Supabase/);
  assert.match(privacy, /Vercel/);
  assert.match(privacy, /row-level security/);
  assert.match(privacy, /Retention/);
  assert.match(privacy, /Security/);
  assert.match(privacy, /deletion/i);

  // Required honest statements.
  assert.match(privacy, /do not sell your personal data/i);
  assert.match(privacy, /does not currently publish to Instagram/);
  assert.match(privacy, /does not train its own models/);
  // No false guarantees of absolute security.
  assert.match(privacy, /cannot guarantee absolute security/);
  assert.match(privacy, /do not currently use analytics, advertising, or other third-party tracking/i);
});

test("Terms cover service scope, responsibilities, AI review, and honest billing", async () => {
  const terms = await flatRead("app/terms/page.tsx");
  assert.match(terms, /The Service/);
  assert.match(terms, /MARA/);
  assert.match(terms, /Connected third-party accounts/);
  assert.match(terms, /Your responsibilities/);
  assert.match(terms, /consent required under the anti-spam/);
  assert.match(terms, /AI content and human review/);
  assert.match(terms, /No guaranteed marketing results/);
  assert.match(terms, /Acceptable use/);
  assert.match(terms, /Termination/);
  assert.match(terms, /Disclaimers/);
  assert.match(terms, /Limitation of liability/);
  assert.match(terms, /Contact/);
  // Billing must remain honest: currently free, demonstration pricing, nothing charged.
  assert.match(terms, /currently provided free of charge/);
  assert.match(terms, /no payment is taken/);
  // Instagram publishing must not be claimed as live.
  assert.match(terms, /does not currently publish to Instagram/);
});

test("Data Deletion describes a manual, conservative, contactable process", async () => {
  const deletion = await flatRead("app/data-deletion/page.tsx");
  assert.match(deletion, /What you can request/);
  assert.match(deletion, /How to request deletion/);
  assert.match(deletion, /Processing timeframe/);
  assert.match(deletion, /What gets deleted/);
  assert.match(deletion, /Instagram-connected data/);
  assert.match(deletion, /What we may keep/);
  assert.match(deletion, /If you are a contact of a Voom customer/);
  // No fake automated deletion endpoint; requests go through the support inbox.
  assert.match(deletion, /no automated deletion endpoint|handled manually by the Voom team/);
  assert.doesNotMatch(deletion, /\/api\/[a-z-]*delet/i);
  assert.doesNotMatch(deletion, /DELETE request/i);
  // Conservative, explicit timeframe and verification approach.
  assert.match(deletion, /30 days/);
  assert.match(deletion, /from the email address associated with your Voom account/);
  assert.match(deletion, /we do not ask for passwords/i);
  // Instagram handling stays honest about what Voom cannot delete.
  assert.match(deletion, /cannot delete anything held by Instagram or Meta/);
});

test("legal pages stay out of product internals (no AI, media, Instagram, or reel code dependencies)", async () => {
  const sources = await Promise.all([
    ...PAGES.map((page) => read(page.path)),
    read("app/components/legal.tsx"),
    read("lib/legal/contact.ts"),
  ]);
  const all = sources.join("\n");
  for (const internal of ["@/lib/mara", "@/lib/media", "@/lib/instagram", "@/lib/voom", "@/lib/email", "@/lib/sms", "@/utils/supabase"]) {
    assert.doesNotMatch(all, new RegExp(internal.replace(/\//g, "\\/")), `legal pages must not import ${internal}`);
  }
  assert.doesNotMatch(all, /magic hour/i);
  assert.doesNotMatch(all, /generateVideo|mara_media_generations|instagram_publish_jobs/);
});
