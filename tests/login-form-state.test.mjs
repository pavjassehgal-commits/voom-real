import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";

const root = new URL("../", import.meta.url);

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/navigation") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export function redirect(path) { const error = new Error('redirect'); error.path = path; throw error; }",
        )}`,
        shortCircuit: true,
      };
    }
    if (specifier === "@/utils/supabase/server") {
      return {
        url: `data:text/javascript,${encodeURIComponent(
          "export async function createClient() { return globalThis.__VOOM_LOGIN_SUPABASE__; }",
        )}`,
        shortCircuit: true,
      };
    }
    return nextResolve(specifier, context);
  },
});

const { login } = await import("../app/login/actions.ts");

function form(email, password) {
  const data = new FormData();
  data.set("email", email);
  data.set("password", password);
  return data;
}

function authResult(error) {
  globalThis.__VOOM_LOGIN_SUPABASE__ = {
    auth: {
      signInWithPassword: async () => ({ error }),
    },
  };
}

test("failed login preserves the trimmed email, clears no password into state, and advances the result", async () => {
  authResult({ code: "invalid_credentials", status: 400 });
  const result = await login({}, form("  owner@example.com  ", "not-secret"));
  assert.deepEqual(result, {
    email: "owner@example.com",
    submissionId: 1,
    formError: "Incorrect email or password.",
  });
  assert.equal("password" in result, false);
});

test("safe login errors distinguish throttling and unconfirmed email without exposing provider details", async () => {
  authResult({ code: "over_request_rate_limit", status: 429, message: "private provider detail" });
  const throttled = await login({ submissionId: 4 }, form("owner@example.com", "not-secret"));
  assert.equal(throttled.submissionId, 5);
  assert.equal(throttled.formError, "Too many login attempts. Wait a moment, then try again.");
  assert.doesNotMatch(throttled.formError, /private provider detail/);

  authResult({ code: "email_not_confirmed", status: 400 });
  const unconfirmed = await login({}, form("owner@example.com", "not-secret"));
  assert.equal(unconfirmed.formError, "Confirm your email address before logging in.");
});

test("successful login still creates the session and redirects to the app", async () => {
  authResult(null);
  await assert.rejects(login({}, form("owner@example.com", "not-secret")), (error) => {
    assert.equal(error.message, "redirect");
    assert.equal(error.path, "/app");
    return true;
  });
});

test("the client form controls both fields, preserves email, clears password, and dismisses stale errors on edits", async () => {
  const source = await readFile(new URL("../app/login/LoginForm.tsx", import.meta.url), "utf8");
  assert.match(source, /key=\{`email-\$\{resultId\}`\}/);
  assert.match(source, /defaultValue=\{state\.email \?\? ""\}/);
  assert.match(source, /key=\{`password-\$\{resultId\}`\}/);
  assert.match(source, /defaultValue=""/);
  assert.match(source, /resultIsDismissed \? undefined/);
  assert.match(source, /onSubmit=\{dismissCurrentResult\}/);
  assert.match(source, /onChange=\{dismissCurrentResult\}/);
});
