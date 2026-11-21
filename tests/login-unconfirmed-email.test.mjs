/**
 * Login for an account whose email address is not confirmed yet (2026-11-21).
 *
 * Supabase Auth answers signInWithPassword with code `email_not_confirmed` only
 * after it has verified the password. Voom shows a fixed "please confirm your
 * email" message with a link to /verify-email for that code alone. Every other
 * failure keeps the single generic "Incorrect email or password." message, and
 * provider text never reaches the page.
 *
 * This file drives the REAL server action with the Next runtime and the Supabase
 * client doubled. tests/login-unconfirmed-email-render.test.mjs renders the real
 * alert markup.
 */
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,beforeEach,after} from 'node:test';

const stub=code=>({url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true});
registerHooks({resolve(specifier,context,next){
  if(specifier==='next/navigation')return stub('export function redirect(url){const e=new Error("redirect");e.destination=url;throw e;}');
  if(specifier==='@/utils/supabase/server')return stub('export async function createClient(){return globalThis.__voomLoginTest.client;}');
  if(specifier==='@/lib/transactional-email/server')return stub('export async function queueWelcome(id){globalThis.__voomLoginTest.welcomes.push(id);}');
  return next(specifier,context);
}});

const {login}=await import('../app/login/actions.ts');
const {EMAIL_NOT_CONFIRMED_MESSAGE,INVALID_LOGIN_MESSAGE}=await import('../app/login/messages.ts');

let s;
beforeEach(()=>{
  s={calls:[],welcomes:[],result:{data:{user:{id:'owner'}},error:null}};
  s.client={auth:{signInWithPassword:async(args)=>{s.calls.push(args);return s.result;}}};
  globalThis.__voomLoginTest=s;
});
after(()=>{delete globalThis.__voomLoginTest;});

const form=entries=>{const f=new FormData();for(const [key,value] of Object.entries(entries))f.set(key,value);return f;};
const credentials={email:'owner@example.test',password:'synthetic-password'};
// Shaped like @supabase/auth-js AuthApiError: a status, a stable code and provider text.
const authError=(code,message='Provider detail that must never be shown',status=400)=>Object.assign(new Error(message),{name:'AuthApiError',status,code,__isAuthError:true});

test('email_not_confirmed returns the confirm-your-email message and the verify flag, without signing in',async()=>{
  s.result={data:{user:null,session:null},error:authError('email_not_confirmed','Email not confirmed')};
  const state=await login({},form(credentials));
  assert.deepEqual(state,{formError:EMAIL_NOT_CONFIRMED_MESSAGE,unconfirmed:true});
  assert.equal(s.calls.length,1);
  assert.deepEqual(s.welcomes,[],'no welcome email is queued for an unconfirmed login');
});

test('the unconfirmed message is fixed copy: no address, no provider text, and it points at confirming',async()=>{
  assert.match(EMAIL_NOT_CONFIRMED_MESSAGE,/confirm your email/i);
  assert.match(EMAIL_NOT_CONFIRMED_MESSAGE,/request a new one/i);
  assert.doesNotMatch(EMAIL_NOT_CONFIRMED_MESSAGE,/owner@example\.test|Email not confirmed/);
});

test('invalid credentials keep the single generic message and no verify flag',async()=>{
  s.result={data:{user:null,session:null},error:authError('invalid_credentials','Invalid login credentials')};
  const state=await login({},form(credentials));
  assert.deepEqual(state,{formError:INVALID_LOGIN_MESSAGE});
  assert.equal(INVALID_LOGIN_MESSAGE,'Incorrect email or password.');
});

for(const [label,error] of [
  ['an unknown code',authError('unexpected_failure')],
  ['a banned user',authError('user_banned')],
  ['rate limiting',authError('over_request_rate_limit','Too many requests',429)],
  ['an error with no code',Object.assign(new Error('Email not confirmed'),{status:400})],
  ['a non-string code',authError(['email_not_confirmed'])],
  ['a near-miss code',authError('EMAIL_NOT_CONFIRMED')],
]) {
  test(`${label} falls back to the generic message and never echoes provider text`,async()=>{
    s.result={data:{user:null,session:null},error};
    const state=await login({},form(credentials));
    assert.deepEqual(state,{formError:INVALID_LOGIN_MESSAGE});
    assert.ok(!JSON.stringify(state).includes(error.message));
  });
}

test('a successful login still redirects to /app and queues the welcome check',async()=>{
  await assert.rejects(login({},form(credentials)),error=>error.destination==='/app');
  assert.deepEqual(s.calls,[credentials]);
  assert.deepEqual(s.welcomes,['owner']);
});

test('missing fields are rejected before Supabase is called',async()=>{
  const state=await login({},form({email:'  ',password:''}));
  assert.deepEqual(state.fieldErrors,{email:'Enter your email address.',password:'Enter your password.'});
  assert.equal(state.formError,undefined);
  assert.equal(s.calls.length,0);
});

test('the address is trimmed and sent to Supabase unchanged otherwise',async()=>{
  s.result={data:{user:null,session:null},error:authError('email_not_confirmed')};
  await login({},form({email:'  Owner@Example.test ',password:'synthetic-password'}));
  assert.deepEqual(s.calls,[{email:'Owner@Example.test',password:'synthetic-password'}]);
});
