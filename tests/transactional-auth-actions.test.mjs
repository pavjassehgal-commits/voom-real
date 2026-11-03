import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,beforeEach,after} from 'node:test';
const stub=code=>({url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true});
registerHooks({resolve(specifier,context,next){
  if(specifier==='next/server')return stub('export {};');
  if(specifier==='next/headers')return stub('export async function cookies(){return globalThis.__voomTxTest.jar;} export async function headers(){return new Headers({origin:"https://attacker.invalid"});}');
  if(specifier==='next/navigation')return stub('export function redirect(url){const e=new Error("redirect");e.destination=url;throw e;}');
  if(specifier==='@/utils/supabase/server')return stub('export async function createClient(){return globalThis.__voomTxTest.client;}');
  if(specifier==='@/lib/transactional-email/server')return stub('export async function allowAuthEmail(){return globalThis.__voomTxTest.allowed;} export async function queueWelcome(id){globalThis.__voomTxTest.welcomes.push(id);}');
  return next(specifier,context);
}});
const actions=await import('../app/forgot-password/actions.ts');
const {signup}=await import('../app/signup/actions.ts');
const {login}=await import('../app/login/actions.ts');
const {GET:callback}=await import('../app/auth/callback/route.ts');
const {recoveryProof}=await import('../lib/transactional-email/core.ts');
const originalSecret=process.env.VOOM_AUTH_EMAIL_SECRET,originalSite=process.env.NEXT_PUBLIC_SITE_URL;
let s;
beforeEach(()=>{
  process.env.VOOM_AUTH_EMAIL_SECRET='synthetic-action-test-secret-'.repeat(2);process.env.NEXT_PUBLIC_SITE_URL='https://staging.example.test';
  const values=new Map();s={calls:[],welcomes:[],allowed:true,values,updateError:null,userId:'owner',claimsSub:'owner',session:'session'};
  s.jar={get:name=>values.has(name)?{value:values.get(name)}:undefined,set:(name,value,options)=>{s.calls.push({name:'cookie',options});values.set(name,value);}};
  const call=async(name,args,result)=>{s.calls.push({name,args});return result;};
  s.client={auth:{
    resetPasswordForEmail:(...args)=>call('reset',args,{error:null}),resend:(...args)=>call('resend',args,{error:null}),
    exchangeCodeForSession:(...args)=>call('exchange',args,{data:{user:{id:s.userId}},error:null}),verifyOtp:(...args)=>call('verify',args,{data:{user:{id:s.userId}},error:null}),
    getUser:async()=>({data:{user:s.userId?{id:s.userId}:null},error:null}),getClaims:async()=>({data:{claims:{sub:s.claimsSub,session_id:s.session}},error:null}),
    updateUser:(...args)=>call('update',args,{error:s.updateError}),signOut:(...args)=>call('signout',args,{error:null}),
    signUp:(...args)=>call('signup',args,{data:{session:{user:{id:s.userId}}},error:null}),signInWithPassword:(...args)=>call('login',args,{data:{user:{id:s.userId}},error:null}),
  }};globalThis.__voomTxTest=s;
});
after(()=>{if(originalSecret===undefined)delete process.env.VOOM_AUTH_EMAIL_SECRET;else process.env.VOOM_AUTH_EMAIL_SECRET=originalSecret;if(originalSite===undefined)delete process.env.NEXT_PUBLIC_SITE_URL;else process.env.NEXT_PUBLIC_SITE_URL=originalSite;delete globalThis.__voomTxTest;});
const form=entries=>{const f=new FormData();for(const [key,value] of Object.entries(entries))f.set(key,value);return f;};
const redirectedTo=destination=>error=>error.destination===destination;
test('real reset and resend actions use trusted configured callback, not caller Origin',async()=>{
  await actions.requestPasswordReset({},form({email:'owner@example.test'}));assert.equal(s.calls[0].name,'reset');assert.equal(s.calls[0].args[1].redirectTo,'https://staging.example.test/auth/recovery');
  await actions.requestVerification({},form({email:'owner@example.test'}));assert.equal(s.calls[1].args[0].type,'signup');assert.equal(s.calls[1].args[0].options.emailRedirectTo,'https://staging.example.test/auth/callback?next=%2Fapp');
});
test('throttled real server action never invokes Supabase and does not reveal throttling',async()=>{
  s.allowed=false;const state=await actions.requestPasswordReset({},form({email:'owner@example.test'}));assert.equal(state.success,true);assert.equal(s.calls.length,0);
});
test('recovery rejects missing secret, both token formats, bad hash, unknown owner and mismatched claims',async()=>{
  for(const entry of [{},{code:'c',token_hash:'a'.repeat(64)},{token_hash:'invalid'}])assert.ok((await actions.continueRecovery({},form(entry))).error);
  assert.equal(s.calls.length,0);s.claimsSub='other';assert.ok((await actions.continueRecovery({},form({code:'code'}))).error);assert.equal(s.values.size,0);
});
test('recovery exchanges once and creates only an HttpOnly, session-bound ten-minute proof',async()=>{
  await assert.rejects(actions.continueRecovery({},form({code:'synthetic-code',sb_flow_id:'synthetic-flow'})),redirectedTo('/reset-password'));
  assert.equal(s.calls.filter(c=>c.name==='exchange').length,1);const cookie=s.calls.find(c=>c.name==='cookie');assert.equal(cookie.options.httpOnly,true);assert.equal(cookie.options.sameSite,'lax');assert.equal(cookie.options.path,'/reset-password');assert.equal(cookie.options.maxAge,600);
});
test('token-hash recovery fixes type to recovery and ignores any client-supplied type',async()=>{
  await assert.rejects(actions.continueRecovery({},form({token_hash:'a'.repeat(64),type:'signup'})),redirectedTo('/reset-password'));assert.equal(s.calls[0].name,'verify');assert.equal(s.calls[0].args[0].type,'recovery');
});
test('password update refuses unproved, other-session and mismatched-password requests',async()=>{
  const valid=form({password:'synthetic-password-123',confirmPassword:'synthetic-password-123'});
  assert.ok((await actions.changeRecoveredPassword({},valid)).error);
  s.values.set('voom_password_recovery',recoveryProof('owner','other-session',process.env.VOOM_AUTH_EMAIL_SECRET));assert.ok((await actions.changeRecoveredPassword({},valid)).error);
  assert.ok((await actions.changeRecoveredPassword({},form({password:'long-enough',confirmPassword:'different'}))).error);assert.equal(s.calls.filter(c=>c.name==='update').length,0);
});
test('successful password update preserves actual owner, clears proof and signs out this session',async()=>{
  s.values.set('voom_password_recovery',recoveryProof('owner','session',process.env.VOOM_AUTH_EMAIL_SECRET));
  await assert.rejects(actions.changeRecoveredPassword({},form({password:'synthetic-password-123',confirmPassword:'synthetic-password-123'})),redirectedTo('/login?notice=password_updated'));
  assert.equal(s.calls.filter(c=>c.name==='update').length,1);assert.deepEqual(s.calls.find(c=>c.name==='signout').args,[{scope:'local'}]);assert.equal(s.values.get('voom_password_recovery'),'');
});
test('failed password update shows no success and retains the recovery proof for explicit correction',async()=>{
  const proof=recoveryProof('owner','session',process.env.VOOM_AUTH_EMAIL_SECRET);s.values.set('voom_password_recovery',proof);s.updateError={message:'private provider details'};
  const state=await actions.changeRecoveredPassword({},form({password:'synthetic-password-123',confirmPassword:'synthetic-password-123'}));assert.ok(state.error);assert.doesNotMatch(state.error,/private provider/);assert.equal(s.values.get('voom_password_recovery'),proof);assert.equal(s.calls.some(c=>c.name==='signout'),false);
});
test('signup, login and callback enqueue only authenticated identity, never form-supplied owner',async()=>{
  await assert.rejects(signup({},form({email:'owner@example.test',password:'synthetic-password-123',confirmPassword:'synthetic-password-123',ownerId:'attacker'})),redirectedTo('/app/onboarding'));
  await assert.rejects(login({},form({email:'owner@example.test',password:'synthetic-password-123',ownerId:'attacker'})),redirectedTo('/app'));
  await assert.rejects(callback(new Request('https://staging.example.test/auth/callback?code=c&next=https://evil.test')),redirectedTo('/app'));
  assert.deepEqual(s.welcomes,['owner','owner','owner']);
});
