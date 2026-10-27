import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb, mp4} from './helpers/native-video-db.mjs';
const {startNativePlanVideo, nativeVideoPorts, loadNativePlanVideoDraft}=await import('../lib/social/video-generation.ts');
const {buildVideoGenerationPorts}=await import('../lib/mara/video-ports.ts');
const {advanceVideoGeneration,validateGeneratedVideo}=await import('../lib/mara/video-generation.ts');
const {runVideoGenerationPoller}=await import('../lib/mara/video-poller.ts');
const {updateSocialDraft}=await import('../lib/social/server-drafts.ts');
const {MediaError}=await import('../lib/media/types.ts');
const {removePostAssetObject,putPostAsset}=await import('../lib/post/server-data.ts');
const OWNER='11111111-1111-4111-8111-111111111111', OTHER='22222222-2222-4222-8222-222222222222';
const TIKTOK='33333333-3333-4333-8333-333333333333', SHORT='44444444-4444-4444-8444-444444444444';
const META={caption:'Keep caption',hashtags:['#original'],script:['Existing scene one','Existing scene two'],
  productionGuidance:'Original vertical concept',privacy:'private',madeForKids:false,
  tiktokPost:{privacyLevel:'SELF_ONLY',disableDuet:true,disableStitch:true,consentConfirmed:true},containsSyntheticMedia:false};
let db;
before(async()=>{({db}=await createSupabaseLite());});
after(()=>db?.close());
const query=async(sql,args=[]) => (await db.query(sql,args)).rows;
async function fixture(t,{plan='pro',legacy=false}={}) {
  await db.exec('begin');t.after(()=>db.exec('rollback'));
  await query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
  const [business]=await query("insert into businesses(owner_user_id,plan,automation_level) values($1,$2,'manual') returning id",[OWNER,plan]);
  const [conv]=await query('insert into mara_conversations(owner_user_id) values($1) returning id',[OWNER]);
  const [marketing]=await query("insert into marketing_plans(owner_user_id,business_id,business_goal,weekly_strategy,selected_channels,content_frequency,valid_from,valid_until) values($1,$2,'Awareness','Strategy',array['tiktok','youtube'],7,'2099-01-01','2099-01-07') returning id",[OWNER,business.id]);
  for(const [id,kind,channel,format] of [[TIKTOK,'tiktok_video','tiktok','video'],[SHORT,'youtube_short','youtube','short']]) {
    await query("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,title,content,content_meta,source_plan_id,source_plan_item_key,social_channel,social_format,proposed_publish_at) values($1,$2,$3,$4,$5,'Original title','Original caption #original',$6,$7,$8,$5,$9,'2099-01-01T12:00:00Z')",[id,OWNER,conv.id,kind,channel,JSON.stringify(META),marketing.id,legacy&&id===SHORT?'2099-01-01':`2099-01-01|${kind}`,format]);
    await query("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'Existing upload','video/mp4',100,'uploaded_existing','uploaded')",[OWNER,id,`${OWNER}/uploads/${id}.mp4`]);
  }
  const admin=nativeVideoDb(db),calls={plan:0,submit:0,poll:0};let output={kind:'pending'},submitError=false,planError=false;
  const ports=buildVideoGenerationPorts({admin,provider:{name:'magic-hour',createVideoJob:async()=>{calls.submit++;if(submitError)throw new MediaError('rejected');return {providerJobId:'fake-job'};},pollVideoJob:async()=>{calls.poll++;return output;}},
    imageProvider:{name:'fake',generateImage:async()=>{throw new Error('unexpected image provider');}},brand:{name:'Synthetic',description:'test',industry:'test',targetCustomer:'test',mainGoal:'test',brandPersonality:'test'},plan:null});
  const clock=Date.now()+121_000;ports.now=()=>clock;
  ports.planMedia=async input=>{calls.plan++;calls.planInput=input;if(planError)throw new Error('fake planning failure');return {concept:'Original concept',visualPrompt:'Vertical scene',motionDirection:'Slow pan',durationSeconds:6,overlayJson:null,cta:'Original CTA'};};
  const service={admin,ownerId:OWNER,ports,videoConfig:{provider:'magic-hour',model:'fake-model',supportsImageToVideo:false,durationSeconds:6}};
  const start=(id=TIKTOK,token=randomUUID(),owner=OWNER)=>startNativePlanVideo(admin,owner,id,token,{buildService:async()=>service});
  const advance=(id,kind)=>advanceVideoGeneration(nativeVideoPorts(admin,ports,id),OWNER,id,kind);
  return {admin,ports,service,calls,start,advance,setOutput:value=>{output=value;},failSubmit:()=>{submitError=true;},failPlan:()=>{planError=true;}};
}
const draft=async id=>(await query('select * from mara_drafts where id=$1',[id]))[0];
const asset=async id=>(await query('select * from post_draft_assets where draft_id=$1',[id]))[0];
const ledger=()=>query('select generation_id,credits,status from voom_credit_ledger order by generation_id');
async function rejectSql(sql,args,pattern) {
  await db.exec('savepoint expected_failure');
  try {await assert.rejects(query(sql,args),pattern);}finally{await db.exec('rollback to savepoint expected_failure; release savepoint expected_failure');}
}

