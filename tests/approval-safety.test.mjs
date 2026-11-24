import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseLite } from './helpers/pglite-supabase.mjs';
const { approvePostDraft, APPROVAL_CONTENT_CHANGED } = await import('../lib/post/server-data.ts');
import { checkSchedule } from '../lib/voom/schedule-guard.ts';

const OWNER='aaaaaaaa-0000-4000-8000-000000000081';
const OTHER='bbbbbbbb-0000-4000-8000-000000000081';
const FUTURE='2035-01-01T10:00:00Z';
let db, conv, seq=0;
test.before(async()=>{
  ({db}=await createSupabaseLite());
  await db.query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
  await db.query("insert into public.businesses(owner_user_id,timezone) values($1,'America/New_York'),($2,'Asia/Dubai')",[OWNER,OTHER]);
  conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[OWNER])).rows[0].id;
});
test.after(async()=>{await db?.close();});
async function seed({at=FUTURE,media=true,status='draft',kind='instagram_post'}={}){
  const id=(await db.query(`insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,status,proposed_publish_at)
    values($1,$2,$3,'instagram','Reviewed title','Reviewed caption',$4,$5) returning id`,[OWNER,conv,kind,status,at])).rows[0].id;
  if(media) await db.query(`insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size)
    values($1,$2,$3,'photo.png','image/png',100)`,[OWNER,id,`${OWNER}/${++seq}.png`]);
  const row=await state(id);return {id,v:row.content_version};
}
async function state(id){return (await db.query('select * from public.mara_drafts where id=$1',[id])).rows[0];}
async function approve(d,{owner=OWNER,version=d.v,action=null}={}){
 return db.query("select public.approve_reviewed_post($1,$2,$3,'user',$4) as changed",[owner,d.id,version,action]);
}
async function card(d,status='executing',version=d.v){
 return (await db.query(`insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,sanitized_arguments,new_value,idempotency_key,status)
 values($1,$2,'propose_calendar_item','Review',$3::jsonb,$3::jsonb,$4,$5) returning id`,[OWNER,conv,JSON.stringify({sourceDraftId:d.id,contentVersion:Number(version),publishAt:FUTURE}),`safety-operation-${++seq}`,status])).rows[0].id;
}
async function status(id){return (await db.query('select status from public.mara_pending_actions where id=$1',[id])).rows[0].status;}
async function count(table,d){return Number((await db.query(`select count(*) as n from public.${table} where ${table==='content_calendar_items'?'source_draft_id':'draft_id'}=$1`,[d.id])).rows[0].n);}

