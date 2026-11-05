/**
 * "Continue with Google" on login and signup (2026-10-20).
 *
 *   1. One server action asks Supabase for a Google sign-in URL that returns
 *      to our own callback (`/auth/callback?next=/app`), then sends the
 *      browser there. A failure lands on the login page's fixed message.
 *   2. Both the login and signup forms offer the button.
 *   3. The login page shows the Google failure message for its fixed key only.
 *
 * The callback's code exchange is already covered by tests/forgot-password.test.mjs
 * test 3 (`next=/app`), and Google users without a business row go through the
 * existing onboarding gate in app/app/(shell)/layout.tsx: nothing new to test.
 *
 * Runs the real action and pages against doubled Supabase/Next runtime modules
 * (tests/helpers/auth-doubles.mjs).
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { importApp, renderToStaticMarkup } from "./helpers/rendered-surface.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const read = (relative) => readFile(path.join(ROOT, relative), "utf8");

process.env.NEXT_PUBLIC_SITE_URL = "https://voom.test";

const doublesUrl = pathToFileURL(path.join(ROOT, "tests/helpers/auth-doubles.mjs")).href;
const DOUBLED = new Set(["@/utils/supabase/server", "next/navigation", "next/headers"]);
const SCOPED_TO = [
  "/app/auth/google/actions.ts",
  "/app/login/page.tsx",
  "/app/login/actions.ts",
  "/app/signup/page.tsx",
  "/app/signup/actions.ts",
];
registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = decodeURIComponent(context.parentURL ?? "");
    if (DOUBLED.has(specifier) && SCOPED_TO.some((file) => parent.endsWith(file))) {
      return { url: doublesUrl, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});

const doubles = await import(doublesUrl);

test("1. the Google action asks Supabase for a Google URL returning to our callback, then goes there; a failure goes to the login message", async () => {
  const { continueWithGoogle } = await importApp("app/auth/google/actions.ts");

  doubles.reset();
  const landed = await doubles.redirectedTo(() => continueWithGoogle());
  assert.equal(doubles.state.oauthCalls.length, 1, "exactly one sign-in request");
  const { provider, options } = doubles.state.oauthCalls[0];
  assert.equal(provider, "google");
  const redirectTo = new URL(options.redirectTo);
  assert.equal(redirectTo.origin, "https://voom.test", "returns to the configured site, not the request origin");
  assert.equal(redirectTo.pathname, "/auth/callback");
  assert.equal(redirectTo.searchParams.get("next"), "/app");
  assert.match(landed ?? "", /^https:\/\/accounts\.google\.com\//, "the browser is sent to the URL Supabase returned");

  doubles.reset({ oauthError: { message: "Unsupported provider: provider is not enabled", code: "validation_failed", status: 400 } });
  const failed = await doubles.redirectedTo(() => continueWithGoogle());
  assert.equal(failed, "/login?error=google_failed", "a refusal (e.g. provider not enabled) is explained on the login page");
});

test("2. login and signup both offer Continue with Google through the one action", async () => {
  const button = await read("app/components/GoogleButton.tsx");
  assert.match(button, /continueWithGoogle/, "the button submits the server action");
  assert.match(button, /Continue with Google/, "plain wording");

  for (const file of ["app/login/LoginForm.tsx", "app/signup/SignupForm.tsx"]) {
    const source = await read(file);
    assert.match(source, /GoogleButton/, `${file} renders the Google button`);
  }

  doubles.reset();
  const login = await importApp("app/login/page.tsx");
  let html = renderToStaticMarkup(await login.default({ searchParams: Promise.resolve({}) }));
  assert.match(html, /Continue with Google/, "login page shows the button");
  assert.match(html, /name="email"/, "email login is still there");

  doubles.reset();
  const signup = await importApp("app/signup/page.tsx");
  html = renderToStaticMarkup(await signup.default());
  assert.match(html, /Continue with Google/, "signup page shows the button");
  assert.match(html, /name="confirmPassword"/, "email signup is still there");
});

test("3. the login page shows the Google failure message for its fixed key only", async () => {
  const page = await importApp("app/login/page.tsx");
  const render = async (searchParams) =>
    renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(searchParams) }));

  // React renders the apostrophe in "didn't" as &#x27;.
  const message = /Google sign-in didn(?:'|&#x27;)t complete/i;

  doubles.reset();
  let html = await render({ error: "google_failed" });
  assert.match(html, message, "the fixed message is shown");
  assert.match(html, /role="alert"/);

  doubles.reset();
  html = await render({ error: "google_<b>x</b>" });
  assert.doesNotMatch(html, message, "an unknown key shows nothing");
  assert.doesNotMatch(html, /<b>x<\/b>/, "the address bar text is never echoed");
});
