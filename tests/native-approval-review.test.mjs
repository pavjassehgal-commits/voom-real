import './helpers/server-only-shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb} from './helpers/native-video-db.mjs';
import {scheduleReviewedPost} from '../lib/voom/create-scheduling.ts';
const OWNER='aaaaaaaa-0000-4000-8000-000000000083',OTHER='bbbbbbbb-0000-4000-8000-000000000083';
let user={id:OWNER},db,admin,conv;
registerHooks({resolve(s,c,next){const fake={
 '@/lib/voom/server-data':'export async function getCurrentUser(){return globalThis.__nativeApprovalUser}',
 '@/utils/supabase/admin':'export function createAdminClient(){return globalThis.__nativeApprovalDb}',
};return fake[s]?{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(fake[s])}:next(s,c);}});
const {PATCH}=await import('../app/api/social-drafts/[id]/route.ts');
const {updateSocialDraft}=await import('../lib/social/server-drafts.ts');
test.before(async()=>{({db}=await createSupabaseLite());admin=nativeVideoDb(db,{standalone:true});
 await db.query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);await db.query("insert into public.businesses(owner_user_id,timezone) values($1,'America/New_York'),($2,'Asia/Dubai')",[OWNER,OTHER]);
 conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[OWNER])).rows[0].id;globalThis.__nativeApprovalDb=admin;
});
test.after(async()=>{await db?.close()});
async function seed(kind='youtube_video',status='draft'){
 const channel=kind==='tiktok_video'?'tiktok':'youtube';
 return (await db.query(`insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content,content_meta,proposed_publish_at,status)
 values($1,$2,$3,$4,$4,'video','Reviewed video','Reviewed caption',$5,'2035-01-01T10:00:00Z',$6) returning id,content_version`,[OWNER,conv,kind,channel,{privacy:'unlisted',madeForKids:false,tiktokPrivacy:'SELF_ONLY'},status])).rows[0];
}
async function patch(d,body){globalThis.__nativeApprovalUser=user;return PATCH(new Request('https://test.invalid/api/social-drafts/'+d.id,{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),{params:Promise.resolve({id:d.id})});}
async function state(d){return(await db.query('select * from public.mara_drafts where id=$1',[d.id])).rows[0]}
test('TikTok and YouTube routes reject past and near-future schedule choices without modifying the draft',async()=>{
 for(const kind of ['tiktok_video','youtube_video']){const d=await seed(kind);for(const ms of [-300_000,-1,30_000]){
 const r=await patch(d,{scheduledAt:new Date(Date.now()+ms).toISOString(),contentVersion:Number(d.content_version)});assert.equal(r.status,400);assert.equal((await state(d)).content_version,d.content_version);}}
});
test('YouTube editor rejects missing or stale approval versions before changing declarations',async()=>{
 const d=await seed();for(const version of [undefined,0,99]){const r=await patch(d,{decision:'approved',contentVersion:version,madeForKids:true,privacy:'public'});assert([400,409].includes(r.status));assert.equal((await state(d)).content_meta.privacy,'unlisted');assert.equal((await state(d)).status,'draft');}
});
test('native owner rescheduling requires the reviewed version and preserves declarations at a future time',async()=>{
 const d=await seed('youtube_video','approved');
 const missing=await patch(d,{scheduledAt:'2035-01-02T10:00:00Z'});assert.equal(missing.status,409);
 const stale=await patch(d,{scheduledAt:'2035-01-02T10:00:00Z',contentVersion:Number(d.content_version)+1});assert.equal(stale.status,409);
 const valid=await patch(d,{scheduledAt:'2035-01-02T10:00:00Z',contentVersion:Number(d.content_version)});assert.equal(valid.status,200,JSON.stringify({response:await valid.clone().json(),errors:admin.errors}));
 const row=await state(d);assert.equal(row.status,'approved');assert.equal(row.content_meta.privacy,'unlisted');assert.equal(row.content_meta.madeForKids,false);
});
test('native reschedule explains cancellation and preserves cancelled work without fresh consent',async()=>{
 for(const kind of ['tiktok_video','youtube_video']){
  const d=await seed(kind,'approved');const channel=kind==='tiktok_video'?'tiktok':'youtube';const table=`public.${channel}_publish_queue`;
  await db.query(`insert into ${table}(owner_user_id,draft_id,title,scheduled_at,status,idempotency_key${channel==='youtube'?',youtube_format':''}) values($1,$2,'Cancelled video','2035-01-01T10:00:00Z','cancelled',$3${channel==='youtube'?",'video'":''})`,[OWNER,d.id,`cancelled-review-${d.id}`]);
  const before=await state(d);const r=await patch(d,{scheduledAt:'2035-01-02T10:00:00Z',contentVersion:Number(d.content_version)});
  assert.equal(r.status,409);assert.match((await r.json()).error,/cancelled.*explicitly approve/i);
  assert.deepEqual(await state(d),before);assert.equal((await db.query(`select status from ${table} where draft_id=$1`,[d.id])).rows[0].status,'cancelled');
 }
});
test('stale TikTok consent cannot attach itself to a newer video version',async()=>{
 const d=await seed('tiktok_video');await db.query("update public.mara_drafts set content='Newer video caption' where id=$1",[d.id]);
 await assert.rejects(updateSocialDraft(admin,OWNER,d.id,{decision:'approved',contentVersion:Number(d.content_version),tiktokPostConsent:{settings:{privacy:'SELF_ONLY'}}}),/social_draft_changed/);
 assert.equal((await state(d)).content_meta.tiktokPost,undefined);assert.equal((await state(d)).status,'draft');
});
test('a stale cancellation request cannot cancel queued native work before its version check',async()=>{
 const d=await seed('youtube_video','approved');await db.query("update public.mara_drafts set content_version=content_version+1 where id=$1",[d.id]);
 await assert.rejects(updateSocialDraft(admin,OWNER,d.id,{decision:'draft',contentVersion:Number(d.content_version)}),/social_draft_changed/);
});
test('native scheduling retains owner isolation',async()=>{
 const d=await seed();user={id:OTHER};const r=await patch(d,{scheduledAt:'2035-01-02T10:00:00Z',contentVersion:Number(d.content_version)});assert.equal(r.status,404);user={id:OWNER};assert.equal((await state(d)).content_version,d.content_version);
});
test('Create calls save then approve with the resulting exact version and requires confirmed queue state',async()=>{
 const calls=[];await scheduleReviewedPost(async b=>{calls.push(b);return b.action?{scheduled:true}:{post:{contentVersion:8}}},{contentVersion:7,scheduledAt:null,publishAt:'2035-01-01T10:00:00Z'});
 assert.deepEqual(calls,[{scheduledAt:'2035-01-01T10:00:00Z',contentVersion:7},{action:'approve',contentVersion:8}]);
});
test('Create never approves a newer saved response, a failed save or an unverified schedule',async()=>{
 let approves=0;const input={contentVersion:7,scheduledAt:null,publishAt:'2035-01-01T10:00:00Z'};
 await assert.rejects(scheduleReviewedPost(async()=>({post:{contentVersion:9}}),input),/changed while/);assert.equal(approves,0);
 await assert.rejects(scheduleReviewedPost(async()=>{throw Error('conflict')},input),/conflict/);
 await assert.rejects(scheduleReviewedPost(async b=>{if(b.action){approves++;return{scheduled:false}}return{post:{contentVersion:8}}},input),/could not be verified/);assert.equal(approves,1);
});