test('0063 installs only service-only RPCs and one guard; credit/storage RLS is retained',async()=>{
  const rows=await query("select p.proname,has_function_privilege('authenticated',p.oid,'execute') as browser,has_function_privilege('service_role',p.oid,'execute') as server,p.prosecdef from pg_proc p where p.proname in ('begin_native_video_generation','complete_native_video_generation','lock_native_video_draft','guard_native_video_generation_approval')");
  assert.equal(rows.length,4);assert.ok(rows.every(r=>!r.browser&&r.prosecdef));
  assert.deepEqual(rows.filter(r=>r.server).map(r=>r.proname).sort(),['begin_native_video_generation','complete_native_video_generation']);
  const tables=await query("select relname,relrowsecurity from pg_class where relname in ('mara_drafts','mara_media_generations','post_draft_assets','voom_credit_ledger')");
  assert.equal(tables.length,4);assert.ok(tables.every(r=>r.relrowsecurity));
  assert.equal((await query("select public from storage.buckets where id='mara-media'"))[0].public,false);
});
for(const [id,kind] of [[TIKTOK,'tiktok_video'],[SHORT,'youtube_short']]) test(`${kind}: real ledger → pending → MP4 attached to exact UUID, review only`,async t=>{
  const f=await fixture(t);const before=await draft(id),otherAsset=await asset(id===TIKTOK?SHORT:TIKTOK);
  const token=randomUUID();const result=await f.start(id,token);assert.equal(result.status,202,JSON.stringify(result));assert.equal(result.generation.status,'generating');
  assert.equal(f.calls.planInput.contentType,kind);assert.match(f.calls.planInput.script,/Existing scene one/);
  assert.deepEqual((await ledger()).map(r=>[r.credits,r.status]),[[40,'settled']]);
  const pending=await f.advance(result.generation.id,kind);assert.equal(pending.attached,false);
  f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4',extension:'mp4'}});
  const done=await f.advance(result.generation.id,kind);assert.equal(done.attached,true,JSON.stringify(done));assert.equal(done.generation.status,'completed');
  const after=await draft(id),attached=await asset(id);
  assert.equal(after.id,before.id);assert.equal(after.status,'draft');assert.equal(after.approved_content_version,null);
  for(const key of ['title','content','proposed_publish_at','source_plan_item_key','source_plan_id'])assert.deepEqual(after[key],before[key]);
  const preserved={...META};delete preserved.tiktokPost;if(kind==='youtube_short')delete preserved.containsSyntheticMedia;
  assert.deepEqual(after.content_meta,{...preserved,maraGeneratedVideo:true});
  assert.equal(attached.storage_path,`${OWNER}/native-video/${id}/${result.generation.id}.mp4`);
  assert.equal(attached.mime_type,'video/mp4');assert.equal(attached.byte_size,mp4().length);
  assert.deepEqual(await asset(id===TIKTOK?SHORT:TIKTOK),otherAsset);
  for(const table of ['tiktok_publish_queue','youtube_publish_queue','content_calendar_items'])assert.equal((await query(`select count(*)::int as n from ${table}`))[0].n,0);
  assert.equal(f.calls.submit,1);assert.equal((await ledger()).length,1);
  await f.advance(result.generation.id,kind);assert.equal(f.calls.submit,1);assert.equal((await ledger()).length,1);
  const duplicate=await f.start(id,token);assert.equal(duplicate.status,200);assert.equal(duplicate.generation.id,result.generation.id);assert.equal(f.calls.submit,1);assert.equal((await ledger()).length,1);
});
test('same click, repeated starts and concurrent fresh clicks submit only once and charge net 40',async t=>{
  const f=await fixture(t);const token=randomUUID();
  const results=await Promise.all([f.start(TIKTOK,token),f.start(TIKTOK,token),f.start(TIKTOK)]);
  assert.ok(results.some(r=>r.status===202),JSON.stringify(results));assert.equal(f.calls.submit,1);assert.equal(f.calls.plan,1);
  assert.equal((await ledger()).filter(r=>r.status!=='refunded').reduce((n,r)=>n+r.credits,0),40);
  const again=await f.start(TIKTOK,token);assert.ok([200,409].includes(again.status));assert.equal(f.calls.submit,1);
});
for(const [draftId,kind] of [[TIKTOK,'tiktok_video'],[SHORT,'youtube_short']])test(`${kind}: lost completion response plus failed reference lookup keeps the attached MP4 recoverable and charged only once`,async t=>{
  const f=await fixture(t),token=randomUUID();
  const started=await f.start(draftId,token),id=started.generation.id;
  const path=`${OWNER}/native-video/${draftId}/${id}.mp4`;
  const otherId=draftId===TIKTOK?SHORT:TIKTOK,otherAsset=await asset(otherId);
  const rpc=f.admin.rpc.bind(f.admin),from=f.admin.from.bind(f.admin);
  let failedLookups=0;
  f.admin.rpc=async(name,args)=>{
    const response=await rpc(name,args);
    if(name==='complete_native_video_generation') {
      assert.equal(response.data,true); // PostgreSQL committed; only the acknowledgement was lost.
      return {data:null,error:{code:'08006',message:'synthetic lost completion response'}};
    }
    return response;
  };
  f.admin.from=table=>{
    const chain=from(table),select=chain.select;
    chain.select=(columns,options)=>{
      select(columns,options);
      if(table==='mara_media_generations'&&options?.head) {
        chain.then=resolve=>{failedLookups++;return Promise.resolve(resolve({count:null,error:{code:'57014'}}));};
      }
      return chain;
    };
    return chain;
  };
  f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4',extension:'mp4'}});
  await f.advance(id,kind);
  assert.equal((await asset(draftId)).storage_path,path);
  assert.equal((await query('select status from mara_media_generations where id=$1',[id]))[0].status,'completed');
  assert.ok(f.admin.objects.has(path),'a lost acknowledgement must not delete an already attached MP4');
  // Even a later cleanup attempt with an unavailable reference read must fail closed.
  await removePostAssetObject(f.admin,OWNER,path);
  assert.ok(failedLookups>0);assert.ok(f.admin.objects.has(path));
  f.admin.from=from;f.admin.rpc=rpc;
  const recovered=await f.advance(id,kind);
  assert.equal(recovered.attached,true);assert.equal(recovered.generation.status,'completed');
  assert.ok(recovered.previewUrl);assert.deepEqual(f.admin.objects.get(path),mp4());
  assert.equal((await f.start(draftId,token)).generation.id,id);
  assert.equal(f.calls.submit,1);assert.deepEqual((await ledger()).map(r=>[r.credits,r.status]),[[40,'settled']]);
  assert.equal((await draft(draftId)).status,'draft');assert.deepEqual(await asset(otherId),otherAsset);
});
for(const outcome of ['error','missing response','readback failure'])test(`uncertain native completion (${outcome}) never authorizes deletion or a second paid job`,async t=>{
  const f=await fixture(t),token=randomUUID(),started=await f.start(TIKTOK,token),id=started.generation.id;
  const rpc=f.admin.rpc.bind(f.admin),read=f.ports.findGeneration;
  let completionRequested=false,removed=0;
  f.admin.rpc=async(name,args)=>{
    if(name!=='complete_native_video_generation')return rpc(name,args);
    completionRequested=true;
    if(outcome==='readback failure')return rpc(name,args);
    // No acknowledgement does not prove that the RPC failed to commit.
    return outcome==='error'?{data:null,error:{code:'08006'}}:{data:null,error:null};
  };
  f.ports.findGeneration=async(...args)=>{
    if(completionRequested&&outcome==='readback failure')throw new Error('synthetic readback outage');
    return read(...args);
  };
  const storage=f.admin.storage.from.bind(f.admin.storage);
  f.admin.storage.from=bucket=>({...storage(bucket),remove:async()=>{removed++;return {error:null};}});
  f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4'}});
  const result=await f.advance(id,'tiktok_video');
  assert.equal(result.generation.status,'processing');assert.equal(removed,0);
  assert.match(result.safeError,/couldn't confirm whether the video was saved/);
  assert.ok(f.admin.objects.has(`${OWNER}/native-video/${TIKTOK}/${id}.mp4`));
  f.admin.rpc=rpc;f.ports.findGeneration=read;
  const retry=await f.start(TIKTOK,token);
  assert.equal(retry.generation.id,id);assert.equal(f.calls.submit,1);
  assert.deepEqual((await ledger()).map(r=>[r.credits,r.status]),[[40,'settled']]);
});
test('a definitely refused completion still removes its genuinely unreferenced output',async t=>{
  const f=await fixture(t),started=await f.start(),id=started.generation.id;
  const rpc=f.admin.rpc.bind(f.admin),before=await asset(TIKTOK);
  f.admin.rpc=(name,args)=>name==='complete_native_video_generation'?Promise.resolve({data:false,error:null}):rpc(name,args);
  f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4'}});
  const done=await f.advance(id,'tiktok_video');
  assert.equal(done.attached,false);assert.equal(done.generation.status,'failed');
  assert.equal(f.admin.objects.has(`${OWNER}/native-video/${TIKTOK}/${id}.mp4`),false);
  assert.deepEqual(await asset(TIKTOK),before);
});
for(const failure of ['none','upsert rejected','upsert acknowledgement lost','previous read failed'])test(`Instagram upload cleanup: ${failure}`,async t=>{
  const f=await fixture(t);await query("update mara_drafts set kind='reel',social_channel='instagram',social_format='reel',channel='Instagram',source_plan_id=null,source_plan_item_key=null where id=$1",[TIKTOK]);
  const before=await asset(TIKTOK);f.admin.objects.set(before.storage_path,mp4());
  const input={bytes:mp4(),mimeType:'video/mp4',extension:'mp4',displayName:'Instagram reel',origin:'mara'};
  const initial=await putPostAsset(f.admin,OWNER,TIKTOK,input);
  await f.ports.removeAbandonedObject(OWNER,initial.previousStoragePath);
  assert.equal(f.admin.objects.has(before.storage_path),false,'genuinely unused previous media is still cleaned up');
  await f.ports.removeAbandonedObject(OWNER,initial.storagePath);
  assert.ok(f.admin.objects.has(initial.storagePath),'current Instagram attachment is protected');
  const from=f.admin.from.bind(f.admin);
  f.admin.from=table=>{
    const chain=from(table),upsert=chain.upsert,select=chain.select;
    chain.upsert=(...args)=>{
      upsert(...args);
      const then=chain.then;
      if(failure==='upsert rejected')chain.then=resolve=>Promise.resolve(resolve({data:null,error:{code:'08006'}}));
      if(failure==='upsert acknowledgement lost')chain.then=resolve=>then(()=>resolve({data:null,error:{code:'08006'}}));
      return chain;
    };
    chain.select=(...args)=>{
      select(...args);
      if(table==='post_draft_assets'&&args[0].includes('display_name')&&failure==='previous read failed') {
        chain.then=resolve=>Promise.resolve(resolve({data:null,error:{code:'57014'}}));
      }
      return chain;
    };
    return chain;
  };
  const replacement={...input,bytes:mp4({seconds:7})};
  if(failure==='none') {
    const replaced=await putPostAsset(f.admin,OWNER,TIKTOK,replacement);
    await f.ports.removeAbandonedObject(OWNER,replaced.previousStoragePath);
    assert.equal(f.admin.objects.has(initial.storagePath),false);
    assert.deepEqual(f.admin.objects.get(replaced.storagePath),replacement.bytes);
  } else {
    await assert.rejects(putPostAsset(f.admin,OWNER,TIKTOK,replacement));
    const attached=await asset(TIKTOK);
    assert.ok(f.admin.objects.has(attached.storage_path),'Instagram cannot lose a current/committed attachment on a failed request');
    assert.equal(f.admin.objects.size,failure==='upsert acknowledgement lost'?2:1,'only truly unused output may be removed');
    // Re-uploading identical bytes followed by a failed previous read must
    // not delete the digest-addressed object that already belongs to the draft.
    if(failure==='previous read failed') {
      await assert.rejects(putPostAsset(f.admin,OWNER,TIKTOK,input));
      assert.ok(f.admin.objects.has(initial.storagePath));
    }
  }
  assert.equal((await ledger()).length,0);
});
test('poll during early planning lease cannot kill an in-flight start',async t=>{
  const f=await fixture(t);const original=f.ports.planMedia;
  f.ports.planMedia=async input=>{
    const rows=await query('select id from mara_media_generations');
    const polled=await f.advance(rows[0].id,'tiktok_video');assert.equal(polled.generation.status,'queued');
    return original(input);
  };
  assert.equal((await f.start()).status,202);assert.equal(f.calls.submit,1);
});
test('ambiguous provider submission holds one reservation and blocks retries, even with a new click token',async t=>{
  const f=await fixture(t);f.ports.createVideoJob=async()=>{f.calls.submit++;throw new MediaError('unavailable');};
  const token=randomUUID();const failed=await f.start(TIKTOK,token);assert.equal(failed.status,503);assert.equal(failed.generation.status,'failed');assert.match(failed.generation.safeError,/Credits remain reserved/);
  assert.deepEqual((await ledger()).map(r=>r.status),['reserved']);
  assert.equal((await f.start(TIKTOK,token)).status,409);assert.equal((await f.start(TIKTOK)).status,409);
  assert.equal(f.calls.submit,1);assert.equal((await ledger()).length,1);
  const extra=randomUUID();await f.ports.reserveCredits({ownerId:OWNER,generationId:extra,mediaType:'video',source:'user_request'});
  const response=await f.admin.rpc('begin_native_video_generation',{p_owner:OWNER,p_draft:TIKTOK,p_generation:extra,p_key:`video:post:${TIKTOK}:${randomUUID()}`});
  assert.match(response.error.message,/native_video_submission_uncertain/);
});
test('provider acceptance followed by a lost database write cannot trigger another submission',async t=>{
  const f=await fixture(t);const original=f.ports.updateGeneration;
  f.ports.updateGeneration=async(...args)=>{if(args[2].provider_job_id)throw new Error('synthetic database outage');return original(...args);};
  await assert.rejects(f.start(),/synthetic database outage/);assert.equal(f.calls.submit,1);
  assert.equal((await f.start()).status,409);assert.equal(f.calls.submit,1);assert.deepEqual((await ledger()).map(r=>r.status),['reserved']);
});
for(const step of ['plan','submit'])test(`failed ${step} refunds the same 40-credit reservation; explicit retry is idempotent`,async t=>{
  const f=await fixture(t);const token=randomUUID(),before=await asset(TIKTOK);
  if(step==='plan')f.failPlan();else f.failSubmit();
  const failed=await f.start(TIKTOK,token);assert.equal(failed.status,503);assert.deepEqual((await ledger()).map(r=>r.status),['refunded']);assert.deepEqual(await asset(TIKTOK),before);
  const duplicate=await f.start(TIKTOK,token);assert.equal(duplicate.status,200);assert.equal(duplicate.generation.status,'failed');assert.equal((await ledger()).length,1);
  await f.start(TIKTOK,randomUUID());assert.equal((await ledger()).length,2);assert.ok((await ledger()).every(r=>r.status==='refunded'));
});
test('Free, cross-owner, long-form, malformed assignment and unplanned drafts never call a provider',async t=>{
  const f=await fixture(t,{plan:'free'});assert.equal((await f.start()).status,402);assert.equal(f.calls.submit,0);assert.equal((await ledger()).length,0);
  assert.equal((await f.start(TIKTOK,randomUUID(),OTHER)).status,404);
  await query("update mara_drafts set kind='youtube_video',social_format='video' where id=$1",[SHORT]);assert.equal((await f.start(SHORT)).status,404);
  await query("update mara_drafts set source_plan_item_key='2099-01-01|instagram_post' where id=$1",[TIKTOK]);assert.equal((await f.start()).status,404);
  assert.equal(await loadNativePlanVideoDraft(f.admin,OWNER,'not-a-uuid'),null);assert.equal(f.calls.plan,0);
});
test('legacy date-only assignment is accepted using the exact original UUID, not its same-day neighbour',async t=>{
  const f=await fixture(t,{legacy:true});assert.equal((await f.start(SHORT)).status,202);
  assert.equal((await query('select draft_id from mara_media_generations'))[0].draft_id,SHORT);
});
test('insufficient balance blocks provider calls without a negative balance',async t=>{
  const f=await fixture(t);await query("insert into voom_credit_ledger(owner_user_id,generation_id,media_type,credits,source,status) values($1,'already-used','video',100000,'user_request','settled')",[OWNER]);
  assert.equal((await f.start()).status,402);assert.equal(f.calls.submit,0);assert.equal((await ledger()).length,1);
});
test('existing approval and TikTok per-post consent are withdrawn; approval while generating fails',async t=>{
  const f=await fixture(t);await query("update mara_drafts set status='approved' where id=$1",[TIKTOK]);
  assert.equal((await draft(TIKTOK)).status,'approved');assert.equal((await f.start()).status,202);
  assert.equal((await draft(TIKTOK)).status,'draft');assert.equal((await draft(TIKTOK)).content_meta.tiktokPost,undefined);
  await rejectSql("update mara_drafts set status='approved' where id=$1",[TIKTOK],/native_video_review_after_generation/);
});
for(const [id,table,format,status,providerColumn] of [[TIKTOK,'tiktok_publish_queue',null,'posting','tiktok_publish_id'],[SHORT,'youtube_publish_queue','short','uploading','upload_session_url']]) {
  test(`${table}: unclaimed approved work is withdrawn, but a claimed/submitted job blocks replacement`,async t=>{
    const f=await fixture(t);await query("update mara_drafts set status='approved' where id=$1",[id]);
    await query(`insert into ${table}(owner_user_id,draft_id,title,scheduled_at,idempotency_key${format?',youtube_format':''}) values($1,$2,'Original title',now()+interval '1 day',$3${format?",'short'":''})`,[OWNER,id,`existing-queue-${id}`]);
    await query(`update ${table} set status=$1 where draft_id=$2`,[status,id]);
    const blocked=await f.start(id);assert.equal(blocked.status,503);assert.equal(f.calls.submit,0);assert.equal((await draft(id)).status,'approved');
    assert.ok((await ledger()).every(row=>row.status==='refunded'));
    await query(`update ${table} set status='scheduled' where draft_id=$1`,[id]);
    assert.equal((await f.start(id)).status,202);assert.equal((await query(`select status from ${table} where draft_id=$1`,[id]))[0].status,'cancelled');
    assert.equal((await draft(id)).status,'draft');
    // No terminal/provider state is silently reset by the adapter.
    assert.ok(providerColumn);
  });
}
test('existing video worker attaches a native result but never runs Instagram calendar/auto-approval',async t=>{
  const f=await fixture(t,{plan:'max'});await query("update businesses set automation_level='autopilot',allow_automatic_paid_media=true where owner_user_id=$1",[OWNER]);
  const start=await f.start();f.setOutput({kind:'complete',media:{bytes:mp4(),mimeType:'video/mp4'}});
  const [row]=await query('select * from mara_media_generations where id=$1',[start.generation.id]);
  let syncs=0;
  const result=await runVideoGenerationPoller({admin:f.admin,now:f.ports.now,ports:f.ports,provider:{name:'magic-hour'},
    jobs:[{row,kind:'tiktok_video'}],enforceTimeout:async()=>({enforced:false,row}),logger:()=>{},syncCalendar:async()=>{syncs++;}});
  assert.equal(result.completed,1,JSON.stringify(result));assert.equal(syncs,0);assert.equal((await draft(TIKTOK)).status,'draft');
});
test('saving generated Shorts preserves plan metadata, private audience settings and generation provenance',async t=>{
  const f=await fixture(t);const start=await f.start(SHORT);f.setOutput({kind:'complete',media:{bytes:mp4(),mimeType:'video/mp4'}});await f.advance(start.generation.id,'youtube_short');
  await updateSocialDraft(f.admin,OWNER,SHORT,{caption:'Reviewed caption',containsSyntheticMedia:true}).catch(error=>assert.fail(`${error.message}: ${JSON.stringify(f.admin.errors)}`));
  const saved=await draft(SHORT);assert.equal(saved.status,'draft');assert.equal(saved.content,'Reviewed caption');
  assert.equal(saved.content_meta.maraGeneratedVideo,true);assert.equal(saved.content_meta.containsSyntheticMedia,true);
  assert.deepEqual(saved.content_meta.hashtags,META.hashtags);assert.deepEqual(saved.content_meta.script,META.script);
  assert.equal(saved.content_meta.privacy,'private');assert.equal(saved.content_meta.madeForKids,false);
  assert.equal(new Date(saved.proposed_publish_at).toISOString(),'2099-01-01T12:00:00.000Z');
});
test('rejected draft or wrong-owner completion cannot replace an existing asset',async t=>{
  const f=await fixture(t);const result=await f.start();const before=await asset(TIKTOK);
  await query("update mara_drafts set status='rejected' where id=$1",[TIKTOK]);
  f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4'}});
  assert.equal((await f.advance(result.generation.id,'tiktok_video')).attached,false);assert.deepEqual(await asset(TIKTOK),before);
  const response=await f.admin.rpc('complete_native_video_generation',{p_owner:OTHER,p_generation:result.generation.id,p_path:'other',p_bytes:100,p_duration:6,p_name:'test'});
  assert.equal(response.data,false);
});
for(const [label,bytes] of [['horizontal',mp4({width:1920,height:1080})],['too long',mp4({seconds:60})],['not MP4',new Uint8Array([1,2,3])]])test(`invalid ${label} output leaves old video attached and never creates a publishing job`,async t=>{
  const f=await fixture(t);const result=await f.start(),before=await asset(TIKTOK);f.setOutput({kind:'completed',media:{bytes,mimeType:'video/mp4'}});
  const done=await f.advance(result.generation.id,'tiktok_video');assert.equal(done.attached,false);assert.equal(done.generation.error_code,'invalid_output');assert.deepEqual(await asset(TIKTOK),before);
});
test('native 20 MiB storage cap is enforced without changing the Instagram cap',()=>{
  const bytes=new Uint8Array(20*1024*1024+1);bytes.set(mp4());
  assert.ok(validateGeneratedVideo(bytes,'tiktok_video'));assert.equal(validateGeneratedVideo(bytes,'reel'),null);
});
test('generated YouTube Shorts require an explicit synthetic-media answer before approval',async t=>{
  const f=await fixture(t);const result=await f.start(SHORT);f.setOutput({kind:'completed',media:{bytes:mp4(),mimeType:'video/mp4'}});await f.advance(result.generation.id,'youtube_short');
  await query("update mara_drafts set content_meta=content_meta-'containsSyntheticMedia' where id=$1",[SHORT]);
  await rejectSql("update mara_drafts set status='approved' where id=$1",[SHORT],/youtube_synthetic_declaration_required/);
  await query("update mara_drafts set content_meta=content_meta||'{\"containsSyntheticMedia\":true}'::jsonb where id=$1",[SHORT]);
  await query("update mara_drafts set status='approved' where id=$1",[SHORT]);assert.equal((await draft(SHORT)).status,'approved');
});
test('route is authenticated, exact-owner scoped, same-origin, rate-limited and never calls approval or queue code',async()=>{
  const source=await readFile(new URL('../app/api/social-drafts/[id]/generation/route.ts',import.meta.url),'utf8');
  for(const pattern of [/getCurrentUser/,/sameOrigin/,/consumeAiRateLimit/,/startNativePlanVideo/,/loadNativePlanVideoDraft/,/user.id/])assert.match(source,pattern);
  assert.doesNotMatch(source,/upsert.*[Qq]ueue|syncPostToCalendar|approveDraft|publishTikTok|publishYouTube/);
});