test('shared boundary rejects a missing reviewed version before any database operation',async()=>{
 let calls=0; await assert.rejects(approvePostDraft({rpc(){calls++;throw Error('must not write');}},OWNER,'draft'),new RegExp(APPROVAL_CONTENT_CHANGED));assert.equal(calls,0);
});
test('transaction approves exactly the reviewed version and repeats without a second transition',async()=>{
 const d=await seed();assert.equal((await approve(d)).rows[0].changed,true);assert.equal((await approve(d)).rows[0].changed,false);
 const row=await state(d.id);assert.equal(row.status,'approved');assert.equal(row.approved_content_version,row.content_version);
});
test('an edit arriving before the locked approval write makes the reviewed version stale',async()=>{
 const d=await seed();await db.query("update public.mara_drafts set content='Concurrent caption' where id=$1",[d.id]);
 await assert.rejects(approve(d),/approval_content_changed/);assert.equal((await state(d.id)).status,'draft');
});
test('media replacement after review invalidates approval',async()=>{
 const d=await seed();await db.query("update public.post_draft_assets set storage_path=storage_path||'-replacement' where draft_id=$1",[d.id]);
 await assert.rejects(approve(d),/approval_content_changed/);
});
test('an edit after approval withdraws the version and its queued work',async()=>{
 const d=await seed();await approve(d);await db.query('select public.sync_reviewed_post_calendar($1,$2,$3)',[OWNER,d.id,d.v]);
 await db.query("select public.enqueue_reviewed_instagram_post($1,$2,$3,null,'image','Reviewed caption',$4,false)",[OWNER,d.id,d.v,FUTURE]);
 await db.query("update public.mara_drafts set content='Changed later' where id=$1",[d.id]);
 assert.equal((await state(d.id)).status,'draft');assert.equal(await count('content_calendar_items',d),0);
 assert.equal((await db.query('select status from public.instagram_publish_queue where draft_id=$1',[d.id])).rows[0].status,'cancelled');
 await assert.rejects(db.query('select public.sync_reviewed_post_calendar($1,$2,$3)',[OWNER,d.id,d.v]),/approval_content_changed/);
 await assert.rejects(db.query("select public.enqueue_reviewed_instagram_post($1,$2,$3,null,'image','Reviewed caption',$4,false)",[OWNER,d.id,d.v,FUTURE]),/approval_content_changed/);
});
test('past and near-expiry schedules cannot be approved or mirrored',async()=>{
 for(const at of ['2026-09-06T10:00:00Z',new Date(Date.now()-1000).toISOString(),new Date(Date.now()+15000).toISOString()]){
 const d=await seed({at});await assert.rejects(approve(d),/approval_schedule_expired/);assert.equal((await state(d.id)).status,'draft');assert.equal(await count('content_calendar_items',d),0);}
});
test('rejected content and another owner cannot be approved',async()=>{
 const d=await seed({status:'rejected'});await assert.rejects(approve(d),/approval_invalid_state/);
 const other=await seed();await assert.rejects(approve(other,{owner:OTHER}),/approval_content_changed/);
});
test('missing media fails before approval; unscheduled complete drafts remain approvable',async()=>{
 const d=await seed({media:false});await assert.rejects(approve(d),/approval_incomplete/);
 const unscheduled=await seed({at:null});await approve(unscheduled);assert.equal((await state(unscheduled.id)).status,'approved');
});
test('cancelled, failed, pending and already-confirmed cards cannot execute as claimed cards',async()=>{
 for(const s of ['cancelled','failed','pending','confirmed']){const d=await seed();const a=await card(d,s);await assert.rejects(approve(d,{action:a}),/approval_content_changed/);assert.equal(await status(a),s);assert.equal((await state(d.id)).status,'draft');}
});
test('superseded snapshot cannot confirm a newer draft',async()=>{
 const d=await seed();const a=await card(d,'executing',Number(d.v)-1);await assert.rejects(approve(d,{action:a}),/approval_content_changed/);
});
test('action and draft confirmation commit together, and duplicate confirmation does not run twice',async()=>{
 const d=await seed();const a=await card(d);await approve(d,{action:a});assert.equal(await status(a),'confirmed');
 await assert.rejects(approve(d,{action:a}),/approval_content_changed/);
});
test('owner rejection cancels pending cards and prevents their delayed confirmation',async()=>{
 const d=await seed();const a=await card(d,'pending');await db.query('select public.reject_reviewed_post($1,$2,$3)',[OWNER,d.id,a]);
 assert.equal(await status(a),'cancelled');assert.equal((await state(d.id)).status,'rejected');await assert.rejects(approve(d,{action:a}),/approval_content_changed/);
});
test('a claimed action cannot be cancelled through an old pending-card request',async()=>{
 const d=await seed();const a=await card(d);await assert.rejects(db.query('select public.reject_reviewed_post($1,$2,$3)',[OWNER,d.id,a]),/approval_invalid_state/);
 await approve(d,{action:a});assert.equal(await status(a),'confirmed');
});
test('provider-owned and published Instagram records cannot be reapproved or rejected',async()=>{
 for(const s of ['publishing','published']){const d=await seed();await db.query(`insert into public.instagram_publish_queue(owner_user_id,draft_id,media_kind,scheduled_at,status,idempotency_key,instagram_media_id,published_at)
 values($1,$2,'image',$3,$4,$5,case when $4='published' then 'real-provider-id' else null end,case when $4='published' then now() else null end)`,[OWNER,d.id,FUTURE,s,`queue-operation-${++seq}`]);
 await assert.rejects(approve(d),/approval_invalid_state/);await assert.rejects(db.query('select public.reject_reviewed_post($1,$2,null)',[OWNER,d.id]),/approval_invalid_state/);}
});
test('standalone September scheduling proposal remains unconfirmed and inserts nothing',async()=>{
 const args={title:'Expired',channel:'Instagram',content:'caption',publishAt:'2026-09-06T10:00:00Z'};
 const a=(await db.query(`insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,sanitized_arguments,idempotency_key,status)
 values($1,$2,'propose_calendar_item','Expired',$3,$4,'executing') returning id`,[OWNER,conv,args,`expired-operation-${++seq}`])).rows[0].id;
 await assert.rejects(db.query('select public.confirm_calendar_proposal($1,$2)',[OWNER,a]),/approval_schedule_expired/);assert.equal(await status(a),'executing');
});
test('standalone confirmation is atomic and cannot insert a duplicate on retry',async()=>{
 const args={title:'Future proposal',channel:'Instagram',content:'caption',publishAt:FUTURE};
 const a=(await db.query(`insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,sanitized_arguments,idempotency_key,status)
 values($1,$2,'propose_calendar_item','Review',$3,$4,'executing') returning id`,[OWNER,conv,args,`future-operation-${++seq}`])).rows[0].id;
 await db.query('select public.confirm_calendar_proposal($1,$2)',[OWNER,a]);assert.equal(await status(a),'confirmed');
 await assert.rejects(db.query('select public.confirm_calendar_proposal($1,$2)',[OWNER,a]),/approval_invalid_state/);
 assert.equal(Number((await db.query("select count(*) n from public.content_calendar_items where title='Future proposal' and owner_user_id=$1",[OWNER])).rows[0].n),1);
});
test('new owner time choices use business timezone across date boundaries',()=>{
 const now=new Date('2026-11-24T23:30:00Z');
 const ny=checkSchedule({date:'2026-11-24',time:'20:00',timeZone:'America/New_York',now});assert.equal(ny.ok,true);assert.equal(ny.publishAt,'2026-11-25T01:00:00.000Z');
 assert.equal(checkSchedule({date:'2026-11-24',time:'18:00',timeZone:'America/New_York',now}).ok,false);
});
test('approval RPC privileges do not grant browser access',async()=>{
 const r=await db.query("select has_function_privilege('authenticated','public.approve_reviewed_post(uuid,uuid,bigint,text,uuid,uuid)','execute') allowed");assert.equal(r.rows[0].allowed,false);
});

