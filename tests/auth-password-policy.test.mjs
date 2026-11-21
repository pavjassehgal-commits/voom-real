/**
 * Password rule and weak-password handling (auth security hardening, 2026-11-21).
 *
 * Supabase Auth checks password strength (minimum length, optional character
 * rules and, when enabled, leaked-password protection) BEFORE it looks up the
 * address, and rejects anything over 72 BYTES with validation_failed. Voom's
 * forms therefore enforce the same 8-character / 72-byte rule up front, and
 * signup shows a fixed message for `weak_password`, which is the same whether or
 * not an account exists. Anti-enumeration (user_already_exists looks like
 * success), generic fallbacks and the recovery proof are unchanged.
 *
 * This drives the REAL server actions with the Next runtime and Supabase client
 * doubled.
 */
import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,beforeEach,after} from 'node:test';
const stub=code=>({url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true});
registerHooks({resolve(specifier,context,next){
  if(specifier==='next/server')return stub('export {};');
  if(specifier==='next/headers')return stub('export async function cookies(){return globalThis.__voomPwTest.jar;} export async function headers(){return new Headers({origin:"https://attacker.invalid"});}');
  if(specifier==='next/navigation')return stub('export function redirect(url){const e=new Error("redirect");e.destination=url;throw e;}');
  if(specifier==='@/utils/supabase/server')return stub('export async function createClient(){return globalThis.__voomPwTest.client;}');
  if(specifier==='@/lib/transactional-email/server')return stub('export async function allowAuthEmail(){return "allowed";} export async function queueWelcome(id){globalThis.__voomPwTest.welcomes.push(id);}');
  return next(specifier,context);
}});
const policy=await import('../lib/auth/password-policy.ts');
const {signup}=await import('../app/signup/actions.ts');
const {login}=await import('../app/login/actions.ts');
const reset=await import('../app/forgot-password/actions.ts');
const {recoveryProof}=await import('../lib/transactional-email/core.ts');
const originalSecret=process.env.VOOM_AUTH_EMAIL_SECRET,originalSite=process.env.NEXT_PUBLIC_SITE_URL;
let s;
beforeEach(()=>{
  process.env.VOOM_AUTH_EMAIL_SECRET='synthetic-password-policy-secret-'.repeat(2);process.env.NEXT_PUBLIC_SITE_URL='https://voom.today';
  const values=new Map();
  s={calls:[],welcomes:[],values,signUpResult:{data:{user:{id:'new'},session:null},error:null},signInResult:{data:{user:{id:'owner'}},error:null},updateError:null};
  s.jar={get:name=>values.has(name)?{value:values.get(name)}:undefined,set:(name,value)=>{values.set(name,value);}};
  const call=async(name,args,result)=>{s.calls.push({name,args});return result;};
  s.client={auth:{
    signUp:(...args)=>call('signup',args,s.signUpResult),
    signInWithPassword:(...args)=>call('login',args,s.signInResult),
    getUser:async()=>({data:{user:{id:'owner'}},error:null}),
    getClaims:async()=>({data:{claims:{sub:'owner',session_id:'session'}},error:null}),
    updateUser:(...args)=>call('update',args,{error:s.updateError}),
    signOut:(...args)=>call('signout',args,{error:null}),
  }};
  globalThis.__voomPwTest=s;
});
after(()=>{if(originalSecret===undefined)delete process.env.VOOM_AUTH_EMAIL_SECRET;else process.env.VOOM_AUTH_EMAIL_SECRET=originalSecret;if(originalSite===undefined)delete process.env.NEXT_PUBLIC_SITE_URL;else process.env.NEXT_PUBLIC_SITE_URL=originalSite;delete globalThis.__voomPwTest;});
const form=entries=>{const f=new FormData();for(const [k,v] of Object.entries(entries))f.set(k,v);return f;};
// Shaped like @supabase/auth-js AuthApiError / AuthWeakPasswordError.
const authError=(code,message='Provider detail that must never be shown',extra={})=>Object.assign(new Error(message),{name:'AuthApiError',status:422,code,__isAuthError:true},extra);
const signupForm=(password='synthetic-passphrase-1')=>form({email:'owner@example.test',password,confirmPassword:password});

