import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb, mp4} from './helpers/native-video-db.mjs';

// Real route, byte validation, storage/linking service and PostgreSQL RPC.
// Authentication, private object storage and HTTP are isolated test doubles.
registerHooks({resolve(specifier, context, next) {
  if(specifier==='@/lib/voom/server-data')return {shortCircuit:true,url:'data:text/javascript,export async function getCurrentUser(){return globalThis.__youtubeUpload.user}'};
  if(specifier==='@/utils/supabase/admin')return {shortCircuit:true,url:'data:text/javascript,export function createAdminClient(){return globalThis.__youtubeUpload.admin}'};
  return next(specifier,context);
}});
const {POST, DELETE}=await import('../app/api/posts/[id]/asset/route.ts');
const {getSocialDraft,updateSocialDraft}=await import('../lib/social/server-drafts.ts');
const {getPostDraftForIngestion}=await import('../lib/post/server-data.ts');
const {buildYouTubeFlowPorts}=await import('../lib/youtube/publish-worker.ts');
const OWNER='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const VIDEO='33333333-3333-4333-8333-333333333333', SHORT='44444444-4444-4444-8444-444444444444';
const META={description:'Original description',hashtags:['#original'],script:['Original script'],privacy:'private',madeForKids:false};
let db;
before(async()=>{({db}=await createSupabaseLite());});
after(()=>db?.close());
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const draft=async(id=VIDEO)=>(await q('select * from mara_drafts where id=$1',[id]))[0];
const asset=async(id=VIDEO)=>(await q('select * from post_draft_assets where draft_id=$1',[id]))[0];
async function fixture(t) {
  await db.exec('begin');
  await q('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
  const [conversation]=await q('insert into mara_conversations(owner_user_id) values($1) returning id',[OWNER]);
  for(const [id,kind,format] of [[VIDEO,'youtube_video','video'],[SHORT,'youtube_short','short']])
    await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content,content_meta,proposed_publish_at) values($1,$2,$3,$4,'youtube','youtube',$5,'Original title','Original caption #original',$6,'2099-01-01T12:00:00Z')",[id,OWNER,conversation.id,kind,format,JSON.stringify(META)]);
  const admin=nativeVideoDb(db);
  globalThis.__youtubeUpload={admin,user:{id:OWNER}};
  const oldFetch=globalThis.fetch;
  globalThis.fetch=async()=>{throw new Error('External HTTP forbidden in upload tests');};
  t.after(async()=>{globalThis.fetch=oldFetch;delete globalThis.__youtubeUpload;await db.exec('rollback');});
  return admin;
}
async function upload({id=VIDEO,bytes=mp4(),name='original.mp4',mime='application/octet-stream',headers={}}={}) {
  const form=new FormData();form.set('file',new File([bytes],name,{type:mime}));
  const response=await POST(new Request(`https://test.invalid/api/posts/${id}/asset`,{method:'POST',body:form,headers}),{params:Promise.resolve({id})});
  return {response,body:await response.json()};
}
async function queued(status='scheduled',extra={}) {
  await q("update mara_drafts set status='approved' where id=$1",[VIDEO]);
  const keys=Object.keys(extra),args=Object.values(extra);
  await q(`insert into youtube_publish_queue(owner_user_id,draft_id,youtube_format,title,privacy_status,made_for_kids,scheduled_at,status,idempotency_key${keys.map(k=>','+k).join('')}) values($1,$2,'video','Original title','private',false,'2099-01-01',$3,'ytpub_native_upload_test'${args.map((_,i)=>',$'+(i+4)).join('')})`,[OWNER,VIDEO,status,...args]);
}
const assertNoSideEffects=async()=>{
  for(const table of ['youtube_publish_queue','tiktok_publish_queue','instagram_publish_queue','linkedin_publish_queue','voom_credit_ledger','mara_media_generations'])
    assert.equal((await q(`select count(*)::int as n from ${table}`))[0].n,0,table);
};
for(const id of [VIDEO,SHORT])test(`${id===VIDEO?'standard video':'Short'}: authenticated MP4 attaches to exact draft, stays private and unapproved, no credits or jobs`,async t=>{
  const admin=await fixture(t),before=await draft(id),bytes=mp4(id===VIDEO?{width:1280,height:720}:{});
  const {response,body}=await upload({id,bytes});
  assert.equal(response.status,200,JSON.stringify(body));assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(body.draft.id,id);assert.equal(body.draft.kind,before.kind);assert.equal(body.draft.status,'draft');
  assert.match(body.draft.asset.previewUrl,/^https:\/\/preview.invalid\//);assert.equal('storagePath' in body.draft.asset,false);
  const attached=await asset(id),after=await draft(id);
  assert.match(attached.storage_path,new RegExp(`^${OWNER}/post-assets/[a-f0-9]{16}-${id}\\.mp4$`));
  assert.deepEqual(admin.objects.get(attached.storage_path),bytes);assert.equal(attached.origin,'uploaded_existing');
  assert.equal(attached.mime_type,'video/mp4');assert.equal(Number(attached.byte_size),bytes.length);
  for(const key of ['content','title','proposed_publish_at','content_meta'])assert.deepEqual(after[key],before[key]);
  assert.equal(after.approved_content_version,null);assert.equal(await asset(id===VIDEO?SHORT:VIDEO),undefined);
  await assertNoSideEffects();assert.deepEqual(admin.errors,[]);
});
test('Mac-exported MP4 with 64-bit mdat size is accepted without rewriting its bytes',async t=>{
  const admin=await fixture(t),base=mp4({width:1280,height:720}),mdat=Buffer.alloc(20);
  mdat.writeUInt32BE(1,0);mdat.write('mdat',4);mdat.writeBigUInt64BE(20n,8);
  const bytes=new Uint8Array(Buffer.concat([base.slice(0,16),mdat,base.slice(16)]));
  assert.equal((await upload({bytes})).response.status,200);
  assert.deepEqual(admin.objects.get((await asset()).storage_path),bytes);await assertNoSideEffects();
});
test('malformed or out-of-bounds 64-bit MP4 box sizes fail closed',async t=>{
  const admin=await fixture(t),base=mp4(),mdat=Buffer.alloc(16);mdat.writeUInt32BE(1,0);mdat.write('mdat',4);
  for(const size of [8n,9999999n,9007199254740992n]){
    mdat.writeBigUInt64BE(size,8);assert.equal((await upload({bytes:new Uint8Array(Buffer.concat([base.slice(0,16),mdat,base.slice(16)]))})).response.status,400);
  }
  assert.equal(admin.objects.size,0);
});
test('same-byte retry retains a single durable attachment and does not revoke a later explicit approval',async t=>{
  await fixture(t);assert.equal((await upload()).response.status,200);
  await q("update mara_drafts set status='approved' where id=$1",[VIDEO]);const before=await draft();
  assert.equal((await upload()).response.status,200);assert.deepEqual(await draft(),before);
  assert.equal((await q('select count(*)::int as n from post_draft_assets'))[0].n,1);await assertNoSideEffects();
});
test('replacement revokes approval and stale synthetic declaration; cancels only this unclaimed queue row',async t=>{
  await fixture(t);await upload();await queued();
  await q("update mara_drafts set content_meta=content_meta||'{\"containsSyntheticMedia\":false,\"maraGeneratedVideo\":true}'::jsonb where id=$1",[VIDEO]);
  await q("update mara_drafts set status='approved' where id=$1",[VIDEO]);const before=await draft();
  const result=await upload({bytes:mp4({seconds:7})});assert.equal(result.response.status,200,JSON.stringify(result.body));
  const after=await draft();assert.equal(after.status,'draft');assert.equal(after.approved_content_version,null);
  assert.equal(after.content_meta.containsSyntheticMedia,undefined);assert.equal(after.content_meta.maraGeneratedVideo,true);
  for(const key of ['title','content','proposed_publish_at'])assert.deepEqual(after[key],before[key]);
  assert.equal((await q('select status from youtube_publish_queue'))[0].status,'cancelled');
  assert.equal((await q('select count(*)::int as n from voom_credit_ledger'))[0].n,0);
});
for(const status of ['uploading','provider_processing','published'])test(`reject media replacement after worker owns ${status} job`,async t=>{
  const admin=await fixture(t);await upload();
  await queued(status,status==='published'?{youtube_video_id:'test-video',provider_upload_status:'processed',published_at:'2099-01-01'}:{});
  const before=await asset(),state=await draft(),objects=admin.objects.size;
  const result=await upload({bytes:mp4({seconds:7})});assert.equal(result.response.status,409);
  assert.deepEqual(await asset(),before);assert.deepEqual(await draft(),state);assert.equal(admin.objects.size,objects);
});
test('failed row with a resumable provider session is protected by the final database check',async t=>{
  const admin=await fixture(t);await upload();await queued('failed',{upload_session_url:'https://upload.invalid/session'});
  const before=await asset();assert.equal((await upload({bytes:mp4({seconds:7})})).response.status,503);
  assert.deepEqual(await asset(),before);assert.equal(admin.objects.size,1);
});
test('claim between route preflight and final link wins safely; old media remains attached',async t=>{
  const admin=await fixture(t);await upload();await queued();const before=await asset();const rpc=admin.rpc;
  admin.rpc=async(name,args)=>{await q("update youtube_publish_queue set status='uploading' where draft_id=$1",[VIDEO]);return rpc(name,args);};
  assert.equal((await upload({bytes:mp4({seconds:7})})).response.status,503);
  assert.deepEqual(await asset(),before);assert.equal(admin.objects.size,1);
});
test('concurrent text edit makes stale upload fail without modifying the newer draft',async t=>{
  const admin=await fixture(t);const rpc=admin.rpc;
  admin.rpc=async(name,args)=>{await q("update mara_drafts set content='Newer text' where id=$1",[VIDEO]);return rpc(name,args);};
  assert.equal((await upload()).response.status,503);assert.equal((await draft()).content,'Newer text');
  assert.equal(await asset(),undefined);assert.equal(admin.objects.size,0);await assertNoSideEffects();
});
test('uncertain committed link and failed reference lookup retain recoverable media; retry never charges',async t=>{
  const admin=await fixture(t);const rpc=admin.rpc,from=admin.from;
  admin.rpc=async(name,args)=>{await rpc(name,args);return {data:null,error:{code:'lost-response'}};};
  admin.from=table=>{
    const chain=from(table),select=chain.select;
    chain.select=(cols,options)=>options?.head?{eq:()=>Promise.resolve({data:null,count:null,error:{code:'lookup-timeout'}})}:select(cols,options);
    return chain;
  };
  const uncertain=await upload();assert.equal(uncertain.response.status,503);assert.match(uncertain.body.error,/Reload this draft first/);
  const attached=await asset();assert.ok(admin.objects.has(attached.storage_path));
  admin.rpc=rpc;admin.from=from;assert.equal((await upload()).response.status,200);
  assert.equal(admin.objects.size,1);await assertNoSideEffects();
});
test('unauthenticated and foreign-owner uploads cannot attach, sign or remove media',async t=>{
  const admin=await fixture(t);globalThis.__youtubeUpload.user=null;
  assert.equal((await upload()).response.status,401);
  globalThis.__youtubeUpload.user={id:OTHER};assert.equal((await upload()).response.status,404);
  assert.equal(await getSocialDraft(admin,OTHER,VIDEO),null);
  assert.equal(await getPostDraftForIngestion(admin,OTHER,VIDEO),null);
  const deleted=await DELETE(new Request('https://test.invalid',{method:'DELETE'}),{params:Promise.resolve({id:VIDEO})});
  assert.equal(deleted.status,404);assert.equal(admin.objects.size,0);assert.equal(await asset(),undefined);
});
for(const [name,bytes] of [['fake.mp4',new TextEncoder().encode('not a video')],['image.mp4',new Uint8Array([137,80,78,71,13,10,26,10])],['truncated.mp4',mp4().slice(0,16)],['video.mov',mp4()],['empty.mp4',new Uint8Array()]])
test(`reject invalid or non-MP4 file ${name}`,async t=>{const admin=await fixture(t);assert.equal((await upload({name,bytes,mime:'video/mp4'})).response.status,400);assert.equal(admin.objects.size,0);await assertNoSideEffects();});
for(const dimensions of [{width:1920,height:1080},{seconds:181}])test(`Short rejects incompatible video ${JSON.stringify(dimensions)}`,async t=>{
  const admin=await fixture(t);assert.equal((await upload({id:SHORT,bytes:mp4(dimensions)})).response.status,400);assert.equal(admin.objects.size,0);
});
test('20 MiB limit enforced on actual file bytes and request size',async t=>{
  const admin=await fixture(t);assert.equal((await upload({bytes:new Uint8Array(20*1024*1024+1)})).response.status,413);
  assert.equal((await upload({headers:{'content-length':String(21*1024*1024)}})).response.status,413);assert.equal(admin.objects.size,0);
});
test('YouTube-specific 4 MiB cap leaves room for hosted multipart overhead',async t=>{
  const admin=await fixture(t),bytes=new Uint8Array(4*1024*1024+1);bytes.set(mp4());
  assert.equal((await upload({bytes})).response.status,413);assert.equal(admin.objects.size,0);
});
test('active AI generation cannot be overwritten by a manual upload',async t=>{
  const admin=await fixture(t),row=await draft();
  await q("insert into mara_media_generations(owner_user_id,draft_id,conversation_id,media_type,prompt,aspect_ratio,status,idempotency_key) values($1,$2,$3,'video','Synthetic fixture','9:16','processing','test-active-generation')",[OWNER,VIDEO,row.conversation_id]);
  assert.equal((await upload()).response.status,503);assert.equal(await asset(),undefined);assert.equal(admin.objects.size,0);
});
test('native DELETE cannot bypass safe media replacement',async t=>{
  await fixture(t);await upload();const before=await asset();
  const response=await DELETE(new Request('https://test.invalid',{method:'DELETE'}),{params:Promise.resolve({id:VIDEO})});
  assert.equal(response.status,409);assert.deepEqual(await asset(),before);
});
test('existing YouTube resumable worker reads exact private attachment and byte range without Google calls',async t=>{
  const admin=await fixture(t),bytes=mp4();await upload({bytes});const attached=await asset();
  const ports=buildYouTubeFlowPorts(admin,{},null,{},async()=>{},new Map());
  assert.equal(await ports.loadAsset(OTHER,VIDEO),null);
  const read=await ports.loadAsset(OWNER,VIDEO);assert.equal(read.storagePath,attached.storage_path);assert.equal(read.byteSize,bytes.length);
  globalThis.fetch=async(url,options)=>{
    assert.equal(new URL(url).hostname,'preview.invalid');assert.equal(options.headers.Range,'bytes=0-15');
    assert.equal(new URL(url).pathname.slice(1),attached.storage_path);return new Response(bytes.slice(0,16),{status:206});
  };
  const stream=await ports.openMediaRange(read.storagePath,0,15);assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()),bytes.slice(0,16));
  await assertNoSideEffects();
});
test('upload leaves privacy and audience undeclared, does not infer permission to publish',async t=>{
  const admin=await fixture(t);await q("update mara_drafts set content_meta='{}'::jsonb where id=$1",[VIDEO]);
  const {body}=await upload();assert.equal(body.draft.privacy,null);assert.equal(body.draft.madeForKids,null);assert.equal(body.draft.status,'draft');
  const saved=await updateSocialDraft(admin,OWNER,VIDEO,{decision:'draft'});assert.equal(saved.status,'draft');
  await assertNoSideEffects();
});
test('RPC is server-only, owner/path scoped and migration has no backfill or worker activation',async t=>{
  const admin=await fixture(t);
  for(const role of ['anon','authenticated'])assert.equal((await q("select has_function_privilege($1,'public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint)','execute') as allowed",[role]))[0].allowed,false);
  assert.equal((await q("select has_function_privilege('service_role','public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint)','execute') as allowed"))[0].allowed,true);
  for(const overrides of [{p_owner:OTHER},{p_path:`${OTHER}/post-assets/1234567890abcdef-${VIDEO}.mp4`},{p_bytes:20971521}]) {
    const result=await admin.rpc('attach_youtube_uploaded_video',{p_owner:OWNER,p_draft:VIDEO,p_version:1,p_path:`${OWNER}/post-assets/1234567890abcdef-${VIDEO}.mp4`,p_name:'test.mp4',p_bytes:200,...overrides});assert.ok(result.error);
  }
  assert.equal(await asset(),undefined);await assertNoSideEffects();
  const migration=await readFile(new URL('../supabase/migrations/0064_youtube_uploaded_video.sql',import.meta.url),'utf8');
  assert.match(migration,/begin;[\s\S]*commit;/);assert.doesNotMatch(migration,/cron\.schedule|http_post|alter table/i);
});
