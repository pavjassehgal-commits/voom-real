/**
 * Forgot-password flow (2026-10-17; sign-out-and-return-to-login since 2026-10-20).
 *
 *   1. Login page links to /forgot-password.
 *   2. The request action never reveals whether an account exists, and the
 *      reset link comes back through /auth/callback?next=/reset-password.
 *   3. The callback allows exactly /app and /reset-password, and sends a
 *      broken reset link to the reset page's own message.
 *   4. The reset action validates like signup, sets the password, signs the
 *      user out everywhere, then goes to the login page; a dead link is
 *      explained with a way to request a new one.
 *   5. The reset page shows the form only with a live session.
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
const form = (fields) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
};

test("1. the login page offers a Forgot password link", async () => {
  const source = await read("app/login/LoginForm.tsx");
  assert.match(source, /href="\/forgot-password"/, "links to the forgot-password page");
  assert.match(source, /Forgot password\?/, "uses the plain wording");
});

test("2. requesting a reset never reveals whether the account exists, and the link returns via the callback", async () => {
  const { requestPasswordReset } = await importApp("app/forgot-password/actions.ts");

  doubles.reset();
  let result = await requestPasswordReset({}, form({ email: "" }));
  assert.ok(result.fieldErrors?.email, "an empty email is a field error");
  result = await requestPasswordReset({}, form({ email: "not-an-email" }));
  assert.ok(result.fieldErrors?.email, "a malformed email is a field error");
  assert.equal(doubles.state.resetCalls.length, 0, "Supabase is not called for invalid input");

  doubles.reset();
  const known = await requestPasswordReset({}, form({ email: "owner@example.com" }));
  assert.deepEqual(known, { success: true });
  assert.equal(doubles.state.resetCalls.length, 1);
  const { email, options } = doubles.state.resetCalls[0];
  assert.equal(email, "owner@example.com");
  const redirectTo = new URL(options.redirectTo);
  assert.equal(redirectTo.origin, "https://voom.test", "the link points at the configured site");
  assert.equal(redirectTo.pathname, "/auth/callback");
  assert.equal(redirectTo.searchParams.get("next"), "/reset-password");

  doubles.reset({ resetError: { message: "User not found", code: "user_not_found", status: 400 } });
  const unknown = await requestPasswordReset({}, form({ email: "nobody@example.com" }));
  assert.deepEqual(unknown, known, "an unknown address gets the identical reply");
});

test("3. the callback allows exactly /app and /reset-password, and explains a dead reset link on the reset page", async () => {
  const route = await importApp("app/auth/callback/route.ts");
  const get = (query) => doubles.redirectedTo(() => route.GET(new Request(`https://voom.test/auth/callback?${query}`)));

  doubles.reset();
  assert.equal(await get("code=abc&next=/reset-password"), "/reset-password", "a good reset link lands on the reset page");
  assert.deepEqual(doubles.state.exchangeCalls.map((call) => call.code), ["abc"]);
  doubles.reset();
  assert.equal(await get("code=abc&next=/app"), "/app");
  doubles.reset();
  assert.equal(await get("code=abc&next=https://evil.example"), "/app", "anything outside the allowlist falls back to /app");
  doubles.reset();
  assert.equal(await get("code=abc&next=/app/settings"), "/app", "the allowlist is exact, not prefix-based");

  doubles.reset({ exchangeError: { message: "invalid flow state" } });
  assert.equal(await get("code=abc&next=/reset-password"), "/reset-password?error=link_invalid", "a failed reset exchange goes to the reset page's message");
  doubles.reset({ exchangeError: { message: "invalid flow state" } });
  assert.equal(await get("code=abc&next=/app"), "/login?error=confirm_failed", "a failed confirmation keeps the login message");
  doubles.reset();
  assert.equal(await get("error=access_denied&error_code=otp_expired&next=/reset-password"), "/reset-password?error=link_invalid", "an expired link (no code) is explained on the reset page");
});

test("4. setting a new password validates like signup, updates the user, signs out everywhere, then goes to login; a dead link is explained", async () => {
  const { resetPassword } = await importApp("app/reset-password/actions.ts");

  doubles.reset();
  let result = await resetPassword({}, form({ password: "short", confirmPassword: "short" }));
  assert.match(result.fieldErrors?.password ?? "", /at least 8/);
  result = await resetPassword({}, form({ password: "longenough", confirmPassword: "different1" }));
  assert.match(result.fieldErrors?.confirmPassword ?? "", /do not match/);
  assert.equal(doubles.state.updateCalls.length, 0, "Supabase is not called for invalid input");

  doubles.reset();
  const landed = await doubles.redirectedTo(() => resetPassword({}, form({ password: "longenough", confirmPassword: "longenough" })));
  assert.equal(landed, "/login?notice=password_reset", "a successful reset goes back to login, not into the app");
  assert.deepEqual(doubles.state.updateCalls, [{ password: "longenough" }]);
  assert.deepEqual(doubles.state.signOutCalls, [{ scope: "global" }], "every session for the account is ended");

  doubles.reset({ signOutError: { message: "network down", status: 500 } });
  const landedAnyway = await doubles.redirectedTo(() => resetPassword({}, form({ password: "longenough", confirmPassword: "longenough" })));
  assert.equal(landedAnyway, "/login?notice=password_reset", "the new password is already set, so a failed sign-out still goes to login");

  doubles.reset({ updateError: { message: "Auth session missing!", code: "session_missing", status: 401 } });
  result = await resetPassword({}, form({ password: "longenough", confirmPassword: "longenough" }));
  assert.equal(result.linkExpired, true, "a dead session is reported as an expired link");
  assert.match(result.formError, /expired|invalid/i);
  assert.equal(doubles.state.redirects.length, 0, "no redirect on failure");
  assert.equal(doubles.state.signOutCalls.length, 0, "no sign-out when nothing changed");

  doubles.reset({ updateError: { message: "New password should be different from the old password.", code: "same_password", status: 422 } });
  result = await resetPassword({}, form({ password: "longenough", confirmPassword: "longenough" }));
  assert.ok(result.fieldErrors?.password, "reusing the old password is a field error, not an expired link");
  assert.notEqual(result.linkExpired, true);
});

test("5. the reset page shows the form only with a live session, otherwise a way to request a new link", async () => {
  const page = await importApp("app/reset-password/page.tsx");

  doubles.reset();
  let html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  assert.match(html, /invalid or has expired/i, "no session: the link is explained as dead");
  assert.match(html, /href="\/forgot-password"/, "no session: offers a new link");
  assert.doesNotMatch(html, /name="password"/, "no session: no password form");

  doubles.reset({ claims: { sub: "owner-1" } });
  html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({ error: "link_invalid" }) }));
  assert.match(html, /invalid or has expired/i, "the callback's error wins even with a session");

  doubles.reset({ claims: { sub: "owner-1" } });
  html = renderToStaticMarkup(await page.default({ searchParams: Promise.resolve({}) }));
  assert.match(html, /name="password"/, "with a session: the new-password field");
  assert.match(html, /name="confirmPassword"/, "with a session: the confirm field");
  assert.match(html, /minLength="8"|minlength="8"/i, "same minimum as signup");
  assert.doesNotMatch(html, /logged in straight after/i, "the form no longer promises an automatic login");
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
