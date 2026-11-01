import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const {deriveWorkflowStatus}=await import('../lib/voom/workflow/state.ts');
const {planItemActions}=await import('../lib/voom/workflow/next-actions.ts');
const {buildTodayView}=await import('../lib/voom/today-view.ts');
const {loadTodayScheduledItems}=await import('../lib/voom/today-schedule.ts');
const {postApprovalMessage}=await import('../lib/post/approval-message.ts');

const OWNER='owner-synthetic',OTHER='other-owner';
function fixture(){
  const tables=new Map(),reads=[];
  for(const channel of ['instagram','tiktok','youtube','linkedin']){
    tables.set(channel+'_publish_queue',[]);tables.set(channel+'_connections',[{owner_user_id:OWNER,status:'connected',scopes:['instagram_business_content_publish','video.publish','https://www.googleapis.com/auth/youtube.upload','w_member_social']}]);
  }
  tables.set('mara_drafts',[]);tables.set('post_draft_assets',[]);
  let failure=null;
  const db={from(table){const filters=[];const q={
    select(){return q},eq(k,v){filters.push(r=>r[k]===v);reads.push([table,k,v]);return q},in(k,v){filters.push(r=>v.includes(r[k]));return q},gte(k,v){filters.push(r=>r[k]>=v);return q},lt(k,v){filters.push(r=>r[k]<v);return q},
    result(){return {data:(tables.get(table)||[]).filter(r=>filters.every(f=>f(r))),error:failure===table?{code:'unavailable'}:null}},
    async maybeSingle(){const r=q.result();return {...r,data:r.data[0]||null}},then(ok,bad){return Promise.resolve(q.result()).then(ok,bad)},
  };return q}};
  function seed(channel,id='draft-'+channel){
    const kind={instagram:'instagram_post',tiktok:'tiktok_video',youtube:'youtube_short',linkedin:'linkedin_text'}[channel];
    const draft={id,owner_user_id:OWNER,title:channel+' original',content:'Text',kind,status:'approved',content_version:2,approved_content_version:2};tables.get('mara_drafts').push(draft);
    const job={id:'job-'+id,owner_user_id:OWNER,draft_id:id,status:'scheduled',scheduled_at:'2026-11-01T14:30:00Z',approved_content_version:2};tables.get(channel+'_publish_queue').push(job);
    tables.get('post_draft_assets').push({owner_user_id:OWNER,draft_id:id,status:'uploaded',storage_path:OWNER+'/'+id+'.mp4'});
    return {draft,job};
  }
  return {db,tables,reads,seed,fail:t=>failure=t};
}
const facts={draftStatus:'approved',hasMedia:false,mediaStatus:null,publishStatus:null,awaitingApproval:false,connectionReady:false,publishAt:'2099-11-01T12:00:00Z'};
test('approved without media/connection/job is never Scheduled; each actual missing prerequisite has a truthful next action',()=>{
  assert.equal(deriveWorkflowStatus(facts),'needs_content');
  const production=planItemActions({contentType:'post',stage:'needs_content',failedStage:null,mode:'assisted',publishAt:facts.publishAt,hasMedia:false});
  assert(production.actions.some(a=>a.id==='produce_with_mara'));assert(production.actions.some(a=>a.id==='upload_asset'));assert(!production.actions.some(a=>a.id==='approve_schedule'));
  assert.equal(deriveWorkflowStatus({...facts,hasMedia:true}),'needs_connection');
  const connection=planItemActions({contentType:'post',stage:'needs_connection',failedStage:null,mode:'assisted',publishAt:facts.publishAt,hasMedia:true});assert.equal(connection.actions[0].id,'connect_channel');
  assert.equal(deriveWorkflowStatus({...facts,hasMedia:true,connectionReady:true}),'ready_to_schedule');
  assert.equal(deriveWorkflowStatus({...facts,hasMedia:true,connectionReady:true,publishStatus:'scheduled'}),'scheduled');
  assert.notEqual(deriveWorkflowStatus({...facts,hasMedia:true,connectionReady:true,publishStatus:'scheduled',approvalValid:false}),'scheduled');
});
test('approval messages never promise publishing without a confirmed executable job',async()=>{
  const f=fixture(),p={id:'draft',status:'approved',visualReady:false};
  assert.match(await postApprovalMessage(f.db,OWNER,p),/missing media/);
  f.tables.set('instagram_connections',[]);assert.match(await postApprovalMessage(f.db,OWNER,{...p,visualReady:true}),/Connect Instagram/);
  assert.doesNotMatch(await postApprovalMessage(f.db,OWNER,{...p,visualReady:true}),/automatically publish|Approved and scheduled/);
  assert.match(await postApprovalMessage(f.db,OWNER,{...p,status:'draft'}),/not currently approved/);
});
test('Today counts persisted eligible jobs on all four channels, including standalone drafts, once only',async()=>{
  const f=fixture();for(const c of ['instagram','tiktok','youtube','linkedin'])f.seed(c);
  f.tables.get('instagram_publish_queue').push({...f.tables.get('instagram_publish_queue')[0]});
  const items=await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai');assert.equal(items.length,4);
  assert.deepEqual(new Set(items.map(i=>i.channelLabel)),new Set(['Instagram','TikTok','YouTube','LinkedIn']));
  assert(f.reads.filter(([,key])=>key==='owner_user_id').every(([, ,value])=>value===OWNER));
});
test('approval, rejection, cancellation, rescheduling, stale versions, missing media and disconnect immediately change Today counts on a fresh read',async()=>{
  const f=fixture(),{draft,job}=f.seed('instagram');
  const count=async()=> (await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai')).length;
  assert.equal(await count(),1);
  for(const s of ['waiting_for_media','cancelled','failed','published']){job.status=s;assert.equal(await count(),0,s)}job.status='scheduled';
  for(const s of ['draft','rejected']){draft.status=s;assert.equal(await count(),0,s)}draft.status='approved';
  draft.content_version++;assert.equal(await count(),0);draft.approved_content_version=draft.content_version;
  job.scheduled_at='2026-11-02T14:30:00Z';const rescheduled=await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai');assert.equal(rescheduled[0].localDate,'2026-11-02');
  f.tables.set('post_draft_assets',[]);assert.equal(await count(),0);
});
test('cross-owner rows, wrong-channel drafts, missing permissions and read errors cannot inflate the count',async()=>{
  const f=fixture(),{draft,job}=f.seed('linkedin');
  job.owner_user_id=OTHER;assert.equal((await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai')).length,0);job.owner_user_id=OWNER;
  draft.kind='youtube_video';assert.equal((await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai')).length,0);draft.kind='linkedin_text';
  f.tables.get('linkedin_connections')[0].scopes=[];assert.equal((await loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai')).length,0);
  f.fail('linkedin_publish_queue');await assert.rejects(loadTodayScheduledItems(f.db,OWNER,'2026-11-01','Asia/Dubai'),/today_schedule_read_failed/);
});
test('Today deduplicates coordinator plan identities but never counts projections as scheduled',()=>{
  const item={draftId:'draft',slotDate:'2026-11-01',localDate:'2026-11-01',status:'approved',channelLabel:'Instagram',contentTypeLabel:'Post',concept:'Original',localTime:'6:30 PM'};
  const summary={needsApproval:[],waitingForMedia:[],failed:[],missed:[],next:null};
  const coordinator={gaps:[],needs:[],state:{commitments:[{id:'draft',sourceId:'plan-uuid',channel:'instagram_post',title:'Original',localDate:'2026-11-01',localTime:'6:30 PM',status:'scheduled'}]}};
  const v=buildTodayView({today:'2026-11-01',planValidUntil:null,items:[item]},summary,coordinator);
  assert.equal(v.days[0].items.length,1);assert.equal(v.days[0].scheduledItems.length,0);assert.equal(v.next,null);
});
