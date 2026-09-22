import "./helpers/server-only-shim.mjs";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

// Test process only: no live DB, Supabase, emails or provider requests.
const dataModule = text => `data:text/javascript,${encodeURIComponent(text)}`;
registerHooks({
  load(url, context, nextLoad) {
    // Existing Instagram client uses TS parameter properties (Node strip-only
    // cannot parse those). Transform locally; never replace provider logic.
    if (url.endsWith("/lib/instagram/client.ts")) return {format:"module",source:stripTypeScriptTypes(readFileSync(new URL(url),"utf8"),{mode:"transform"}),shortCircuit:true};
    return nextLoad(url,context);
  },
  resolve(specifier, context, nextResolve) {
  const mocks = {
    "@/utils/supabase/server": 'export async function createClient(){return globalThis.authClient}',
    "@/utils/supabase/admin": 'export function createAdminClient(){throw new Error("Unexpected admin access before authorization")}',
    "@supabase/ssr": 'export function createServerClient(u,k,o){globalThis.ssrOptions=o;return globalThis.authClient}',
    "next/headers": 'export async function cookies(){return globalThis.cookieStore}',
    "next/navigation": 'export function redirect(destination){throw Object.assign(new Error("redirect"),{destination})}',
    "next/cache": 'export function revalidatePath(){}',
  };
  if (specifier in mocks) return {url:dataModule(mocks[specifier]),shortCircuit:true};
  if (specifier === "next/server") return nextResolve("next/server.js",context);
  return nextResolve(specifier,context);
}});
const { NextRequest } = await import("next/server.js");
const { updateSession } = await import("../utils/supabase/proxy.ts");
const { getCurrentUser } = await import("../lib/voom/server-data.ts");
const { authBoundary, NON_SESSION_APIS } = await import("../lib/auth/boundaries.ts");
const verified = {id:"11111111-1111-4111-8111-111111111111",email:"owner@example.test",email_confirmed_at:"2020-01-01T00:00:00Z"};
let user, calls, store;
beforeEach(() => {
  user = {...verified, email_confirmed_at:null}; calls=[]; store=new Map();
  globalThis.fetch = async () => { throw new Error("Network forbidden in auth tests"); };
  process.env.NEXT_PUBLIC_SUPABASE_URL="https://test.supabase.co";
  globalThis.cookieStore={get:name => store.has(name) ? {name,value:store.get(name).value} : undefined, getAll:() => [...store].map(([name,item]) => ({name,...item})), set:(name,value,options) => store.set(name,{value,...options}), delete:name => store.delete(name)};
  globalThis.authClient={auth:{
    getUser:async () => {calls.push("getUser");return {data:{user},error:null}},
    getClaims:async () => {calls.push("getClaims");globalThis.ssrOptions.cookies.setAll([{name:"sb-test-auth-token",value:"refreshed",options:{path:"/"}}],{"Cache-Control":"private, no-store"});return {data:{claims:{sub:user?.id}},error:null}},
    exchangeCodeForSession:async () => {calls.push("exchange");return {data:{redirectType:null},error:null}},
    signOut:async () => {calls.push("signOut");user=null;return {error:null}},
    resend:async () => {calls.push("resend");return {error:null}},
    resetPasswordForEmail:async () => {calls.push("recover");return {error:null}},
  },from:() => {throw new Error("Unexpected DB access before authorization")}};
});
function request(path, method="GET", headers={}) {return new NextRequest(`https://voom-real.vercel.app${path}`,{method,headers});}
async function redirected(fn, destination) { await assert.rejects(fn,error => error.destination===destination); }

