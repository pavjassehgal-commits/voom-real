import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
const { signupFlow, loginFlow, emailFlow, verificationFlow, resetFlow } = await import("../lib/auth/flows.ts");
const { isVerifiedUser, normalizeEmail, validEmail, safeNext, passwordError } = await import("../lib/auth/policy.ts");
const { authCallbackUrl, authSiteUrl } = await import("../lib/auth/site.ts");
const { readRecoveryCode, recoveryCookieOptions } = await import("../lib/auth/recovery.ts");
const { authBoundary, NON_SESSION_APIS, unsafeBrowserMutation } = await import("../lib/auth/boundaries.ts");
const verified = { id: "owner", email: "owner@example.test", email_confirmed_at: "2020-01-01T00:00:00Z" };
function form(values = {}) { const f = new FormData(); for (const [k,v] of Object.entries({ email: " Owner+one@EXAMPLE.test ", password: "long unique passphrase", confirmPassword: "long unique passphrase", ...values })) f.set(k,v); return f; }
function fake(overrides = {}) {
  const calls = [];
  const defaults = { signUp: { data: { user: verified, session: null }, error: null }, signInWithPassword: { error: null }, getUser: { data: { user: verified }, error: null }, exchangeCodeForSession: { data: { user: verified, session: {}, redirectType: null }, error: null }, updateUser: { error: null }, signOut: { error: null }, resend: { error: null }, resetPasswordForEmail: { error: null } };
  const auth = Object.fromEntries(Object.entries({ ...defaults, ...overrides }).map(([name, result]) => [name, async (...args) => { calls.push([name, ...args]); return result; }]));
  return { auth, calls };
}
const CALLBACK = "https://voom-real.vercel.app/auth/callback";

