import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {registerHooks} from 'node:module';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite,migrationSql} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb,mp4} from './helpers/native-video-db.mjs';
registerHooks({resolve(s,c,next){
  if(s==='@/lib/voom/server-data')return {shortCircuit:true,url:'data:text/javascript,export async function getCurrentUser(){return globalThis.__directUpload.user}'};
  if(s==='@/utils/supabase/admin')return {shortCircuit:true,url:'data:text/javascript,export function createAdminClient(){return globalThis.__directUpload.admin}'};
  return next(s,c);
}});
const {POST,GET}=await import('../app/api/posts/[id]/video-upload/route.ts');
const {cleanupYouTubeUploads}=await import('../lib/youtube/upload-server.ts');
const {inspectYouTubeUpload,readPrivateVideoRange}=await import('../lib/youtube/upload-inspect.ts');
const {tusUploadOptions,uploadFingerprint}=await import('../lib/youtube/upload-client.ts');
const {buildYouTubeFlowPorts}=await import('../lib/youtube/publish-worker.ts');
const {removePostAssetObject}=await import('../lib/post/server-data.ts');
const {YOUTUBE_UPLOAD_BUCKET:BUCKET,YOUTUBE_DIRECT_UPLOAD_MAX_BYTES:MAX}=await import('../lib/youtube/upload-rules.ts');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222',D='33333333-3333-4333-8333-333333333333',S='44444444-4444-4444-8444-444444444444';
let db;before(async()=>{({db}=await createSupabaseLite());});after(()=>db?.close());
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
function video(opts={},payload=128){const mdat=Buffer.alloc(8+payload);mdat.writeUInt32BE(mdat.length);mdat.write('mdat',4);return new Uint8Array(Buffer.concat([mp4(opts),mdat]));}
async function fixture(t) {
  await db.exec('begin');await q('insert into auth.users(id) values($1),($2)',[A,B]);
  const [c]=await q('insert into mara_conversations(owner_user_id) values($1) returning id',[A]);
  for(const [id,kind,format] of [[D,'youtube_video','video'],[S,'youtube_short','short']])await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content,content_meta,proposed_publish_at) values($1,$2,$3,$4,'youtube','youtube',$5,'Keep title','Keep caption #tag','{\"privacy\":\"private\",\"madeForKids\":false,\"description\":\"Keep description\",\"script\":[\"Keep script\"]}','2099-01-01')",[id,A,c.id,kind,format]);
  const admin=nativeVideoDb(db),objects=new Map(),removed=[],signed=[];
  admin.rpc=async(name,args={})=>{
    assert.match(name,/^[a-z_]+$/);const entries=Object.entries(args);entries.forEach(([k])=>assert.match(k,/^[a-z_]+$/));
    const call=`public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})`;
    await db.exec('savepoint upload_rpc');
    const composite=['begin_youtube_upload','authorize_youtube_upload','claim_youtube_upload_validation','claim_youtube_upload_cleanup'].includes(name);
    try{const rows=await q(composite?`select * from ${call}`:`select ${call} value`,entries.map(([,v])=>v));await db.exec('release savepoint upload_rpc');return {data:JSON.parse(JSON.stringify(composite?rows:rows[0]?.value)),error:null};}
    catch(e){await db.exec('rollback to savepoint upload_rpc;release savepoint upload_rpc');return {data:null,error:{message:e.message}};}
  };
  admin.storage={
    async getBucket(bucket){assert.equal(bucket,BUCKET);return {data:{public:false,file_size_limit:MAX},error:null};},
    from(bucket){return {
      async info(path){const bytes=objects.get(path);return bytes?{data:{size:bytes.length,contentType:'video/mp4'},error:null}:{data:null,error:{statusCode:'404'}};},
      async createSignedUploadUrl(path,options){assert.equal(bucket,BUCKET);assert.equal(options.upsert,false);signed.push(path);return {data:{token:`fake.${Buffer.from(JSON.stringify({exp:Math.floor(Date.now()/1000)+7200})).toString('base64url')}.signature`,path},error:null};},
      async createSignedUrl(path,ttl){return {data:{signedUrl:`https://storage.invalid/${bucket}/${path}?ttl=${ttl}`},error:null};},
      async remove(paths){assert.equal(bucket,BUCKET);for(const p of paths){removed.push(p);objects.delete(p);}return {data:[],error:null};},
    };},
  };
  globalThis.__directUpload={admin,user:{id:A}};
  const old=globalThis.fetch,oldUrl=process.env.NEXT_PUBLIC_SUPABASE_URL;process.env.NEXT_PUBLIC_SUPABASE_URL='https://synthetic.supabase.co';
  const reads=[];
  globalThis.fetch=async(url,options)=>{
    const u=new URL(url);assert.equal(u.hostname,'storage.invalid','No external/provider calls allowed');
    const path=u.pathname.split('/').slice(2).join('/'),bytes=objects.get(path);assert.ok(bytes,'Object required');
    const match=/^bytes=(\d+)-(\d+)$/.exec(options.headers.Range);assert.ok(match);const start=Number(match[1]),end=Number(match[2]);reads.push([start,end]);
    return new Response(bytes.slice(start,end+1),{status:206,headers:{'content-range':`bytes ${start}-${end}/${bytes.length}`}});
  };
  t.after(async()=>{globalThis.fetch=old;if(oldUrl===undefined)delete process.env.NEXT_PUBLIC_SUPABASE_URL;else process.env.NEXT_PUBLIC_SUPABASE_URL=oldUrl;delete globalThis.__directUpload;await db.exec('rollback');});
  return {admin,objects,removed,signed,reads};
}
async function action(body,draft=D,extra={}){
  const response=await POST(new Request(`https://test.invalid/api/posts/${draft}/video-upload`,{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/json',...extra},body:JSON.stringify(body)}),{params:Promise.resolve({id:draft})});return {status:response.status,body:await response.json()};
}
async function begin(bytes=video(),draft=D,key=randomUUID()) {
  const result=await action({action:'start',key,name:'Original.mp4',size:bytes.length,fingerprint:'a'.repeat(64)},draft);assert.equal(result.status,200,JSON.stringify(result.body));
  const [row]=await q('select * from youtube_upload_sessions where id=$1',[result.body.upload.id]);return row;
}
const attach=async(ctx,bytes=video(),draft=D)=>{const u=await begin(bytes,draft);ctx.objects.set(u.storage_path,bytes);const r=await action({action:'complete',uploadId:u.id},draft);assert.equal(r.status,200,JSON.stringify(r.body));return u;};
const noJobs=async()=>{for(const table of ['youtube_publish_queue','tiktok_publish_queue','instagram_publish_queue','linkedin_publish_queue','voom_credit_ledger','mara_media_generations'])assert.equal((await q(`select count(*)::int n from ${table}`))[0].n,0,table);};
for(const draft of [D,S])test(`direct ${draft===D?'video':'Short'} >4MiB attaches exact private draft, keeps text/time/settings, no publishing/credits`,async t=>{
  const c=await fixture(t),before=(await q('select * from mara_drafts where id=$1',[draft]))[0],bytes=video({},5*1024*1024);
  const u=await attach(c,bytes,draft),after=(await q('select * from mara_drafts where id=$1',[draft]))[0];
  assert.equal(after.status,'draft');assert.equal(after.approved_content_version,null);
  for(const key of ['content','title','content_meta','proposed_publish_at'])assert.deepEqual(after[key],before[key]);
  assert.equal((await q('select storage_path from post_draft_assets where draft_id=$1',[draft]))[0].storage_path,u.storage_path);
  assert.ok(c.reads.reduce((n,[a,b])=>n+b-a+1,0)<1024,'Media payload not buffered for inspection');
  const ports=buildYouTubeFlowPorts(c.admin,{},null,{},async()=>{},new Map());const asset=await ports.loadAsset(A,draft);assert.equal(asset.byteSize,bytes.length);
  const stream=await ports.openMediaRange(asset.storagePath,0,15);assert.deepEqual(new Uint8Array(await new Response(stream).arrayBuffer()),bytes.slice(0,16));
  assert.equal(await ports.loadAsset(B,draft),null);await noJobs();
});
test('start and retry are idempotent; owner and request payload cannot be substituted',async t=>{
  await fixture(t);const key=randomUUID(),u=await begin(video(),D,key);assert.equal((await begin(video(),D,key)).id,u.id);
  assert.equal((await action({action:'start',key,name:'Original.mp4',size:999,fingerprint:'a'.repeat(64)})).status,409);
  globalThis.__directUpload.user={id:B};assert.equal((await action({action:'start',key:randomUUID(),name:'x.mp4',size:123,fingerprint:'a'.repeat(64)})).status,409);
  const response=await GET(new Request(`https://test.invalid?uploadId=${u.id}`),{params:Promise.resolve({id:D})});assert.equal((await response.json()).upload,null);
});
test('authorization requires correct owner/draft, private bucket, two-hour path-only grant and no upsert',async t=>{
  const c=await fixture(t),u=await begin();const r=await action({action:'authorize',uploadId:u.id});assert.equal(r.status,200,JSON.stringify(r));
  assert.equal(r.body.authorization.endpoint,'https://synthetic.storage.supabase.co/storage/v1/upload/resumable/sign');assert.equal(r.body.authorization.path,u.storage_path);assert.equal(r.body.authorization.bucket,BUCKET);assert.equal(c.signed.length,1);
  assert.ok(!JSON.stringify(r.body).includes('service_role'));
  assert.equal((await action({action:'authorize',uploadId:u.id},S)).status,409);
  c.admin.storage.getBucket=async()=>({data:{public:true,file_size_limit:MAX},error:null});assert.equal((await action({action:'authorize',uploadId:u.id})).status,503);
});
test('authentication, same origin, strict body fields and limits fail closed',async t=>{
  await fixture(t);const b={action:'start',key:randomUUID(),name:'x.mp4',size:1,fingerprint:'a'.repeat(64)};
  assert.equal((await action(b,D,{origin:'https://evil.invalid'})).status,403);
  for(const patch of [{owner:A},{name:'x.mov'},{size:MAX+1},{size:0},{size:1.5},{fingerprint:'x'},{extra:'x'.repeat(5000)}])assert.ok((await action({...b,...patch})).status>=400);
  globalThis.__directUpload.user=null;assert.equal((await action(b)).status,401);
  assert.equal((await q('select count(*)::int n from youtube_upload_sessions'))[0].n,0);
});
test('storage object size and real MP4 structure are independently validated',async t=>{
  const c=await fixture(t),bytes=video(),u=await begin(bytes);
  assert.equal((await action({action:'complete',uploadId:u.id})).body.code,'upload_not_complete');
  c.objects.set(u.storage_path,new Uint8Array(bytes.length+1));assert.equal((await action({action:'complete',uploadId:u.id})).status,400);
  const v=await begin(bytes);c.objects.set(v.storage_path,new Uint8Array(bytes.length));assert.equal((await action({action:'complete',uploadId:v.id})).status,400);
  assert.equal((await q('select count(*)::int n from post_draft_assets'))[0].n,0);await noJobs();
});
test('uncertain Storage metadata never starts a second upload or discards a valid object',async t=>{
  const c=await fixture(t),u=await begin();c.objects.set(u.storage_path,video());const from=c.admin.storage.from;
  c.admin.storage.from=bucket=>({...from(bucket),info:async()=>({data:null,error:{statusCode:'503'}})});
  assert.equal((await action({action:'complete',uploadId:u.id})).status,503);assert.equal(c.removed.length,0);assert.ok(c.objects.has(u.storage_path));
  c.admin.storage.from=from;assert.equal((await action({action:'complete',uploadId:u.id})).status,200);await noJobs();
});
test('invalid Shorts dimensions/duration do not replace an existing playable attachment',async t=>{
  const c=await fixture(t),original=await attach(c,video(),S);
  for(const settings of [{width:1920,height:1080},{seconds:181}]){
    const bytes=video(settings),u=await begin(bytes,S);c.objects.set(u.storage_path,bytes);assert.equal((await action({action:'complete',uploadId:u.id},S)).body.code,'invalid_short');
    assert.equal((await q('select storage_path from post_draft_assets where draft_id=$1',[S]))[0].storage_path,original.storage_path);
  }
});
test('replacement withdraws old approval and unclaimed job, preserves privacy/audience/caption/time',async t=>{
  const c=await fixture(t);await attach(c);
  await q("update mara_drafts set content_meta=content_meta||'{\"containsSyntheticMedia\":false}'::jsonb,status='approved' where id=$1",[D]);
  await q("insert into youtube_publish_queue(owner_user_id,draft_id,youtube_format,title,privacy_status,made_for_kids,scheduled_at,status,idempotency_key) values($1,$2,'video','Keep title','private',false,'2099-01-01','scheduled','youtube-direct-replacement')",[A,D]);
  const u=await attach(c,video({seconds:7}));const [d]=await q('select * from mara_drafts where id=$1',[D]);assert.equal(d.status,'draft');assert.equal(d.approved_content_version,null);assert.equal(d.content_meta.containsSyntheticMedia,undefined);assert.equal(d.content_meta.privacy,'private');assert.equal(d.content_meta.madeForKids,false);assert.equal(d.content,'Keep caption #tag');assert.equal((await q('select status from youtube_publish_queue'))[0].status,'cancelled');assert.equal(c.removed.length,0);assert.ok(c.objects.has(u.storage_path));
});
test('edit/version conflict cannot attach stale media; worker-owned jobs cannot be overwritten',async t=>{
  const c=await fixture(t),u=await begin();c.objects.set(u.storage_path,video());await q("update mara_drafts set content='New explicit edit' where id=$1",[D]);
  assert.equal((await action({action:'complete',uploadId:u.id})).body.code,'upload_draft_changed');assert.equal((await q('select count(*)::int n from post_draft_assets'))[0].n,0);
  await action({action:'cancel',uploadId:u.id});
  await q("insert into youtube_publish_queue(owner_user_id,draft_id,youtube_format,title,privacy_status,made_for_kids,scheduled_at,status,idempotency_key,upload_session_url) values($1,$2,'video','Keep title','private',false,now(),'uploading','youtube-direct-provider-owned','https://upload.invalid/session')",[A,D]);
  assert.equal((await action({action:'start',key:randomUUID(),name:'x.mp4',size:20,fingerprint:'a'.repeat(64)})).body.code,'upload_provider_owned');
});
test('lost final attachment response remains recoverable and never deletes or charges media',async t=>{
  const c=await fixture(t),u=await begin();c.objects.set(u.storage_path,video());const rpc=c.admin.rpc;
  c.admin.rpc=async(name,args)=>{const r=await rpc(name,args);return name==='finish_youtube_upload'?{data:null,error:{message:'synthetic response lost'}}:r;};
  assert.equal((await action({action:'complete',uploadId:u.id})).status,503);assert.ok(c.objects.has(u.storage_path));assert.equal(c.removed.length,0);
  c.admin.rpc=rpc;await q("update mara_drafts set status='approved' where id=$1",[D]);const before=(await q('select * from mara_drafts where id=$1',[D]))[0];
  assert.equal((await action({action:'complete',uploadId:u.id})).status,200);assert.deepEqual((await q('select * from mara_drafts where id=$1',[D]))[0],before);await noJobs();
});
test('cancel beats a validation lease without deleting active/previous media or allowing late attachment',async t=>{
  const c=await fixture(t),u=await begin();const claim=await c.admin.rpc('claim_youtube_upload_validation',{p_owner:A,p_draft:D,p_id:u.id});
  assert.equal((await action({action:'cancel',uploadId:u.id})).status,200);
  const result=await c.admin.rpc('finish_youtube_upload',{p_owner:A,p_draft:D,p_id:u.id,p_claim:claim.data[0].claim});assert.ok(result.error);assert.equal(c.removed.length,0);await noJobs();
});
test('expiry, daily allocation quota and validation leases prevent unbounded/duplicate work',async t=>{
  const c=await fixture(t),u=await begin();assert.equal((await c.admin.rpc('claim_youtube_upload_validation',{p_owner:A,p_draft:D,p_id:u.id})).error,null);
  assert.equal((await c.admin.rpc('claim_youtube_upload_validation',{p_owner:A,p_draft:D,p_id:u.id})).error.message,'upload_validation_busy');
  await action({action:'cancel',uploadId:u.id});
  for(let n=1;n<10;n++){const row=await begin();await action({action:'cancel',uploadId:row.id});}
  assert.equal((await action({action:'start',key:randomUUID(),name:'x.mp4',size:100,fingerprint:'a'.repeat(64)})).status,429);
  await q("update youtube_upload_sessions set expires_at=now()-interval '1 second' where id=$1",[u.id]);assert.ok((await action({action:'authorize',uploadId:u.id})).status>=400);
});
test('cleanup waits out capabilities, protects active references, cleans only replaced session objects',async t=>{
  const c=await fixture(t),old=await attach(c),current=await attach(c,video({seconds:8}));assert.deepEqual(await cleanupYouTubeUploads(c.admin),{checked:0,removed:0});
  await q("update youtube_upload_sessions set cleanup_after=now()-interval '1 second'");assert.deepEqual(await cleanupYouTubeUploads(c.admin),{checked:1,removed:1});
  assert.deepEqual(c.removed,[old.storage_path]);assert.ok(c.objects.has(current.storage_path));
  await removePostAssetObject(c.admin,A,current.storage_path);assert.deepEqual(c.removed,[old.storage_path]);
});
test('failed/uncertain reference check or failed storage deletion never authorizes a destructive success',async t=>{
  const c=await fixture(t),u=await begin();c.objects.set(u.storage_path,video());await action({action:'cancel',uploadId:u.id});await q("update youtube_upload_sessions set cleanup_after=now()-interval '1 second'");
  const rpc=c.admin.rpc;c.admin.rpc=async(name,args)=>name==='claim_youtube_upload_cleanup'?{data:null,error:{message:'timeout'}}:rpc(name,args);
  await assert.rejects(cleanupYouTubeUploads(c.admin));assert.equal(c.removed.length,0);assert.ok(c.objects.has(u.storage_path));
  c.admin.rpc=rpc;const from=c.admin.storage.from;c.admin.storage.from=bucket=>({...from(bucket),remove:async()=>({error:{message:'temporary outage'}})});
  assert.deepEqual(await cleanupYouTubeUploads(c.admin),{checked:1,removed:0});assert.equal((await q('select status from youtube_upload_sessions where id=$1',[u.id]))[0].status,'cancelled');assert.ok(c.objects.has(u.storage_path));
});
test('new session table and RPCs remain server-only; unrelated media size limits stay 20MiB',async t=>{
  await fixture(t);
  for(const role of ['anon','authenticated']){
    assert.equal((await q("select has_table_privilege($1,'public.youtube_upload_sessions','select,insert,update,delete') allowed",[role]))[0].allowed,false);
    assert.equal((await q("select has_function_privilege($1,'public.finish_youtube_upload(uuid,uuid,uuid,uuid)','execute') allowed",[role]))[0].allowed,false);
  }
  assert.equal((await q("select public from storage.buckets where id='youtube-uploads'"))[0].public,false);
  assert.equal((await q("select has_function_privilege('service_role','public.attach_youtube_uploaded_video_pre_direct(uuid,uuid,bigint,text,text,bigint)','execute') allowed"))[0].allowed,false);
  const c=(await q('select conversation_id from mara_drafts where id=$1',[D]))[0].conversation_id;
  const [ig]=await q("insert into mara_drafts(owner_user_id,conversation_id,kind,channel,title,content) values($1,$2,'instagram_post','Instagram','Image','Keep') returning id",[A,c]);
  await db.exec('savepoint size_check');await assert.rejects(q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'x.png','image/png',20971521,'uploaded_asset','uploaded')",[A,ig.id,`${A}/post-assets/old.png`]));await db.exec('rollback to savepoint size_check;release savepoint size_check');await noJobs();
});
test('migration upgrade and guarded rollback/reapplication preserve existing credits and original media',async()=>{
  const local=await createSupabaseLite({stopBefore:'0066'}),sql=async(s,args=[])=>(await local.db.query(s,args)).rows;
  try {
    const original=(await sql("select prosrc from pg_proc where oid='public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint)'::regprocedure"))[0].prosrc;
    await sql('insert into auth.users(id) values($1)',[A]);const [conversation]=await sql('insert into mara_conversations(owner_user_id) values($1) returning id',[A]);
    await sql("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,title,content) values($1,$2,$3,'instagram_post','Instagram','Original','Keep')",[D,A,conversation.id]);
    await sql("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'original.png','image/png',200,'uploaded_asset','uploaded')",[A,D,`${A}/post-assets/original.png`]);
    await sql("insert into voom_credit_ledger(owner_user_id,generation_id,media_type,credits,source,status) values($1,'synthetic-prior-settled','video',40,'user_request','settled')",[A]);
    const before=await sql('select to_jsonb(a) row from post_draft_assets a'),credits=await sql('select to_jsonb(c) row from voom_credit_ledger c'),bucket=await sql("select to_jsonb(b) row from storage.buckets b where id='mara-media'");
    await local.applyPending();assert.deepEqual(await sql('select to_jsonb(a) row from post_draft_assets a'),before);assert.deepEqual(await sql('select to_jsonb(c) row from voom_credit_ledger c'),credits);assert.deepEqual(await sql("select to_jsonb(b) row from storage.buckets b where id='mara-media'"),bucket);
    const rollback=await readFile(new URL('../supabase/rollbacks/0066_youtube_resumable_uploads.sql',import.meta.url),'utf8');await local.db.exec(rollback);
    assert.equal((await sql("select prosrc from pg_proc where oid='public.attach_youtube_uploaded_video(uuid,uuid,bigint,text,text,bigint)'::regprocedure"))[0].prosrc,original);
    await local.db.exec(migrationSql('0066_youtube_resumable_uploads.sql'));assert.deepEqual(await sql('select to_jsonb(c) row from voom_credit_ledger c'),credits);
    await sql("insert into youtube_upload_sessions(owner_user_id,draft_id,request_key,content_version,storage_path,display_name,byte_size,fingerprint) values($1,$2,$3,1,$4,'test.mp4',100,$5)",[A,D,randomUUID(),`${A}/youtube-uploads/${randomUUID()}.mp4`,'a'.repeat(64)]);
    await assert.rejects(local.db.exec(rollback),/youtube_upload_rollback_data_present/);await local.db.exec('rollback');
    assert.equal((await sql('select count(*)::int n from youtube_upload_sessions'))[0].n,1);assert.deepEqual(await sql('select to_jsonb(a) row from post_draft_assets a'),before);
  } finally {await local.db.close();}
});
test('bounded parser handles moov after extended mdat and rejects missing/truncated/huge boxes',async()=>{
  const base=mp4(),mdat=Buffer.alloc(16+1024);mdat.writeUInt32BE(1);mdat.write('mdat',4);mdat.writeBigUInt64BE(BigInt(mdat.length),8);
  const bytes=new Uint8Array(Buffer.concat([base.slice(0,16),mdat,base.slice(16)])),reads=[];
  assert.equal((await inspectYouTubeUpload(bytes.length,'original.mp4',async(a,b)=>{reads.push([a,b]);return bytes.slice(a,b+1);})).durationSeconds,6);
  assert.ok(reads.reduce((n,[a,b])=>n+b-a+1,0)<500);
  for(const bad of [mp4(),new Uint8Array(100),bytes.slice(0,-1)])await assert.rejects(inspectYouTubeUpload(bad.length,'x.mp4',async(a,b)=>bad.slice(a,b+1)));
});
test('range validation rejects whole-object fallback/oversized reads; TUS uses bounded no-upsert resume',async()=>{
  const old=fetch;try{globalThis.fetch=async()=>new Response(new Uint8Array(1024),{status:200});await assert.rejects(readPrivateVideoRange('https://storage.invalid/x',0,15));}finally{globalThis.fetch=old;}
  const options=tusUploadOptions({session:{id:D,fingerprint:'a'.repeat(64)},authorization:{token:'synthetic',endpoint:'https://storage.invalid/storage/v1/upload/resumable/sign',bucket:BUCKET,path:`${A}/youtube-uploads/${D}.mp4`},publishableKey:'sb_publishable_synthetic',onProgress(){},onSuccess(){},onError(){}});
  assert.equal(options.chunkSize,6*1024*1024);assert.deepEqual(options.headers,{apikey:'sb_publishable_synthetic','x-signature':'synthetic'},'signed TUS sends only the public key and the upload token');
  assert.throws(()=>tusUploadOptions({session:{id:D,fingerprint:'a'.repeat(64)},authorization:{token:'synthetic',endpoint:'https://storage.invalid/storage/v1/upload/resumable/sign',bucket:BUCKET,path:'x'},publishableKey:'',onProgress(){},onSuccess(){},onError(){}}),/configured/,'no public key: fail closed');assert.equal(options.headers['x-upsert'],undefined);assert.equal(options.removeFingerprintOnSuccess,true);
  assert.match(await options.fingerprint(),new RegExp(D));assert.throws(()=>options.onBeforeRequest({getURL:()=> 'https://evil.invalid/upload'}));
});
test('full-file identity detects changed middle bytes and permits only same-content resume',async()=>{
  const bytes=new Uint8Array(2*1024*1024+1),same=new File([bytes],'first.mp4',{lastModified:1});
  const first=await uploadFingerprint(same),renamed=await uploadFingerprint(new File([bytes],'renamed.mp4',{lastModified:2}));assert.equal(first,renamed);
  bytes[1024*1024]=1;assert.notEqual(await uploadFingerprint(new File([bytes],'first.mp4',{lastModified:1})),first);
});
test('another signed-in owner cannot authorize, complete, cancel or read someone else\'s upload',async t=>{
  const c=await fixture(t),u=await begin();c.objects.set(u.storage_path,video());
  globalThis.__directUpload.user={id:B};
  for(const act of ['authorize','complete','cancel'])assert.ok((await action({action:act,uploadId:u.id})).status>=400,act);
  const response=await GET(new Request(`https://test.invalid?uploadId=${u.id}`),{params:Promise.resolve({id:D})});assert.equal((await response.json()).upload,null);
  assert.equal(c.signed.length,0,'no storage grant was issued to another owner');
  assert.equal((await q('select status from youtube_upload_sessions where id=$1',[u.id]))[0].status,'pending','the owner\'s session is untouched');
  assert.equal((await q('select count(*)::int n from post_draft_assets'))[0].n,0);
  globalThis.__directUpload.user={id:A};assert.equal((await action({action:'complete',uploadId:u.id})).status,200,'the real owner can still finish it');
});
test('guarded rollback also refuses when the bucket holds objects or a large asset exists',async()=>{
  const local=await createSupabaseLite(),sql=async(s,args=[])=>(await local.db.query(s,args)).rows;
  const rollback=await readFile(new URL('../supabase/rollbacks/0066_youtube_resumable_uploads.sql',import.meta.url),'utf8');
  try {
    // Hosted Storage has storage.objects; the embedded database does not, so model it here.
    await sql('create table storage.objects(bucket_id text,name text)');
    await sql("insert into storage.objects values('youtube-uploads','orphan.mp4')");
    await assert.rejects(local.db.exec(rollback),/youtube_upload_rollback_objects_present/);await local.db.exec('rollback');
    await sql("delete from storage.objects");
    await sql('insert into auth.users(id) values($1)',[A]);const [conversation]=await sql('insert into mara_conversations(owner_user_id) values($1) returning id',[A]);
    await sql("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content) values($1,$2,$3,'youtube_video','youtube','youtube','video','Large','Keep')",[D,A,conversation.id]);
    await sql("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'big.mp4','video/mp4',30000000,'uploaded_existing','uploaded')",[A,D,`${A}/youtube-uploads/${randomUUID()}.mp4`]);
    await assert.rejects(local.db.exec(rollback),/youtube_upload_rollback_data_present/);await local.db.exec('rollback');
    assert.equal((await sql("select count(*)::int n from storage.buckets where id='youtube-uploads'"))[0].n,1,'refused rollback leaves the bucket in place');
    assert.equal((await sql('select count(*)::int n from post_draft_assets'))[0].n,1,'and the large asset intact');
  } finally {await local.db.close();}
});
test('customers are offered only what hosted Storage accepts: 50 MiB by default, raised only by valid server configuration',async t=>{
  const c=await fixture(t),old=process.env.YOUTUBE_UPLOAD_MAX_BYTES;
  t.after(()=>{if(old===undefined)delete process.env.YOUTUBE_UPLOAD_MAX_BYTES;else process.env.YOUTUBE_UPLOAD_MAX_BYTES=old;});
  const status=async()=>(await (await GET(new Request('https://test.invalid'),{params:Promise.resolve({id:D})})).json()).maxBytes;
  const start=size=>action({action:'start',key:randomUUID(),name:'Original.mp4',size,fingerprint:'a'.repeat(64)});
  const sessions=async()=>(await q('select count(*)::int n from youtube_upload_sessions'))[0].n;
  delete process.env.YOUTUBE_UPLOAD_MAX_BYTES;
  assert.equal(await status(),52428800,'default effective limit is 52,428,800 bytes (50 MiB)');
  const over=await start(52428801);assert.equal(over.status,413);assert.equal(over.body.code,'upload_too_large');assert.match(over.body.error,/larger than 50 MB/);
  assert.equal(await sessions(),0,'an oversized request never creates a session');
  for(const bad of ['abc','0','-1','1.5','268435457','99999999999999999999'])
    {process.env.YOUTUBE_UPLOAD_MAX_BYTES=bad;assert.equal(await status(),52428800,`invalid configuration ${bad} falls back to 50 MiB`);}
  process.env.YOUTUBE_UPLOAD_MAX_BYTES=String(MAX);assert.equal(await status(),MAX,'the full 256 MiB architecture once configured');
  const big=await start(MAX);assert.equal(big.status,200);
  // Lowering the limit again: the larger pending session gets no Storage grant.
  delete process.env.YOUTUBE_UPLOAD_MAX_BYTES;
  const grant=await action({action:'authorize',uploadId:big.body.upload.id});assert.equal(grant.status,413);assert.equal(c.signed.length,0);
  await action({action:'cancel',uploadId:big.body.upload.id});
  const exact=await start(52428800);assert.equal(exact.status,200,'exactly 50 MiB is accepted');
});
