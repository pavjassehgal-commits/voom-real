import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

// Exercise the real authenticated HTTP boundary with no database/provider I/O.
registerHooks({ resolve(specifier, context, next) {
  const modules = {
    '@/lib/youtube/reconcile': 'export async function runYouTubeReconciliation(options){return globalThis.__complianceCron.reconcile(options)}',
    '@/lib/youtube/privacy': 'export async function runYouTubePrivacyMaintenance(){return globalThis.__complianceCron.privacy()}',
    '@/lib/youtube/upload-server': 'export async function cleanupYouTubeUploads(db){return globalThis.__complianceCron.cleanup(db)}',
    '@/utils/supabase/admin': 'export function createAdminClient(){return globalThis.__complianceCron.admin()}',
  };
  if (modules[specifier]) return {shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(modules[specifier])};
  return next(specifier,context);
} });
const { GET, POST, maxDuration } = await import('../app/api/cron/youtube-reconcile/route.ts');

function fixture(t, options={}) {
  const oldSecret=process.env.CRON_SECRET, oldFetch=globalThis.fetch;
  process.env.CRON_SECRET='synthetic-cron-secret';
  const state={now:1000,calls:[],budget:null};
  const db={synthetic:true};
  t.mock.method(Date,'now',()=>state.now);
  globalThis.fetch=async()=>{throw Error('External I/O forbidden');};
  globalThis.__complianceCron={
    async privacy(){
      state.calls.push('privacy');state.now+=12000;
      if(options.privacyFailure)throw Error('private-internal-detail');
      return {erased:0,verified:0,revocations:null,operatorAttention:options.attention===true};
    },
    async reconcile(input){state.calls.push('reconcile');state.budget=input.pollingBudgetMs;return {published:0,claimed:0};},
    admin(){state.calls.push('admin');return db;},
    async cleanup(value){
      state.calls.push('cleanup');assert.equal(value,db);
      if(options.cleanupFailure)throw Error('private-storage-detail');
      return {checked:0,removed:0};
    },
  };
  t.after(()=>{
    if(oldSecret===undefined)delete process.env.CRON_SECRET;else process.env.CRON_SECRET=oldSecret;
    globalThis.fetch=oldFetch;delete globalThis.__complianceCron;
  });
  return state;
}
const request=(authorization='Bearer synthetic-cron-secret')=>new Request('https://synthetic.invalid/api/cron/youtube-reconcile',{headers:{authorization}});

test('unauthenticated or unconfigured cron cannot create clients or perform any work',async t=>{
  const state=fixture(t);
  assert.equal((await GET(request('Bearer wrong'))).status,401);
  delete process.env.CRON_SECRET;
  assert.equal((await GET(request())).status,503);
  assert.deepEqual(state.calls,[]);
});
test('privacy and existing upload cleanup share the authenticated reconciliation cadence and budget',async t=>{
  const state=fixture(t);
  const response=await GET(request()),body=await response.json();
  assert.equal(response.status,200);assert.equal(maxDuration,300);assert.equal(POST,GET);
  assert.equal(state.budget,228000,'maintenance does not get an additional reconciliation budget');
  assert.deepEqual(state.calls,['privacy','reconcile','admin','cleanup']);
  assert.deepEqual(body.uploadCleanup,{checked:0,removed:0});
  assert.equal(response.headers.get('cache-control'),'no-store');
});
test('expired/overdue privacy work reports attention but retains unrelated reconciliation and cleanup',async t=>{
  const state=fixture(t,{attention:true});
  const response=await GET(request());
  assert.equal(response.status,503);assert.equal((await response.json()).privacy.operatorAttention,true);
  assert.deepEqual(state.calls,['privacy','reconcile','admin','cleanup']);
});
test('retention failure stops provider reconciliation and returns no internal error detail',async t=>{
  const state=fixture(t,{privacyFailure:true});
  const response=await GET(request());
  assert.equal(response.status,503);assert.deepEqual(state.calls,['privacy']);
  assert.doesNotMatch(await response.text(),/private-internal-detail/);
});
test('upload cleanup uncertainty is deferred without changing reconciliation or deleting media',async t=>{
  const state=fixture(t,{cleanupFailure:true});
  const response=await GET(request()),body=await response.json();
  assert.equal(response.status,200);assert.deepEqual(body.uploadCleanup,{deferred:true});
  assert.deepEqual(state.calls,['privacy','reconcile','admin','cleanup']);
  assert.doesNotMatch(JSON.stringify(body),/private-storage-detail/);
});