test("email normalization preserves mailbox semantics; validation rejects header/control abuse", () => {
  assert.equal(normalizeEmail(" Test.Name+tag@EXAMPLE.test "), "test.name+tag@example.test");
  for (const email of ["bad", "a@@example.test", "a\nb@example.test", "a\0@example.test", "a@", `${"a".repeat(255)}@example.test`]) assert.equal(validEmail(email), false);
  assert.equal(validEmail(normalizeEmail("Owner+one@example.test")), true);
  assert.ok(passwordError("short")); assert.ok(passwordError("a".repeat(129))); assert.equal(passwordError("a long passphrase"), undefined);
});
test("signup normalizes email and creates verification-required state, with fixed callback and no DB writes", async () => {
  const {auth, calls} = fake();
  assert.equal((await signupFlow(auth, form(), CALLBACK)).destination, "/verify-email");
  assert.deepEqual(calls, [["signUp", { email: "owner+one@example.test", password: "long unique passphrase", options: { emailRedirectTo: CALLBACK } }]]);
});
test("signup validates password and confirmation before contacting Supabase", async () => {
  const {auth,calls} = fake();
  assert.ok((await signupFlow(auth, form({ password: "short" }), CALLBACK)).state.fieldErrors.password);
  assert.ok((await signupFlow(auth, form({ confirmPassword: "different" }), CALLBACK)).state.fieldErrors.confirmPassword);
  assert.equal(calls.length, 0);
});
test("signup NEVER promotes an unexpected auto-confirmed session", async () => {
  const {auth,calls} = fake({ signUp: { data: { session: { user: verified } }, error: null } });
  const result = await signupFlow(auth, form(), CALLBACK);
  assert.equal(result.destination, undefined); assert.match(result.state.formError, /verification.*unavailable/);
  assert.equal(calls.at(-1)[0], "signOut");
});
test("obfuscated duplicates, duplicate errors and throttled signup share verification state", async () => {
  for (const code of [null, "user_already_exists", "email_exists", "over_email_send_rate_limit", "over_request_rate_limit"]) {
    const {auth} = fake({ signUp: { data: { user: { identities: [] }, session: null }, error: code ? {code} : null } });
    assert.equal((await signupFlow(auth, form(), CALLBACK)).destination, "/verify-email");
  }
});
test("authoritative confirmation rejects metadata, phone-only confirmation, anonymous and absent users", () => {
  for (const user of [null, {}, { ...verified, email_confirmed_at: null, confirmed_at: "yes", user_metadata: { email_verified: true } }, { ...verified, email: null }, { ...verified, is_anonymous: true }]) assert.equal(isVerifiedUser(user), false);
  assert.equal(isVerifiedUser(verified), true);
});
test("existing verified users can log in with old shorter passwords", async () => {
  const {auth,calls} = fake();
  assert.equal((await loginFlow(auth, form({ password: "oldpass8", next: "/app/settings" }))).destination, "/app/settings");
  assert.equal(calls.at(-1)[0], "getUser");
});
test("login rejects bad credentials, unconfirmed users and invalid sessions", async () => {
  let f = fake({ signInWithPassword: { error: { code: "invalid_credentials" } } });
  assert.match((await loginFlow(f.auth, form())).state.formError, /Unable to sign in/);
  f = fake({ signInWithPassword: { error: { code: "email_not_confirmed" } } });
  assert.equal((await loginFlow(f.auth, form())).destination, "/verify-email");
  f = fake({ getUser: { data: {user: {...verified, email_confirmed_at: null}}, error: null } });
  assert.equal((await loginFlow(f.auth, form())).destination, "/verify-email"); assert.equal(f.calls.at(-1)[0], "signOut");
  f = fake({ getUser: { data: {user: null}, error: {code: "bad_jwt"} } });
  assert.match((await loginFlow(f.auth, form())).state.formError, /session/);
});
test("verification exchanges a PKCE code with its flow ID and rechecks authoritative user", async () => {
  const {auth,calls} = fake();
  assert.equal(await verificationFlow(auth, "one-use-code", "flow-id", "/app/plan"), "/verify-email/success?next=%2Fapp%2Fplan");
  assert.deepEqual(calls, [["exchangeCodeForSession", "one-use-code", {flowId:"flow-id"}], ["getUser"]]);
});
test("invalid/expired/reused codes and unverified exchanged users cannot continue", async () => {
  for (const error of ["otp_expired", "flow_state_expired", "bad_code_verifier", "flow_state_not_found"]) {
    const {auth} = fake({ exchangeCodeForSession: {data: {}, error: {code:error}} });
    assert.equal(await verificationFlow(auth, "bad-code", null, "/app"), "/verify-email?error=invalid_link");
  }
  const {auth,calls} = fake({ getUser: {data:{user:{...verified,email_confirmed_at:null}},error:null} });
  assert.equal(await verificationFlow(auth, "code", null, "/app"), "/verify-email?error=invalid_link");
  assert.equal(calls.at(-1)[0], "signOut");
});
test("recovery code cannot be rerouted through verification to normal product access", async () => {
  const {auth,calls} = fake({exchangeCodeForSession:{data:{redirectType:"recovery"},error:null}});
  assert.equal(await verificationFlow(auth,"code",null,"/app"),"/forgot-password?error=invalid_link");
  assert.equal(calls.at(-1)[0],"signOut");
});
test("resend and forgot-password use Supabase, fixed callbacks and enumeration-neutral rate-limit-safe responses", async () => {
  for (const kind of ["signup", "recovery"]) {
    let reference;
    for (const code of [null,"user_not_found","email_not_confirmed","over_email_send_rate_limit","unexpected_failure"]) {
      const method = kind === "signup" ? "resend" : "resetPasswordForEmail";
      const {auth,calls} = fake({[method]:{error:code ? {code}:null}});
      const state = await emailFlow(auth,kind,form(),CALLBACK);
      if (reference) assert.deepEqual(state,reference); reference = state;
      assert.equal(state.retryAfter,60); assert.equal(calls.length,1); assert.equal(calls[0][0],method);
      assert.ok(JSON.stringify(calls[0]).includes(CALLBACK));
    }
  }
});
test("password reset requires a fresh code even for an already signed-in verified user", async () => {
  const {auth,calls} = fake();
  assert.equal((await resetFlow(auth,form(),null)).destination,"/forgot-password?error=invalid_link");
  assert.equal(calls.length,0);
});
test("password validation leaves recovery code unconsumed", async () => {
  const {auth,calls} = fake();
  assert.ok((await resetFlow(auth,form({password:"short"}),{code:"code"})).state.fieldErrors.password);
  assert.equal(calls.length,0);
});
test("password update redeems recovery PKCE, checks user, updates and globally signs out", async () => {
  const {auth,calls} = fake({exchangeCodeForSession:{data:{redirectType:"recovery"},error:null}});
  assert.equal((await resetFlow(auth,form(),{code:"code",flowId:"flow"})).destination,"/reset-password/success");
  assert.deepEqual(calls,[["exchangeCodeForSession","code",{flowId:"flow"}],["getUser"],["updateUser",{password:"long unique passphrase"}],["signOut",{scope:"global"}]]);
});
test("reset rejects expired/non-recovery codes, ignores any existing session and reports update failure safely", async () => {
  for (const response of [{data:{},error:{code:"otp_expired"}},{data:{redirectType:null},error:null}]) {
    const {auth,calls} = fake({exchangeCodeForSession:response});
    assert.equal((await resetFlow(auth,form(),{code:"bad"})).destination,"/forgot-password?error=invalid_link");
    assert.equal(calls.some(([name]) => name === "updateUser"),false);
  }
  const {auth} = fake({exchangeCodeForSession:{data:{redirectType:"recovery"},error:null},updateUser:{error:{message:"secret-sensitive-details"}}});
  assert.equal((await resetFlow(auth,form(),{code:"code"})).destination,"/forgot-password?error=reset_failed");
});
test("redirect allowlist rejects absolute, protocol-relative, encoded, backslash and query destinations", async () => {
  for (const value of ["https://evil.test","//evil.test","/\\evil.test","%2f%2fevil.test","/app?next=//evil.test","/app/../auth/callback","/app#evil","javascript:alert(1)"]) {
    assert.equal(safeNext(value),"/app");
    const {auth} = fake(); assert.equal((await loginFlow(auth,form({next:value}))).destination,"/app");
  }
});
test("auth email URL uses only configured origin or canonical deployment, never request headers", () => {
  const previous = process.env.NEXT_PUBLIC_SITE_URL;
  try {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    assert.equal(authCallbackUrl("signup"),CALLBACK);
    assert.equal(authCallbackUrl("recovery"),"https://voom-real.vercel.app/auth/recovery");
    for (const bad of ["javascript:bad", "https://user:pass@evil.test", "https://evil.test/path", "https://evil.test?next=bad"]) {
      process.env.NEXT_PUBLIC_SITE_URL = bad; assert.throws(authSiteUrl);
    }
  } finally { if (previous === undefined) delete process.env.NEXT_PUBLIC_SITE_URL; else process.env.NEXT_PUBLIC_SITE_URL=previous; }
});
test("recovery transport is bounded, HttpOnly, same-site and short-lived; it grants no session", () => {
  assert.equal(recoveryCookieOptions.httpOnly,true); assert.equal(recoveryCookieOptions.sameSite,"lax"); assert.equal(recoveryCookieOptions.maxAge,600);
  for (const value of [undefined,"{",JSON.stringify({code:"//evil"}),JSON.stringify({code:"a",flowId:"bad/flow"})]) assert.equal(readRecoveryCode(value),null);
  assert.deepEqual(readRecoveryCode('{"code":"code","flowId":"flow"}'),{code:"code",flowId:"flow"});
});
test("product routes default to protected; machine routes only retain explicitly enumerated exceptions", () => {
  for (const path of ["/app","/app/onboarding","/app/plan"]) assert.equal(authBoundary(path),"app");
  for (const path of ["/api/new-api","/api/voom/campaigns","/api/integrations/youtube/callback","/api/cron/not-a-real-job"]) assert.equal(authBoundary(path),"api");
  for (const path of NON_SESSION_APIS) assert.equal(authBoundary(path),null);
  assert.equal(unsafeBrowserMutation("POST","https://evil.test","voom-real.vercel.app","cross-site"),true);
  assert.equal(unsafeBrowserMutation("POST","https://voom-real.vercel.app","voom-real.vercel.app","same-origin"),false);
});

