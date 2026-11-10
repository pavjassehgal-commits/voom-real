import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {test,before,after,beforeEach} from 'node:test';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';

const stub=code=>({url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true});
registerHooks({resolve(specifier,context,next){
  if(specifier==='next/headers')return stub('export async function headers(){return new Headers();}');
  if(specifier==='@/utils/supabase/admin')return stub('export function createAdminClient(){return globalThis.__limitTestClient;}');
  return next(specifier,context);
}});
const {allowAuthEmail}=await import('../lib/transactional-email/server.ts');
let db;
const originalSecret=process.env.VOOM_AUTH_EMAIL_SECRET, originalVercel=process.env.VERCEL;
before(async()=>{
  ({db}=await createSupabaseLite());
  process.env.VOOM_AUTH_EMAIL_SECRET='synthetic-test-secret-'.repeat(3);
  delete process.env.VERCEL;
  globalThis.__limitTestClient={rpc(_name,args){return {async abortSignal(){
    const r=await db.query('select public.consume_voom_auth_email_limit($1,$2) as allowed',[args.p_ip_hash,args.p_email_hash]);
    return {data:r.rows[0].allowed,error:null};
  }};}};
});
beforeEach(async()=>{await db.exec('truncate public.voom_auth_email_limits');});
after(async()=>{
  await db?.close();delete globalThis.__limitTestClient;
  if(originalSecret===undefined)delete process.env.VOOM_AUTH_EMAIL_SECRET;else process.env.VOOM_AUTH_EMAIL_SECRET=originalSecret;
  if(originalVercel===undefined)delete process.env.VERCEL;else process.env.VERCEL=originalVercel;
});
test('a full journey succeeds after multiple requests and link checks',async()=>{
  for(let i=0;i<3;i++)assert.equal(await allowAuthEmail('request','owner@example.test'),'allowed');
  for(let i=0;i<3;i++)assert.equal(await allowAuthEmail('recovery','synthetic-code-'+i),'allowed');
  assert.equal(await allowAuthEmail('password-update','synthetic-owner'),'allowed');
  assert.equal(await allowAuthEmail('request','owner@example.test'),'limited');
});
test('concurrent request attempts remain bounded and the update budget stays separate',async()=>{
  const results=await Promise.all(Array.from({length:8},()=>allowAuthEmail('request','owner@example.test')));
  assert.equal(results.filter(x=>x==='allowed').length,3);
  assert.equal(results.filter(x=>x==='limited').length,5);
  assert.equal(await allowAuthEmail('password-update','synthetic-owner'),'allowed');
});
test('shared global limit still stops distributed attempts',async()=>{
  // Distinct scoped IP hashes model distributed callers against the actual function.
  for(let i=0;i<30;i++){
    const ip=(i+1).toString(16).padStart(64,'0'),subject=(i+100).toString(16).padStart(64,'0');
    assert.equal((await db.query('select public.consume_voom_auth_email_limit($1,$2) as ok',[ip,subject])).rows[0].ok,true);
  }
  assert.equal(await allowAuthEmail('password-update','synthetic-owner'),'limited');
});
test('database failure fails closed as unavailable',async()=>{
  const client=globalThis.__limitTestClient;
  globalThis.__limitTestClient={rpc(){return {async abortSignal(){throw Error('private database details');}};}};
  try{assert.equal(await allowAuthEmail('request','owner@example.test'),'unavailable');}
  finally{globalThis.__limitTestClient=client;}
});