// ── The shared rule ──────────────────────────────────────────────────────────
test('the rule is at least 8 Unicode characters and at most 72 UTF-8 bytes, with no character-class rules',()=>{
  const e=policy.passwordPolicyError;
  assert.equal(e(''),policy.PASSWORD_TOO_SHORT_MESSAGE);
  assert.equal(e('a'.repeat(7)),policy.PASSWORD_TOO_SHORT_MESSAGE);
  assert.equal(e('a'.repeat(8)),undefined,'eight lowercase letters are allowed: no complexity rules');
  assert.equal(e('a'.repeat(72)),undefined,'72 ASCII characters = 72 bytes');
  assert.equal(e('a'.repeat(73)),policy.PASSWORD_TOO_LONG_MESSAGE,'Supabase rejects more than 72 bytes');
  assert.equal(e('😀'.repeat(7)),policy.PASSWORD_TOO_SHORT_MESSAGE,'7 emoji are 7 characters (14 UTF-16 units), as Supabase counts');
  assert.equal(e('😀'.repeat(8)),undefined,'8 emoji = 8 characters, 32 bytes');
  assert.equal(e('é'.repeat(36)),undefined,'36 × 2 bytes = 72 bytes');
  assert.equal(e('é'.repeat(37)),policy.PASSWORD_TOO_LONG_MESSAGE,'37 accented letters are 74 bytes');
  assert.equal(policy.PASSWORD_MIN_CHARACTERS,8);assert.equal(policy.PASSWORD_MAX_BYTES,72);
});
test('only the exact weak_password code is treated as a weak password',()=>{
  assert.equal(policy.isWeakPasswordError(authError('weak_password')),true);
  for(const value of [authError('WEAK_PASSWORD'),authError('validation_failed'),authError(['weak_password']),new Error('weak_password'),null,undefined,'weak_password',{code:'weak_password_x'}])
    assert.equal(policy.isWeakPasswordError(value),false);
});
test('the weak-password message is fixed copy, says what to do, and contains no provider wording',()=>{
  assert.match(policy.WEAK_PASSWORD_MESSAGE,/too weak/);assert.match(policy.WEAK_PASSWORD_MESSAGE,/known data breach/);assert.match(policy.WEAK_PASSWORD_MESSAGE,/Choose a different one/);
  assert.doesNotMatch(policy.WEAK_PASSWORD_MESSAGE,/HaveIBeenPwned|pwned|Supabase|reasons/i);
});

// ── Signup ───────────────────────────────────────────────────────────────────
test('signup: Supabase weak_password becomes a password field error, never provider text or reasons',async()=>{
  s.signUpResult={data:{user:null,session:null},error:authError('weak_password','Password is known to be weak and easy to guess, please choose a different one.',{reasons:['pwned']})};
  const state=await signup({},signupForm());
  assert.deepEqual(state,{fieldErrors:{password:policy.WEAK_PASSWORD_MESSAGE}});
  assert.ok(!JSON.stringify(state).includes('easy to guess'));assert.ok(!JSON.stringify(state).includes('pwned'));
  assert.equal(s.calls.length,1);assert.deepEqual(s.welcomes,[]);
});
test('signup: an existing account still looks exactly like a new one (anti-enumeration unchanged)',async()=>{
  s.signUpResult={data:{user:null,session:null},error:authError('user_already_exists','User already registered')};
  assert.deepEqual(await signup({},signupForm()),{success:true});
  s.signUpResult={data:{user:{id:'new'},session:null},error:null};
  assert.deepEqual(await signup({},signupForm()),{success:true},'a normal unconfirmed signup gives the same answer');
});
test('signup: every other provider failure keeps the generic message',async()=>{
  for(const code of ['validation_failed','over_email_send_rate_limit','unexpected_failure',undefined]){
    s.signUpResult={data:{user:null,session:null},error:authError(code)};
    const state=await signup({},signupForm());
    assert.deepEqual(state,{formError:"We couldn't create your account. Please try again."},String(code));
  }
});
test('signup: a password over 72 bytes, or under 8 characters, is rejected before Supabase is called',async()=>{
  for(const [password,message] of [['a'.repeat(73),policy.PASSWORD_TOO_LONG_MESSAGE],['é'.repeat(37),policy.PASSWORD_TOO_LONG_MESSAGE],['short',policy.PASSWORD_TOO_SHORT_MESSAGE],['😀'.repeat(7),policy.PASSWORD_TOO_SHORT_MESSAGE]]){
    const state=await signup({},signupForm(password));
    assert.equal(state.fieldErrors.password,message);
  }
  assert.equal(s.calls.length,0);
});
test('signup: a normal signup still sends the trusted callback and, with a session, goes to onboarding',async()=>{
  assert.deepEqual(await signup({},signupForm()),{success:true});
  const [args]=s.calls[0].args;assert.equal(args.email,'owner@example.test');assert.equal(args.password,'synthetic-passphrase-1');
  assert.equal(args.options.emailRedirectTo,'https://voom.today/auth/callback?next=%2Fapp&flow=signup','the site URL, never the caller Origin');
  s.signUpResult={data:{user:{id:'new'},session:{user:{id:'new'}}},error:null};
  await assert.rejects(signup({},signupForm()),error=>error.destination==='/app/onboarding');
  assert.deepEqual(s.welcomes,['new']);
});
test('signup: mismatched confirmation and a bad address are still caught first',async()=>{
  const state=await signup({},form({email:'not-an-address',password:'synthetic-passphrase-1',confirmPassword:'different-passphrase'}));
  assert.equal(state.fieldErrors.email,'Enter a valid email address.');assert.equal(state.fieldErrors.confirmPassword,'Passwords do not match.');
  assert.equal(s.calls.length,0);
});