test("installed Supabase SDK carries recovery PKCE context through code exchange (mock HTTP only)", async () => {
  const {createClient} = await import("@supabase/supabase-js");
  const storage = new Map(); const requests=[];
  const encoded = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
  const access = `${encoded({alg:"HS256",typ:"JWT"})}.${encoded({sub:verified.id,exp:Math.floor(Date.now()/1000)+3600})}.test-signature`;
  const client = createClient("https://test.supabase.co","test-publishable-key",{
    auth:{flowType:"pkce",autoRefreshToken:false,detectSessionInUrl:false,persistSession:true,storage:{getItem:key => storage.get(key)??null,setItem:(key,value) => storage.set(key,value),removeItem:key => storage.delete(key)}},
    global:{fetch:async (input,init) => {
      const url = new URL(String(input));requests.push({path:url.pathname,body:JSON.parse(init.body??"{}")});
      if(url.pathname.endsWith("/recover"))return Response.json({});
      if(url.pathname.endsWith("/token"))return Response.json({access_token:access,refresh_token:"test-only",expires_in:3600,token_type:"bearer",user:verified});
      throw new Error("Unexpected mocked auth endpoint");
    }},
  });
  assert.equal((await client.auth.resetPasswordForEmail(verified.email,{redirectTo:"https://voom-real.vercel.app/auth/recovery"})).error,null);
  const exchanged=await client.auth.exchangeCodeForSession("mock-code");
  assert.equal(exchanged.error,null);
  assert.equal(exchanged.data.redirectType,"recovery");
  assert.ok(requests[0].body.code_challenge);
  assert.ok(requests[1].body.code_verifier);
  assert.equal(requests[1].body.auth_code,"mock-code");
});