test("central user helper denies unverified/expired identities and accepts existing verified owner",async () => {
  assert.equal(await getCurrentUser(),null);user=null;assert.equal(await getCurrentUser(),null);
  user=verified;assert.deepEqual(await getCurrentUser(),{id:verified.id,email:verified.email});
  globalThis.authClient.auth.getUser=async () => ({data:{user:verified},error:{code:"bad_jwt"}});
  assert.equal(await getCurrentUser(),null);
});
test("proxy blocks direct app navigation and keeps refreshed cookies on verification redirect",async () => {
  const response=await updateSession(request("/app/onboarding"));
  assert.equal(response.status,307);assert.equal(response.headers.get("location"),"https://voom-real.vercel.app/verify-email");
  assert.equal(response.cookies.get("sb-test-auth-token").value,"refreshed");
  assert.match(response.headers.get("cache-control"),/no-store/);
});
test("proxy returns 403 for unverified API access, 401 for expired sessions and passes verified users",async () => {
  let response=await updateSession(request("/api/voom/campaigns","POST"));
  assert.equal(response.status,403);assert.equal((await response.json()).error,"email_verification_required");
  user=null;response=await updateSession(request("/api/voom/campaigns","POST"));assert.equal(response.status,401);
  response=await updateSession(request("/app/plan"));assert.equal(new URL(response.headers.get("location")).searchParams.get("next"),"/app/plan");
  user=verified;response=await updateSession(request("/app/plan"));assert.equal(response.headers.get("x-middleware-next"),"1");
  assert.equal(response.cookies.get("sb-test-auth-token").value,"refreshed");
});
test("proxy rejects browser cross-site API writes even for a verified owner",async () => {
  user=verified;
  const response=await updateSession(request("/api/voom/campaigns","POST",{origin:"https://evil.test",host:"voom-real.vercel.app","sec-fetch-site":"cross-site"}));
  assert.equal(response.status,403);assert.equal((await response.json()).error,"invalid_origin");
});
test("machine exceptions do not require cookies or even call Supabase auth",async () => {
  for (const path of NON_SESSION_APIS) {
    const response=await updateSession(request(path));
    assert.equal(response.headers.get("x-middleware-next"),"1",path);
  }
  assert.deepEqual(calls,[]);
});
async function files(dir) {
  const found=[];
  for (const item of await readdir(new URL(`../${dir}`,import.meta.url),{withFileTypes:true})) {
    const path=`${dir}/${item.name}`;
    if(item.isDirectory())found.push(...await files(path));else if(item.name==="route.ts")found.push(path);
  }
  return found;
}
test("EVERY protected product API handler rejects unverified users without the proxy",async t => {
  for (const file of await files("app/api")) {
    const path=file.replace(/^app/,"").replace(/\/route.ts$/,"");
    if(authBoundary(path)!=="api")continue;
    await t.test(path,async () => {
      const route=await import(`../${file}`);
      for(const method of ["GET","POST","PATCH","PUT","DELETE"]) {
        if(typeof route[method]!=="function")continue;
        const response=await route[method](request(path,method),{params:Promise.resolve({id:verified.id,actionId:verified.id,assetId:verified.id})});
        assert.ok([401,403].includes(response.status) || (response.status>=300&&response.status<400&&new URL(response.headers.get("location")).pathname==="/login"),`${method} ${path}: ${response.status}`);
      }
    });
  }
});
test("onboarding/brand mutations cannot create profile/business rows before verification",async () => {
  const {saveOnboarding,saveBrandSettings,restartOnboarding,saveMediaSpendSettings}=await import("../lib/voom/mutations.ts");
  for(const mutation of [saveOnboarding,saveBrandSettings,restartOnboarding,saveMediaSpendSettings]) assert.equal((await mutation({})).ok,false);
});
test("provider callbacks still enforce state for verified users, without exchanging tokens on invalid state",async () => {
  user=verified;
  for(const provider of ["instagram","youtube","tiktok"]) {
    const {GET}=await import(`../app/api/integrations/${provider}/callback/route.ts`);
    const response=await GET(request(`/api/integrations/${provider}/callback?code=invalid&state=invalid`));
    assert.equal(new URL(response.headers.get("location")).pathname,`/app/${provider}`);
    assert.match(response.headers.get("location"),/invalid_state/);
  }
});
test("verification route accepts PKCE, rejects provider errors, and ignores arbitrary redirects",async () => {
  const {GET}=await import("../app/auth/callback/route.ts");user=verified;
  await redirected(() => GET(request("/auth/callback?code=code&next=https://evil.test")),"/verify-email/success?next=%2Fapp");
  assert.deepEqual(calls,["exchange","getUser"]);calls=[];
  await redirected(() => GET(request("/auth/callback?error=denied&error_description=do-not-echo")),"/verify-email?error=invalid_link");assert.deepEqual(calls,[]);
});
test("recovery callback stores only a short-lived code, strips URL, creates NO authenticated session",async () => {
  const {GET}=await import("../app/auth/recovery/route.ts");
  await redirected(() => GET(request("/auth/recovery?code=code&sb_flow_id=flow&next=//evil.test")),"/reset-password");
  const cookie=store.get("voom_recovery_code");assert.equal(cookie.httpOnly,true);assert.equal(cookie.maxAge,600);assert.deepEqual(JSON.parse(cookie.value),{code:"code",flowId:"flow"});assert.deepEqual(calls,[]);
  await redirected(() => GET(request("/auth/recovery?error=expired")),"/forgot-password?error=invalid_link");assert.equal(store.has("voom_recovery_code"),false);
});
test("resend/forgot action cooldown survives a second submission and does not send real mail",async () => {
  const {resendVerification,forgotPassword}=await import("../app/auth/actions.ts");
  const form=new FormData();form.set("email","owner@example.test");
  assert.equal((await resendVerification({},form)).retryAfter,60);
  assert.ok((await forgotPassword({},form)).retryAfter>0);assert.deepEqual(calls,["resend"]);
});
test("logout clears session chunks, PKCE and recovery cookies even if remote revocation returns an error",async () => {
  const {logout}=await import("../app/app/actions.ts");
  for(const name of ["sb-test-auth-token.0","sb-test-auth-token.1","sb-test-auth-token-code-verifier","voom_recovery_code"])store.set(name,{value:"secret"});
  globalThis.authClient.auth.signOut=async () => ({error:{message:"offline"}});
  await redirected(logout,"/login");assert.equal(store.size,0);
});
test("app layout uses authoritative guard; auth pages have no token rendering/logging",async () => {
  const layout=await readFile(new URL("../app/app/layout.tsx",import.meta.url),"utf8");
  assert.match(layout,/getAuthUser\(\)/);assert.match(layout,/!isVerifiedUser\(user\).*redirect\("\/verify-email"\)/);
  for(const path of ["app/auth/callback/route.ts","app/auth/recovery/route.ts","lib/auth/flows.ts"])assert.doesNotMatch(await readFile(new URL(`../${path}`,import.meta.url),"utf8"),/console\./);
});