// ── Login (unchanged behaviour) ──────────────────────────────────────────────
test('login: invalid credentials still get only the generic message',async()=>{
  s.signInResult={data:{user:null,session:null},error:authError('invalid_credentials','Invalid login credentials')};
  assert.deepEqual(await login({},form({email:'owner@example.test',password:'wrong-password'})),{formError:'Incorrect email or password.'});
});

// ── Password reset ───────────────────────────────────────────────────────────
const resetWith=async(password)=>{s.values.set('voom_password_recovery',recoveryProof('owner','session',process.env.VOOM_AUTH_EMAIL_SECRET));return reset.changeRecoveredPassword({},form({password,confirmPassword:password}));};
test('reset: the same 8-character / 72-byte rule applies before Supabase is called',async()=>{
  assert.deepEqual(await resetWith('a'.repeat(73)),{error:policy.PASSWORD_TOO_LONG_MESSAGE});
  assert.deepEqual(await resetWith('😀'.repeat(7)),{error:policy.PASSWORD_TOO_SHORT_MESSAGE});
  assert.equal(s.calls.length,0);
});
test('reset: weak_password uses the shared message; reauthentication_needed asks for a new link; the proof is kept',async()=>{
  for(const [code,expected] of [['weak_password',policy.WEAK_PASSWORD_MESSAGE],['reauthentication_needed','This reset session has expired. Request a new password-reset link.']]){
    s.calls.length=0;s.updateError=authError(code);
    const proof=recoveryProof('owner','session',process.env.VOOM_AUTH_EMAIL_SECRET);s.values.set('voom_password_recovery',proof);
    const state=await reset.changeRecoveredPassword({},form({password:'synthetic-passphrase-1',confirmPassword:'synthetic-passphrase-1'}));
    assert.deepEqual(state,{error:expected},code);
    assert.equal(s.values.get('voom_password_recovery'),proof);assert.equal(s.calls.some(c=>c.name==='signout'),false);
  }
});
test('reset: a 72-byte password is accepted and still signs out every session',async()=>{
  await assert.rejects(resetWith('a'.repeat(72)),error=>error.destination==='/login?notice=password_updated');
  assert.deepEqual(s.calls.filter(c=>c.name==='signout').map(c=>c.args[0]),[{scope:'global'}]);
});

// ── Overlong passwords are refused, never shortened ──────────────────────────
// A browser `maxLength` silently cuts a PASTED value. A long generated password
// pasted into both fields would be cut identically, the account would get the
// shortened password, and the full one (in the password manager) would then fail
// at login. So the inputs carry no maxLength and the server refuses an overlong
// password with a clear message instead.
const GENERATED_100='Xk9#'.repeat(25); // a 100-character generated password, as a manager might paste it
test('signup: a pasted 100-character password is refused with the clear "too long" message, never shortened and sent',async()=>{
  const state=await signup({},signupForm(GENERATED_100));
  assert.deepEqual(state,{fieldErrors:{password:policy.PASSWORD_TOO_LONG_MESSAGE}});
  assert.match(policy.PASSWORD_TOO_LONG_MESSAGE,/too long/);assert.match(policy.PASSWORD_TOO_LONG_MESSAGE,/72 characters/);
  assert.equal(s.calls.length,0,'nothing, shortened or not, reaches Supabase');
});
test('reset: a pasted 100-character password is refused with the same message, and the recovery proof is kept for a retry',async()=>{
  const proof=recoveryProof('owner','session',process.env.VOOM_AUTH_EMAIL_SECRET);s.values.set('voom_password_recovery',proof);
  assert.deepEqual(await reset.changeRecoveredPassword({},form({password:GENERATED_100,confirmPassword:GENERATED_100})),{error:policy.PASSWORD_TOO_LONG_MESSAGE});
  assert.equal(s.calls.length,0);assert.equal(s.values.get('voom_password_recovery'),proof);
});
test('the 72-byte rule is enforced only on the server: no password input has a maxLength that could truncate',async()=>{
  const {readFile}=await import('node:fs/promises');const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8');
  const sources={'app/signup/SignupForm.tsx':await read('app/signup/SignupForm.tsx'),'components/voom/auth/AccountEmailForm.tsx':await read('components/voom/auth/AccountEmailForm.tsx')};
  for(const [file,source] of Object.entries(sources)){
    const passwordInputs=[...source.matchAll(/<input\b[^>]*?name="(?:password|confirmPassword)"[\s\S]*?\/>/g)].map(m=>m[0]);
    assert.equal(passwordInputs.length,2,`${file} has a password and a confirmation input`);
    for(const input of passwordInputs){assert.doesNotMatch(input,/maxLength/,file);assert.match(input,/minLength=\{8\}/,file);}
  }
});
