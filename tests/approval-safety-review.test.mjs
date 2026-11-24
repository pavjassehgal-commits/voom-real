import './helpers/server-only-shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite,migrationSql} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb} from './helpers/native-video-db.mjs';
import {AUTOMATIC_PUBLISH_GRACE_MS,SCHEDULE_LEAD_MS,automaticPublishExpired} from '../lib/voom/schedule-policy.ts';
import {checkScheduleInstant} from '../lib/voom/schedule-guard.ts';
import {draftApprovalTarget} from '../lib/mara/approval-target.ts';
const {runPublishFlow}=await import('../lib/instagram/publish-flow.ts');
const {savePostDraft,approvePostDraft}=await import('../lib/post/server-data.ts');
const {decideCampaignAction}=await import('../lib/campaign/server.ts');
const {executeConfirmedAction}=await import('../lib/mara/tools.ts');
const OWNER='aaaaaaaa-0000-4000-8000-000000000082', OTHER='bbbbbbbb-0000-4000-8000-000000000082';
const FUTURE='2035-01-01T10:00:00.000Z';
let db,admin,conv,seq=0;
const key=()=>`review-operation-${++seq}`;
test.before(async()=>{
 ({db}=await createSupabaseLite());
 await db.query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
 await db.query("insert into public.businesses(owner_user_id,timezone) values($1,'America/New_York'),($2,'Asia/Dubai')",[OWNER,OTHER]);
 conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[OWNER])).rows[0].id;
 admin=nativeVideoDb(db,{standalone:true});
});
test.after(async()=>{await db?.close()});
async function seed({at=FUTURE,status='approved',queue=null,container=null,attempts=0,kind='instagram_post'}={}){
 const id=(await db.query(`insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,proposed_publish_at)
 values($1,$2,$3,'instagram','Reviewed title','Reviewed caption',$4) returning id`,[OWNER,conv,kind,at])).rows[0].id;
 if(kind==='instagram_post') await db.query("insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size) values($1,$2,$3,'photo.png','image/png',100)",[OWNER,id,`${OWNER}/${key()}.png`]);
 await db.query('update public.mara_drafts set status=$2 where id=$1',[id,status]);
 let q=null;
 if(queue) q=(await db.query(`insert into public.instagram_publish_queue(owner_user_id,draft_id,media_kind,caption,scheduled_at,status,idempotency_key,container_id,attempts,claimed_at)
 values($1,$2,'image','Reviewed caption',$3,$4,$5,$6,$7,case when $4='publishing' then now()-interval '1 hour' else null end) returning id`,[OWNER,id,at,queue,key(),container,attempts])).rows[0].id;
 const row=(await db.query('select content_version from public.mara_drafts where id=$1',[id])).rows[0];return {id,q,v:Number(row.content_version)};
}
async function qrow(d){return (await db.query('select * from public.instagram_publish_queue where draft_id=$1',[d.id])).rows[0]}
async function claim(now=new Date()){return (await db.query('select * from public.claim_due_instagram_publish_jobs(100,$1,5)',[now.toISOString()])).rows}
async function upsert(d,at){return db.query("select public.upsert_instagram_publish_queue_item($1,$2,null,'image','Reviewed caption',$3,false)",[OWNER,d.id,at])}

