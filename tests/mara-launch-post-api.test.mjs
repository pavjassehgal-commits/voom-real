import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
const ID='33333333-3333-4333-8333-333333333333';
registerHooks({resolve(s,c,next){
  const doubles={
    '@/lib/voom/server-data':'export async function getCurrentUser(){return globalThis.__launchPost.user}',
    '@/utils/supabase/admin':'export function createAdminClient(){return globalThis.__launchPost.db}',
    '@/lib/post/server-data':`export const APPROVAL_CONTENT_CHANGED='approval_content_changed';
      export function normalizeMediaBrief(v){return v?.trim()||null}
      export async function getPostDraft(db,owner,id){return globalThis.__launchPost.read(owner,id)}
      export async function savePostDraft(db,owner,id,patch){return globalThis.__launchPost.save(owner,id,patch)}
      export async function approvePostDraft(){throw Error('No approval in save tests')}
      export async function rejectPostDraft(){throw Error('No rejection in save tests')}`,
  };
  return doubles[s]?{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(doubles[s])}:next(s,c);
}});
const {GET,PATCH}=await import('../app/api/posts/[id]/route.ts');
globalThis.fetch=async()=>{throw new Error('External HTTP forbidden in post save tests')};
const params={params:Promise.resolve({id:ID})};
function fixture(){
  const state={user:{id:'owner'},reads:0,writes:0,post:{id:ID,status:'draft',caption:'Original',concept:'Original concept',hashtags:['Original'],visual:{id:'private-asset'},contentVersion:1}};
  state.db={from(){state.reads++;const q={select:()=>q,eq:()=>q,maybeSingle:async()=>({data:{kind:'instagram_post'},error:null})};return q}};
  state.read=(owner,id)=>owner==='owner'&&id===ID?state.post:null;
  state.save=(owner,id,patch)=>{assert.equal(owner,'owner');assert.equal(id,ID);state.writes++;for(const [k,v]of Object.entries(patch))if(v!==undefined)state.post[k]=v;return state.post};
  globalThis.__launchPost=state;return state;
}
const request=body=>new Request('https://test.invalid/api/posts/'+ID,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
test('double-encoded JSON, null and arrays fail with 400 instead of crashing or touching a draft',async()=>{
  const s=fixture();for(const body of [JSON.stringify({action:'save',caption:'Changed'}),null,[],42]){assert.equal((await PATCH(request(body),params)).status,400)}assert.equal(s.writes,0);assert.equal(s.reads,0);
});
test('a single JSON object preserves structured hashtags and existing media through save and reload',async()=>{
  const s=fixture(),body={action:'save',caption:'Edited customer caption',concept:'Updated concept',cta:'Visit us',hashtags:['Coffee','Dubai'],format:'4:5',scheduledAt:null,brief:'A warm café photo'};
  const r=await PATCH(request(body),params);assert.equal(r.status,200);assert.equal(s.writes,1);
  const reload=await GET(new Request('https://test.invalid'),params),{post}=await reload.json();
  for(const key of ['caption','concept','cta','hashtags','format'])assert.deepEqual(post[key],body[key]);assert.deepEqual(post.visual,{id:'private-asset'});assert(Array.isArray(post.hashtags));
});
test('saving still requires the authenticated owner; malformed bodies cannot bypass authentication',async()=>{
  const s=fixture();s.user=null;assert.equal((await PATCH(request({action:'save',caption:'Forged'}),params)).status,401);assert.equal(s.writes,0);
});
