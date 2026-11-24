import './helpers/server-only-shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
let db,seq=0;
const FUTURE='2035-01-01T10:00:00Z',LATER='2035-01-02T10:00:00Z';
const key=()=>`pause-reschedule-regression-${++seq}`;
test.before(async()=>{({db}=await createSupabaseLite())});
test.after(async()=>{await db?.close()});
async function owner(){
 const id=(await db.query('insert into auth.users(id) values(gen_random_uuid()) returning id')).rows[0].id;
 await db.query("insert into public.businesses(owner_user_id,timezone) values($1,'Asia/Dubai')",[id]);
 const conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[id])).rows[0].id;
 return {id,conv};
}
async function seed(o,{channel='instagram',status='scheduled',origin='autopilot',failure=null,claimed=false,provider=false,published=false}={}){
 const d=(await db.query(`insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,proposed_publish_at,status,approval_origin)
 values($1,$2,$3,$4,'Reviewed title','Reviewed content',$5,'draft',$6) returning id,content_version`,[o.id,o.conv,channel==='instagram'?'instagram_post':`${channel}_video`,channel,FUTURE,origin])).rows[0];
 if(channel==='instagram') await db.query("insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size) values($1,$2,$3,'test.png','image/png',10)",[o.id,d.id,`${o.id}/${key()}.png`]);
 await db.query("update public.mara_drafts set status='approved' where id=$1",[d.id]);
 d.content_version=(await db.query('select content_version from public.mara_drafts where id=$1',[d.id])).rows[0].content_version;
 const table=`public.${channel}_publish_queue`;
 const extra=channel==='instagram'?",media_kind,container_id,instagram_media_id":channel==='youtube'?",youtube_format,upload_session_url,youtube_video_id,provider_upload_status":",tiktok_publish_id,provider_status";
 const vals=channel==='instagram'?",'image',$8,$9":channel==='youtube'?",'video',$8,$9,case when $4='published' then 'processed' else null end":",$8,case when $4='published' then 'PUBLISH_COMPLETE' else null end";
 const args=[o.id,d.id,FUTURE,status,key(),failure,claimed?new Date():null,(provider||(channel==='tiktok'&&published))?`provider-submission-${key()}`:null];
 if(channel!=='tiktok')args.push(published?`published-media-${key()}`:null);
 await db.query(`insert into ${table}(owner_user_id,draft_id,scheduled_at,status,idempotency_key,failure_code,claimed_at,published_at${channel==='instagram'?'':',title'}${extra}) values($1,$2,$3,$4,$5,$6,$7,case when $4='published' then now() else null end${channel==='instagram'?'':",'Reviewed title'"}${vals})`,args);
 return {owner:o.id,id:d.id,v:Number(d.content_version),table};
}
async function row(d){return(await db.query(`select * from ${d.table} where draft_id=$1`,[d.id])).rows[0]}
async function pause(o,k=key()){return(await db.query('select public.pause_all_automation($1,$2) result',[o.id,k])).rows[0].result}
async function resume(o){await db.query('select public.resume_all_automation($1,$2)',[o.id,key()])}
async function sync(d,at){await db.query("select public.upsert_instagram_publish_queue_item($1,$2,null,'image','Reviewed content',$3,false)",[d.owner,d.id,at]);await db.query("select public.enqueue_reviewed_instagram_post($1,$2,$3,null,'image','Reviewed content',$4,false)",[d.owner,d.id,d.v,at])}

test('Pause-all before reschedule keeps Autopilot work cancelled through Resume and synchronization',async()=>{
 const o=await owner(),d=await seed(o);await pause(o);const cancelled=await row(d);
 await assert.rejects(db.query('select public.reschedule_reviewed_draft($1,$2,$3,$4)',[o.id,d.id,d.v,LATER]),/approval_queue_cancelled/);
 await resume(o);await sync(d,FUTURE);assert.deepEqual(await row(d),cancelled);
});
test('S5: Pause-all cancels work parked by reschedule before its synchronization completes',async()=>{
 const o=await owner(),d=await seed(o);
 await db.query('select public.reschedule_reviewed_draft($1,$2,$3,$4)',[o.id,d.id,d.v,LATER]);
 d.v=Number((await db.query('select content_version from public.mara_drafts where id=$1',[d.id])).rows[0].content_version);
 assert.equal((await row(d)).failure_code,'owner_rescheduled_sync_required');
 const result=await pause(o);assert.equal(result.socialJobsStopped.instagram,1);assert.equal((await row(d)).status,'cancelled');
 const cancelled=await row(d);await sync(d,LATER);await resume(o);await sync(d,LATER);
 await db.query("select public.approve_reviewed_post($1,$2,$3,'autopilot')",[o.id,d.id,d.v]);await sync(d,LATER);
 assert.deepEqual(await row(d),cancelled);
 await assert.rejects(db.query("select public.approve_reviewed_post($1,$2,$3,'user')",[o.id,d.id,d.v+1]),/approval_content_changed/);
 await db.query("select public.approve_reviewed_post($1,$2,$3,'user')",[o.id,d.id,d.v]);await sync(d,LATER);
 assert.equal((await row(d)).status,'scheduled');assert.equal((await row(d)).id,cancelled.id);
});
test('Pause-all covers reschedule and approval sync states plus other unclaimed Autopilot failures on all platforms',async()=>{
 const o=await owner();
 for(const channel of ['instagram','tiktok','youtube']){
  for(const failure of ['owner_rescheduled_sync_required','owner_approved_sync_required','provider_unavailable']){
   const d=await seed(o,{channel,status:'failed',failure});await pause(o);assert.equal((await row(d)).status,'cancelled',`${channel}/${failure}`);
  }
  for(const status of ['permission_required',...(channel==='instagram'?[]:['needs_declaration'])]){
   const d=await seed(o,{channel,status});await pause(o);assert.equal((await row(d)).status,'cancelled',`${channel}/${status}`);
  }
 }
});
test('Pause-all preserves manual approvals, other owners, claimed, provider-submitted and published records',async()=>{
 const o=await owner(),other=await owner();const protectedRows=[];
 for(const channel of ['instagram','tiktok','youtube']){
  for(const opts of [{origin:'user',status:'failed',failure:'owner_rescheduled_sync_required'},{status:'failed',claimed:true},{status:'failed',provider:true},{status:channel==='instagram'?'publishing':channel==='youtube'?'uploading':'posting'},{status:'published',published:true}]){
   const d=await seed(o,{channel,...opts});protectedRows.push([d,await row(d)]);
  }
  const d=await seed(other,{channel,status:'failed',failure:'owner_rescheduled_sync_required'});protectedRows.push([d,await row(d)]);
 }
 await pause(o);for(const[d,before]of protectedRows)assert.deepEqual(await row(d),before);
});
test('Pause-all replay does not create another decision or change cancelled synchronization evidence',async()=>{
 const o=await owner(),d=await seed(o,{status:'failed',failure:'owner_approved_sync_required'}),k=key();
 const first=await pause(o,k),before=await row(d);assert.equal(before.status,'cancelled');
 assert.deepEqual(await pause(o,k),first);assert.deepEqual(await row(d),before);
 assert.equal((await db.query('select count(*)::int n from public.automation_pause_events where owner_user_id=$1 and idempotency_key=$2',[o.id,k])).rows[0].n,1);
});
