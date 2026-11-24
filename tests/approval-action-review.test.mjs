import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {registerHooks} from 'node:module';
const ID='11111111-1111-4111-8111-111111111111';
const OWNER='22222222-2222-4222-8222-222222222222';
const REVIEWED='2026-11-24T10:00:00.000Z';
registerHooks({resolve(s,c,next){
 const doubles={
  '@/lib/voom/server-data':'export async function getCurrentUser(){return globalThis.__actionReview.user}',
  '@/utils/supabase/server':'export async function createClient(){return globalThis.__actionReview.db}',
  '@/utils/supabase/admin':'export function createAdminClient(){return globalThis.__actionReview.db}',
  '@/lib/mara/tools':`export const APPROVAL_STALE='approval_stale',APPROVAL_INCOMPLETE='approval_incomplete';
    export async function executeConfirmedAction(c,a){return globalThis.__actionReview.execute(c,a)}`,
  '@/lib/voom/workflow/service':'export async function resyncWorkflowItem(){}',
  '@/lib/post/server-data':`export async function rejectPostDraft(){throw Error('unexpected rejection')}
    export async function reopenStaleDraftApproval(){globalThis.__actionReview.row.status='pending';globalThis.__actionReview.row.updated_at='2026-11-24T11:00:00.000Z';globalThis.__actionReview.row.new_value={contentVersion:2}}`,
 };
 return doubles[s]?{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(doubles[s])}:next(s,c);
}});
const {PATCH}=await import('../app/api/mara/actions/[id]/route.ts');
function fixture({status='pending',owner=OWNER,updated=REVIEWED}={}){
 const st={user:{id:OWNER},row:{id:ID,owner_user_id:owner,tool_name:'propose_calendar_item',status,updated_at:updated,sanitized_arguments:{sourceDraftId:ID,contentVersion:1},new_value:{contentVersion:1}},calls:0};
 class Query{
  constructor(table){this.table=table;this.filters=[];this.patch=null;}
  select(){return this;}eq(k,v){this.filters.push(r=>r[k]===v);return this;}in(k,v){this.filters.push(r=>v.includes(r[k]));return this;}
  update(v){this.patch=v;return this;}async maybeSingle(){return this.run();}async single(){return this.run();}
  run(){let row=this.table==='mara_pending_actions'?st.row:null;if(row&&!this.filters.every(f=>f(row)))row=null;if(row&&this.patch)Object.assign(row,this.patch);return {data:row?{...row}:null,error:null};}
  then(a,b){return Promise.resolve(this.run()).then(a,b);}
 }
 st.db={from(table){return new Query(table)}};
 st.execute=async(c,a)=>{assert.equal(c.ownerId,OWNER);assert.equal(a.status,'executing');st.calls++;st.row.status='confirmed';return {summary:'Confirmed reviewed version'}};
 globalThis.__actionReview=st;return st;
}
async function confirm(reviewedAt=REVIEWED,contentVersion=1){return PATCH(new Request('https://test.invalid/api/mara/actions/'+ID,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({decision:'confirm',reviewedAt,contentVersion})}),{params:Promise.resolve({id:ID})});}
test('missing card review token cannot claim or execute an approval',async()=>{const s=fixture();assert.equal((await confirm(null)).status,409);assert.equal(s.calls,0);assert.equal(s.row.status,'pending');});
test('proposal edited after the browser review requires another review',async()=>{const s=fixture({updated:'2026-11-24T10:01:00.000Z'});const r=await confirm();assert.equal(r.status,409);assert.equal(s.calls,0);assert.match((await r.json()).error,/changed|handled/);});
test('withdrawn and already-handled cards cannot be confirmed again',async()=>{for(const status of ['cancelled','confirmed','executing']){const s=fixture({status});assert.equal((await confirm()).status,409);assert.equal(s.calls,0);assert.equal(s.row.status,status);}});
test('owner isolation applies to the conditional claim',async()=>{const s=fixture({owner:'another-owner'});assert.equal((await confirm()).status,409);assert.equal(s.calls,0);});
test('matching reviewed card executes once; duplicate requests cannot execute it twice',async()=>{const s=fixture();assert.equal((await confirm()).status,200);assert.equal((await confirm()).status,409);assert.equal(s.calls,1);});
test('stale content returns a refreshed pending card and a conflict rather than approval',async()=>{const s=fixture();s.execute=async()=>{s.calls++;throw Error('approval_content_changed')};const r=await confirm();assert.equal(r.status,409);const body=await r.json();assert.match(body.error,/changed after/);assert.equal(body.action.new_value.contentVersion,2);assert.equal(body.action.status,'pending');});
test('expired approval returns an explicit rescheduling message and does not confirm',async()=>{const s=fixture();s.execute=async()=>{throw Error('approval_schedule_expired')};const r=await confirm();assert.equal(r.status,409);assert.match((await r.json()).error,/future time/);assert.equal(s.row.status,'failed');});

test('an exact card timestamp cannot substitute for the reviewed draft version',async()=>{const s=fixture();const r=await confirm(REVIEWED,99);assert.equal(r.status,409);assert.equal(s.calls,0);});
test('legacy non-Instagram cards return an editor-specific explanation before any version or confirmation write',async()=>{
 for(const kind of ['tiktok_video','youtube_video','email','linkedin_text','weekly_calendar']){
  const s=fixture();s.row.tool_name='approve_draft';s.row.sanitized_arguments={draftId:ID};
  const original=s.db.from.bind(s.db);
  s.db.from=(table)=>table==='mara_drafts'?{select(){return this},eq(){return this},async maybeSingle(){return{data:{kind},error:null}}}:original(table);
  const r=await confirm(REVIEWED,null);const body=await r.json();assert.equal(r.status,409);assert.equal(s.calls,0);assert(body.editorHref.startsWith('/app/'));assert.match(body.error,/editor|legacy/i);assert.notEqual(body.error,'This approval is no longer available.');
 }
});