test('SQL and TypeScript share the same scheduling lead and automatic lateness policy',async()=>{
 const r=(await db.query('select extract(epoch from public.content_schedule_lead())*1000 lead,extract(epoch from public.instagram_publish_grace())*1000 grace')).rows[0];
 assert.equal(Number(r.lead),SCHEDULE_LEAD_MS);assert.equal(Number(r.grace),AUTOMATIC_PUBLISH_GRACE_MS);
 const now=new Date('2026-11-24T23:59:30Z');
 for(const zone of ['Asia/Dubai','America/New_York','Pacific/Auckland']){
 assert.equal(checkScheduleInstant(new Date(+now+60_000).toISOString(),now,zone).ok,true);
 assert.equal(checkScheduleInstant(new Date(+now+59_999).toISOString(),now,zone).ok,false);
 assert.equal(checkScheduleInstant(new Date(+now-1).toISOString(),now,zone).ok,false);
 }
 assert.equal(automaticPublishExpired('2026-11-24T10:00:00Z',Date.parse('2026-11-24T10:20:00Z')),true);
});
test('claim expires days-late jobs even when their retry clock was moved to the future',async()=>{
 const d=await seed({at:new Date(Date.now()-2*86400000).toISOString(),queue:'scheduled'});
 await db.query("update public.instagram_publish_queue set scheduled_at=now()+interval '1 day' where id=$1",[d.q]);
 assert.equal((await claim()).some(r=>r.id===d.q),false);const row=await qrow(d);assert.equal(row.status,'failed');assert.equal(row.failure_code,'instagram_schedule_expired');
 assert.equal((await db.query('select status from public.mara_drafts where id=$1',[d.id])).rows[0].status,'approved');
});
test('reasonable worker delay remains claimable; expired work cannot revive through raw or reviewed synchronization',async()=>{
 const timely=await seed({at:new Date(Date.now()-5*60_000).toISOString(),queue:'scheduled'});assert((await claim()).some(r=>r.id===timely.q));
 const expired=await seed({at:new Date(Date.now()-21*60_000).toISOString(),queue:'waiting_for_media'});await claim();
 await upsert(expired,(await qrow(expired)).scheduled_at.toISOString());
 await db.query('select public.sync_reviewed_post_calendar($1,$2,$3)',[OWNER,expired.id,expired.v]);
 await db.query("select public.enqueue_reviewed_instagram_post($1,$2,$3,null,'image','Reviewed caption',$4,false)",[OWNER,expired.id,expired.v,(await qrow(expired)).scheduled_at]);
 assert.equal((await qrow(expired)).failure_code,'instagram_schedule_expired');assert.equal((await claim()).some(r=>r.id===expired.q),false);
});
test('retry beyond the approved deadline becomes terminal instead of extending the publishing window',async()=>{
 const d=await seed({at:new Date(Date.now()-18*60_000).toISOString(),queue:'scheduled'});
 await db.query("select public.fail_instagram_publish_job($1,$2,'container_timeout','Retry','scheduled',now()+interval '5 minutes')",[d.q,OWNER]);
 const row=await qrow(d);assert.equal(row.status,'failed');assert.equal(row.failure_code,'instagram_schedule_expired');
});
test('stale claims expire; container-bearing failures are claimed only for read-only recovery',async()=>{
 const d=await seed({at:new Date(Date.now()-2*3600000).toISOString(),queue:'publishing',container:'existing-container'});
 const rows=await claim();assert(rows.some(r=>r.id===d.q));assert.equal((await qrow(d)).container_id,'existing-container');
 await db.query("select public.fail_instagram_publish_job($1,$2,'instagram_schedule_expired','expired','failed',null)",[d.q,OWNER]);
 assert((await claim()).some(r=>r.id===d.q));
});
test('cancelled and withdrawn jobs cannot be revived by a synchronization call',async()=>{
 const d=await seed({queue:'cancelled'});await upsert(d,FUTURE);assert.equal((await qrow(d)).status,'cancelled');
 await db.query("update public.mara_drafts set status='rejected' where id=$1",[d.id]);await upsert(d,FUTURE);assert.equal((await qrow(d)).status,'cancelled');
});
test('ordinary reschedule cannot reactivate cancelled Instagram, TikTok or YouTube work',async()=>{
 for(const channel of ['instagram','tiktok','youtube']){
  const d=await seed({kind:channel==='instagram'?'instagram_post':`${channel}_video`,queue:channel==='instagram'?'cancelled':null});
  const table=`public.${channel}_publish_queue`;
  if(channel!=='instagram') await db.query(`insert into ${table}(owner_user_id,draft_id,title,scheduled_at,status,idempotency_key${channel==='youtube'?',youtube_format':''}) values($1,$2,'Reviewed video',$3,'cancelled',$4${channel==='youtube'?",'video'":''})`,[OWNER,d.id,FUTURE,key()]);
  const before=(await db.query(`select * from ${table} where draft_id=$1`,[d.id])).rows[0];
  const draftBefore=(await db.query('select proposed_publish_at,content_version,approved_content_version from public.mara_drafts where id=$1',[d.id])).rows[0];
  for(const rpc of ['reschedule_approved_draft','reschedule_reviewed_draft']){
   const args=rpc==='reschedule_reviewed_draft'?[OWNER,d.id,d.v,'2035-01-02T10:00:00Z']:[OWNER,d.id,'2035-01-02T10:00:00Z'];
   await assert.rejects(db.query(`select public.${rpc}(${args.map((_,i)=>'$'+(i+1)).join(',')})`,args),/approval_queue_cancelled/);
  }
  if(channel==='instagram') await assert.rejects(db.query('select public.schedule_reviewed_instagram_now($1,$2,$3)',[OWNER,d.id,d.v]),/approval_queue_cancelled/);
  assert.deepEqual((await db.query(`select * from ${table} where draft_id=$1`,[d.id])).rows[0],before);
  assert.deepEqual((await db.query('select proposed_publish_at,content_version,approved_content_version from public.mara_drafts where id=$1',[d.id])).rows[0],draftBefore);
  // Unscheduling remains allowed, but must retain the entire cancellation record.
  await db.query('select public.reschedule_approved_draft($1,$2,null)',[OWNER,d.id]);
  assert.deepEqual((await db.query(`select * from ${table} where draft_id=$1`,[d.id])).rows[0],before);
 }
});
test('fresh explicit reviewed Instagram approval can reactivate cancelled work, not a time change',async()=>{
 const d=await seed({queue:'cancelled'});
 const approved=await approvePostDraft(admin,OWNER,d.id,{expectedContentVersion:d.v});
 assert.equal(approved.status,'approved');assert.equal((await qrow(d)).status,'scheduled');assert.equal((await qrow(d)).id,d.q);
});
test('explicit owner reschedule recovers an expired queue identity and checks the reviewed version',async()=>{
 const d=await seed({at:new Date(Date.now()-3600000).toISOString(),queue:'scheduled'});await claim();
 await assert.rejects(db.query('select public.reschedule_reviewed_draft($1,$2,$3,$4)',[OWNER,d.id,d.v-1,FUTURE]),/approval_content_changed/);
 await db.query('select public.reschedule_reviewed_draft($1,$2,$3,$4)',[OWNER,d.id,d.v,FUTURE]);
 await upsert(d,FUTURE);assert.equal((await qrow(d)).id,d.q);assert.equal((await qrow(d)).status,'scheduled');
});
test('native reschedule RPC refuses past, too-near and cross-owner times and retains approved consent metadata',async()=>{
 const d=await seed({kind:'youtube_video'});
 await db.query("update public.mara_drafts set content_meta='{\"privacy\":\"unlisted\",\"madeForKids\":false}' where id=$1",[d.id]);
 await db.query("update public.mara_drafts set status='approved' where id=$1",[d.id]);
 for(const at of [new Date(Date.now()-1).toISOString(),new Date(Date.now()+30_000).toISOString()]) await assert.rejects(db.query('select public.reschedule_approved_draft($1,$2,$3)',[OWNER,d.id,at]),/approval_schedule_expired/);
 await assert.rejects(db.query('select public.reschedule_approved_draft($1,$2,$3)',[OTHER,d.id,FUTURE]),/draft_not_found/);
 await db.query('select public.reschedule_approved_draft($1,$2,$3)',[OWNER,d.id,FUTURE]);
 const r=(await db.query('select status,content_meta from public.mara_drafts where id=$1',[d.id])).rows[0];assert.equal(r.status,'approved');assert.equal(r.content_meta.privacy,'unlisted');
});
test('Create schedule-then-approve uses only its resulting reviewed version; concurrent content edits fail closed',async()=>{
 const d=await seed({status:'draft',at:null});
 const saved=await savePostDraft(admin,OWNER,d.id,{scheduledAt:FUTURE},d.v);assert.equal(saved.contentVersion,d.v+1);
 const approved=await approvePostDraft(admin,OWNER,d.id,{expectedContentVersion:saved.contentVersion});assert.equal(approved.status,'approved');assert.equal((await qrow(d)).status,'scheduled');
 const changed=await seed({status:'draft',at:null});const reviewed=await savePostDraft(admin,OWNER,changed.id,{scheduledAt:FUTURE},changed.v);
 await db.query("update public.mara_drafts set content='Concurrent content' where id=$1",[changed.id]);
 await assert.rejects(approvePostDraft(admin,OWNER,changed.id,{expectedContentVersion:reviewed.contentVersion}),/approval_content_changed/);
});
test('schedule-only Post save is versioned once and does not overwrite a concurrent edit',async()=>{
 const d=await seed();const saved=await savePostDraft(admin,OWNER,d.id,{scheduledAt:'2035-01-02T10:00:00Z'},d.v);
 assert.equal(saved.status,'approved');assert.equal(saved.contentVersion,d.v+1);
 await assert.rejects(savePostDraft(admin,OWNER,d.id,{scheduledAt:FUTURE},d.v),/approval_content_changed/);
});
test('campaign approval rejects absent and stale versions and cannot resurrect a skipped action',async()=>{
 const d=await seed({status:'draft'});
 const parent=(await db.query("insert into public.voom_campaigns(owner_user_id,kind,name) values($1,'email','Review campaign') returning id",[OWNER])).rows[0].id;
 const action=(await db.query("insert into public.voom_campaign_actions(owner_user_id,campaign_id,slot,channel,stage,title,scheduled_for,draft_id,idempotency_key) values($1,$2,0,'instagram_post','awareness','Review',$3,$4,$5) returning id",[OWNER,parent,FUTURE,d.id,key()])).rows[0].id;
 assert.equal((await decideCampaignAction(admin,OWNER,parent,action,'approve')).ok,false);
 await assert.rejects(decideCampaignAction(admin,OWNER,parent,action,'approve',d.v-1),/approval_content_changed/);
 assert.equal((await decideCampaignAction(admin,OWNER,parent,action,'approve',d.v)).ok,true);
 await db.query("update public.voom_campaign_actions set status='skipped' where id=$1",[action]);
 assert.equal((await decideCampaignAction(admin,OWNER,parent,action,'approve',d.v)).ok,false);
});
test('legacy non-Instagram cards explain their limitation and never reach the Instagram approval RPC',async()=>{
 for(const kind of ['tiktok_video','youtube_video','linkedin_text','email','weekly_calendar']){
 const target=draftApprovalTarget(kind,'owned-draft');assert(target);assert.match(target.reason,/editor|legacy/i);assert(target.href.startsWith('/app/'));
 }
 const d=await seed({kind:'email',status:'draft'});const result=await executeConfirmedAction({db:admin,ownerId:OWNER,conversationId:conv},{id:'unused',tool_name:'approve_draft',status:'executing',sanitized_arguments:{draftId:d.id,contentVersion:d.v}});
 assert.equal(result.ok,false);assert.equal(result.requiresEditor.href,'/app/campaigns');assert.equal((await db.query('select status from public.mara_drafts where id=$1',[d.id])).rows[0].status,'draft');
});

