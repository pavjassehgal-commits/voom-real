/**
 * Forgot-password flow (2026-10-17; sign-out-and-return-to-login since 2026-10-20).
 *
 *   1. Login page links to /forgot-password.
 *   2. The request action never reveals whether an account exists, and the
 *      reset link comes back through /auth/recovery.
 *   3. The generic callback cannot enter password recovery.
 *   4. The reset action validates like signup, sets the password, signs the
 *      user out everywhere, then goes to the login page; a dead link is
 *      explained with a way to request a new one.
 *   5. The reset page requires a live session and session-bound recovery proof.
 *   6. The login page shows a fixed "password updated" notice, and only that.
 *
 * The actions and route run for real against doubled Supabase/Next runtime
 * modules (tests/helpers/auth-doubles.mjs).
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

// The site URL the reset link must point back to.
process.env.NEXT_PUBLIC_SITE_URL = "https://voom.test";

const doublesUrl = pathToFileURL(path.join(ROOT, "tests/helpers/auth-doubles.mjs")).href;
const DOUBLED = new Set(["@/utils/supabase/server", "next/navigation", "next/headers"]);
const SCOPED_TO = [
  "/app/forgot-password/actions.ts",
  "/app/reset-password/actions.ts",
  "/app/reset-password/page.tsx",
  "/app/auth/callback/route.ts",
  "/app/login/page.tsx",
  "/app/login/actions.ts",
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
test("1. the login page offers a Forgot password link", async () => {
  const source = await read("app/login/LoginForm.tsx");
  assert.match(source, /href="\/forgot-password"/, "links to the forgot-password page");
  assert.match(source, /Forgot password\?/, "uses the plain wording");
});

test("2. reset requests preserve the neutral response and the hardened recovery route", async () => {
  const { requestAuthEmail } = await importApp("lib/transactional-email/auth-requests.ts");
  let calls = 0;
  const known = await requestAuthEmail(async () => "allowed", async () => { calls++; });
  const unknown = await requestAuthEmail(async () => "allowed", async () => { calls++; throw new Error("synthetic provider error"); });
  const limited = await requestAuthEmail(async () => "limited", async () => { calls++; });
  assert.deepEqual(known, unknown, "provider failures do not disclose account existence");
  assert.deepEqual(limited, known, "throttling does not disclose account existence");
  assert.equal(calls, 2, "limited requests never reach the provider");
  const action = await read("app/forgot-password/actions.ts");
  assert.match(action, /new URL\("\/auth\/recovery"/, "reset requests use the hardened recovery page");
});

test("3. the generic callback cannot grant the password recovery flow", async () => {
  const route = await importApp("app/auth/callback/route.ts");
  const get = (query) => doubles.redirectedTo(() => route.GET(new Request(`https://voom.test/auth/callback?${query}`)));

  doubles.reset();
  assert.equal(await get("code=abc&next=/reset-password"), "/app", "generic auth does not enter recovery");
  assert.deepEqual(doubles.state.exchangeCalls.map((call) => call.code), ["abc"]);
  doubles.reset();
  assert.equal(await get("code=abc&next=/app"), "/app");
  doubles.reset();
  assert.equal(await get("code=abc&next=https://evil.example"), "/app", "anything outside the allowlist falls back to /app");
  doubles.reset();
  assert.equal(await get("code=abc&next=/app/settings"), "/app", "the allowlist is exact, not prefix-based");

  doubles.reset({ exchangeError: { message: "invalid flow state" } });
  assert.equal(await get("code=abc&next=/reset-password"), "/login?error=confirm_failed");
  doubles.reset({ exchangeError: { message: "invalid flow state" } });
  assert.equal(await get("code=abc&next=/app"), "/login?error=confirm_failed", "a failed confirmation keeps the login message");
  doubles.reset();
  assert.equal(await get("error=access_denied&error_code=otp_expired&next=/reset-password"), "/login?error=confirm_failed");
});

test("3b. a verified signup link that cannot sign this browser in says the email is confirmed, never that it is invalid", async () => {
  const route = await importApp("app/auth/callback/route.ts");
  const get = (query) => doubles.redirectedTo(() => route.GET(new Request(`https://voom.test/auth/callback?${query}`)));
  for (const code of ["flow_state_expired", "pkce_code_verifier_not_found", "bad_code_verifier"]) {
    doubles.reset({ exchangeError: { message: "synthetic", code } });
    assert.equal(await get("code=abc&next=/app&flow=signup"), "/login?notice=email_confirmed", code);
  }
  // Without the signup marker (e.g. an OAuth return), or for any other failure, the generic error stays.
  doubles.reset({ exchangeError: { message: "synthetic", code: "flow_state_expired" } });
  assert.equal(await get("code=abc&next=/app"), "/login?error=confirm_failed");
  for (const code of ["unexpected_failure", "flow_state_not_found"]) {
    doubles.reset({ exchangeError: { message: "synthetic", code } });
    assert.equal(await get("code=abc&next=/app&flow=signup"), "/login?error=confirm_failed", `${code} is not proof of a verified link`);
  }
  // A failed Supabase verification (no code) is never reported as confirmed.
  doubles.reset();
  assert.equal(await get("error=access_denied&error_code=otp_expired&next=/app&flow=signup"), "/login?error=confirm_failed");
  // The notice is a fixed key that creates no session and grants nothing.
  const login = await read("app/login/page.tsx");
  assert.match(login, /email_confirmed: "If you just confirmed your email, you’re all set\. Log in to continue\."/);
  assert.doesNotMatch(login, /email_confirmed: "[^"]*(invalid|expired)/i);
  const signup = await read("app/signup/actions.ts");
  assert.match(signup, /searchParams\.set\("flow", "signup"\)/);
});

test("4. recovery requires a verified owner and session-bound proof before updating", async () => {
  const action = await read("app/forgot-password/actions.ts");
  assert.match(action, /validRecoveryProof\(/);
  assert.match(action, /claims\.data\?\.claims\?\.sub !== data\.user\.id/);
  assert.match(action, /allowAuthEmail\("password-update"/);
  assert.match(action, /signOut\(\{ scope: "global" \}\)/);
  assert.ok(action.indexOf("validRecoveryProof(") < action.indexOf("updateUser({ password })"));
});

test("5. the reset page requires session-bound proof and offers a new link if absent", async () => {
  const page = await read("app/reset-password/page.tsx");
  assert.match(page, /validRecoveryProof\(/);
  assert.match(page, /claims\.data\?\.claims\?\.sub === data\.user\.id/);
  assert.match(page, /valid \? <NewPasswordForm/);
  assert.match(page, /href="\/forgot-password"/);
});

test("6. the login page shows the password-updated notice only for its fixed key", async () => {
  const page = await importApp("app/login/page.tsx");
  const render = async (searchParams) =>
    renderToStaticMarkup(await page.default({ searchParams: Promise.resolve(searchParams) }));

  doubles.reset();
  let html = await render({ notice: "password_reset" });
  assert.match(html, /password has been updated/i, "the fixed notice is shown");
  assert.match(html, /role="status"/, "as a status, not an error");
  assert.match(html, /name="password"/, "the login form is still there");

  doubles.reset();
  html = await render({ notice: "<b>anything else</b>" });
  assert.doesNotMatch(html, /password has been updated/i, "an unknown key shows nothing");
  assert.doesNotMatch(html, /anything else/, "and the address bar text is never echoed");

  doubles.reset();
  html = await render({});
  assert.doesNotMatch(html, /password has been updated/i, "no key, no notice");
});