test('overlapping confirmations of one action execute only one approval transition',async()=>{
 const d=await seed();const a=await card(d);
 const results=await Promise.allSettled([approve(d,{action:a}),approve(d,{action:a})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(await status(a),'confirmed');assert.equal((await state(d.id)).approved_content_version,d.v);
});
test('expired content becomes approvable only after an explicit future schedule and a new review version',async()=>{
 const d=await seed({at:'2026-09-06T10:00:00Z'});await assert.rejects(approve(d),/approval_schedule_expired/);
 await db.query('update public.mara_drafts set proposed_publish_at=$2 where id=$1',[d.id,FUTURE]);
 await assert.rejects(approve(d),/approval_content_changed/);
 const latest=await state(d.id);await approve({id:d.id,v:latest.content_version});assert.equal((await state(d.id)).status,'approved');
});
test('standalone calendar update rejects a changed target and an expired replacement time',async()=>{
 const item=(await db.query("insert into public.content_calendar_items(owner_user_id,title,channel,publish_at) values($1,'Original','Instagram',$2) returning *",[OWNER,FUTURE])).rows[0];
 async function updateCard(at){return (await db.query(`insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,sanitized_arguments,old_value,idempotency_key,status)
 values($1,$2,'update_calendar_item','Review',$3,$4,$5,'executing') returning id`,[OWNER,conv,{itemId:item.id,publishAt:at,title:'Reviewed change'},item,`update-operation-${++seq}`])).rows[0].id;}
 const expired=await updateCard('2026-09-06T10:00:00Z');await assert.rejects(db.query('select public.confirm_calendar_update($1,$2)',[OWNER,expired]),/approval_schedule_expired/);
 const stale=await updateCard(FUTURE);await db.query("update public.content_calendar_items set title='Concurrent update' where id=$1",[item.id]);
 await assert.rejects(db.query('select public.confirm_calendar_update($1,$2)',[OWNER,stale]),/approval_content_changed/);
});
test('unsupported legacy caption approval fails before changing draft state',async()=>{
 const d=await seed({kind:'instagram_caption',media:false});await assert.rejects(approve(d),/approval_invalid_state/);assert.equal((await state(d.id)).status,'draft');
});