function flowHarness({at,container=null,status='FINISHED',crossAt=null}={}){
 const calls={create:0,publish:0,read:0,complete:0,fail:[]};let now=Date.parse('2026-11-24T10:00:00Z');
 const item={id:'queue',ownerUserId:OWNER,draftId:'draft',mediaKind:'image',caption:'Reviewed',attempts:1,containerId:container,instagramMediaId:null};
 const ports={now:()=>now,async loadDraft(){return{status:'approved',content:'Reviewed',contentVersion:1,publishAt:at}},async approvalStillCurrent(){return true},async loadConnection(){return{status:'connected',scopes:['instagram_business_content_publish'],tokenExpiresAt:null}},async loadCredentials(){return{igUserId:'ig',accessToken:'synthetic'}},async loadAsset(){return{storagePath:OWNER+'/asset',mimeType:'image/png',status:'uploaded'}},async signMediaUrl(){return'https://synthetic.invalid/image'},async createContainer(){calls.create++;return'container'},async persistContainerId(){},async containerStatus(){calls.read++;if(crossAt)now=crossAt;return status},async publishContainer(){calls.publish++;return'media'},async findPublishedMediaId(){return status==='PUBLISHED'?'existing-media':null},async markPublished(){calls.complete++},async markFailed(_i,x){calls.fail.push(x)},async sleep(){}};
 return{item,ports,calls};
}
test('expired worker performs zero creates or publishes, including after polling crosses its deadline',async()=>{
 const h=flowHarness({at:'2026-11-23T10:00:00Z'});await runPublishFlow(h.item,h.ports);assert.equal(h.calls.create,0);assert.equal(h.calls.publish,0);assert.equal(h.calls.fail[0].code,'instagram_schedule_expired');
 const crossed=flowHarness({at:'2026-11-24T09:41:00Z',crossAt:Date.parse('2026-11-24T10:02:00Z')});await runPublishFlow(crossed.item,crossed.ports);assert.equal(crossed.calls.publish,0);assert.equal(crossed.calls.fail[0].code,'instagram_schedule_expired');
});
test('late reconciliation records only provider-confirmed prior publication, never media_publish',async()=>{
 for(const status of ['FINISHED','PUBLISHED']){const h=flowHarness({at:'2026-11-23T10:00:00Z',container:'existing-container',status});const r=await runPublishFlow(h.item,h.ports);assert.equal(h.calls.create,0);assert.equal(h.calls.publish,0);assert.equal(h.calls.complete,status==='PUBLISHED'?1:0);assert.equal(r.outcome,status==='PUBLISHED'?'published':'failed');}
});
test('rollback restores original functions and leaves approval, cancelled, expired and published records unchanged',async()=>{
 const fixture=await createSupabaseLite({stopBefore:'0080'});const local=fixture.db;
 const names=['claim_due_instagram_publish_jobs','fail_instagram_publish_job','upsert_instagram_publish_queue_item','reschedule_approved_draft'];
 const defs=async()=>JSON.stringify((await local.query("select proname,pg_get_functiondef(p.oid) def,proacl::text acl from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1) order by proname",[names])).rows);
 const before=await defs();await fixture.applyPending();
 await local.query('insert into auth.users(id) values($1)',[OWNER]);await local.query("insert into public.businesses(owner_user_id) values($1)",[OWNER]);
 const c=(await local.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[OWNER])).rows[0].id;
 const d=(await local.query("insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,status,proposed_publish_at) values($1,$2,'instagram_post','instagram','Kept','Kept','approved',now()-interval '1 day') returning id",[OWNER,c])).rows[0].id;
 await local.query("insert into public.instagram_publish_queue(owner_user_id,draft_id,media_kind,scheduled_at,status,idempotency_key,failure_code) values($1,$2,'image',now(),'failed',$3,'instagram_schedule_expired')",[OWNER,d,key()]);
 for (const status of ['published','cancelled']) {
  const other=(await local.query("insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,status,proposed_publish_at) values($1,$2,'instagram_post','instagram','History','Kept','approved',now()-interval '1 day') returning id",[OWNER,c])).rows[0].id;
  await local.query("insert into public.instagram_publish_queue(owner_user_id,draft_id,media_kind,scheduled_at,status,idempotency_key,instagram_media_id,published_at) values($1,$2,'image',now(),$3,$4,case when $3='published' then 'actual-provider-media' else null end,case when $3='published' then now() else null end)",[OWNER,other,status,key()]);
 }
 await local.query("insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,sanitized_arguments,idempotency_key) values($1,$2,'approve_draft','Kept',$3,$4)",[OWNER,c,{draftId:d,contentVersion:1},key()]);
 const records=async()=>JSON.stringify({drafts:(await local.query('select * from public.mara_drafts')).rows,queue:(await local.query('select * from public.instagram_publish_queue')).rows,actions:(await local.query('select * from public.mara_pending_actions')).rows});
 const snapshot=await records();await local.exec(await readFile(new URL('../supabase/rollbacks/0080_approval_safety.sql',import.meta.url),'utf8'));assert.equal(await defs(),before);assert.equal(await records(),snapshot);
 const remaining=await local.query("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and proname=any($1)",[['approve_reviewed_post','reject_reviewed_post','confirm_calendar_proposal','confirm_calendar_update','enqueue_reviewed_instagram_post','sync_reviewed_post_calendar','expire_instagram_publish_jobs','schedule_reviewed_instagram_now','reschedule_reviewed_draft','content_schedule_lead','instagram_publish_grace']]);assert.equal(remaining.rows[0].n,0);
 await local.exec(migrationSql('0080_approval_safety.sql'));assert.equal(await records(),snapshot);await local.close();
});
test('failure retries cannot resurrect a cancelled queue or a withdrawn approval',async()=>{
 const cancelled=await seed({queue:'cancelled'});await db.query("select public.fail_instagram_publish_job($1,$2,'network','retry','scheduled',now()+interval '5 minutes')",[cancelled.q,OWNER]);assert.equal((await qrow(cancelled)).status,'cancelled');
 const withdrawn=await seed({queue:'scheduled'});await db.query("update public.mara_drafts set status='rejected' where id=$1",[withdrawn.id]);
 await db.query("select public.fail_instagram_publish_job($1,$2,'network','retry','scheduled',now()+interval '5 minutes')",[withdrawn.q,OWNER]);assert.equal((await qrow(withdrawn)).status,'cancelled');
});
