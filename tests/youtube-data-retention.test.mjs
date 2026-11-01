import './helpers/server-only-shim.mjs';
import './helpers/youtube-deletion-transport-shim.mjs';
import assert from 'node:assert/strict';
import test,{before,after} from 'node:test';
import {registerHooks} from 'node:module';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb} from './helpers/native-video-db.mjs';
registerHooks({resolve(s,c,next){
  if(s==='@/lib/voom/server-data')return {shortCircuit:true,url:'data:text/javascript,export async function getCurrentUser(){return globalThis.__ytPrivacy.user}'};
  if(s==='@/utils/supabase/admin')return {shortCircuit:true,url:'data:text/javascript,export function createAdminClient(){return globalThis.__ytPrivacy.admin}'};
  return next(s,c);
}});
const privacy=await import('../lib/youtube/privacy.ts');
const data=await import('../lib/youtube/data.ts');
const {YouTubeApiError,YouTubeClient}=await import('../lib/youtube/client.ts');
const {DELETE}=await import('../app/api/integrations/youtube/data/route.ts');
const {YOUTUBE_SCOPES}=await import('../lib/youtube/scopes.ts');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const DA='33333333-3333-4333-8333-333333333333',DB='44444444-4444-4444-8444-444444444444';
const KEY='synthetic-youtube-privacy-key-32-characters';
const config={clientId:'fake',clientSecret:'fake',redirectUri:'https://test.invalid/api/integrations/youtube/callback',encryptionKey:KEY,legacyEncryptionKeys:[],projectAudited:false};
let db;
before(async()=>{({db}=await createSupabaseLite());});
after(()=>db?.close());
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
const count=async(table,owner=A)=>(await q(`select count(*)::int n from ${table} where owner_user_id=$1`,[owner]))[0].n;
function bridge(){
  const admin=nativeVideoDb(db);
  admin.rpc=(name,args={})=>{
    assert.match(name,/^[a-z_]+$/);
    const entries=Object.entries(args);entries.forEach(([k])=>assert.match(k,/^[a-z_]+$/));
    const call=`public.${name}(${entries.map(([k],i)=>`${k}=>$${i+1}`).join(',')})`;
    const setof=['get_youtube_connection_secret','claim_youtube_revocation_tasks','claim_youtube_deletion_events'].includes(name);
    const promise=(async()=>{
      await db.exec('savepoint privacy_rpc');
      try{const result=await q(setof?`select * from ${call}`:`select ${call} value`,entries.map(([,v])=>v));
        await db.exec('release savepoint privacy_rpc');
        return {data:JSON.parse(JSON.stringify(setof?result:result[0]?.value)),error:null};
      }catch(e){await db.exec('rollback to savepoint privacy_rpc; release savepoint privacy_rpc');return {data:null,error:{message:e.message}};}
    })();
    promise.maybeSingle=async()=>{const r=await promise;return {...r,data:r.data?.[0]??null};};
    return promise;
  };
  return admin;
}
async function connect(admin,owner=A,oauthState){
  await data.saveYouTubeConnection(admin,{ownerId:owner,channelId:`channel-${owner}`,channelTitle:'Private channel title',channelHandle:'@fake',thumbnailUrl:'https://fake.invalid/avatar',
    grantedScopes:[...YOUTUBE_SCOPES],refreshToken:'synthetic-refresh',accessToken:'synthetic-access',accessTokenExpiresAt:new Date(Date.now()+3600000).toISOString(),encryptionKey:KEY,oauthState});
}
async function fixture(t){
  await db.exec('begin');
  await q('insert into auth.users(id) values($1),($2)',[A,B]);
  for(const [owner,draft] of [[A,DA],[B,DB]]){
    const [c]=await q('insert into mara_conversations(owner_user_id) values($1) returning id',[owner]);
    await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content,content_meta) values($1,$2,$3,'youtube_video','youtube','youtube','video','My original title','My original caption #own','{\"privacy\":\"private\",\"madeForKids\":false}')",[draft,owner,c.id]);
  }
  const admin=bridge();await connect(admin);await connect(admin,B);
  globalThis.__ytPrivacy={admin,user:{id:A}};
  const old=globalThis.fetch;globalThis.fetch=async()=>{throw Error('External network forbidden');};
  t.after(async()=>{globalThis.fetch=old;delete globalThis.__ytPrivacy;await db.exec('rollback');});
  return admin;
}
async function publication(owner=A,draft=DA,status='published'){
  await q("update mara_drafts set status='approved' where id=$1",[draft]);
  const [row]=await q(`insert into youtube_publish_queue(owner_user_id,draft_id,youtube_format,title,privacy_status,made_for_kids,scheduled_at,status,idempotency_key,youtube_video_id,provider_upload_status,published_at,attempts)
    values($1,$2,'video','My original title','private',false,now(),$3,$4,$5,$6,$7,$8) returning id`,
    [owner,draft,status,`test-${draft}`,status==='published'?(owner===A?'fakevideo01':'fakevideo02'):null,status==='published'?'processed':null,status==='published'?new Date():null,status==='scheduled'?0:1]);
  if(status==='published'){
    await q('update mara_drafts set provider_ref=$2 where id=$1',[draft,'fakevideo01']);
    await q("insert into youtube_performance_snapshots(owner_user_id,draft_id,publish_queue_id,youtube_video_id,content_type,published_at,collected_at,metrics) values($1,$2,$3,'fakevideo01','video',now(),now(),'{\"views\":3}')",[owner,draft,row.id]);
  }
  return row.id;
}
async function renewedConsent(admin){
  const state=await data.createYouTubeOAuthState(admin,A);
  // Fixture transaction has a fixed now(); real requests use separate transactions.
  await q("update youtube_oauth_states set created_at=clock_timestamp()+interval '1 second' where owner_user_id=$1",[A]);
  assert.equal(await data.consumeYouTubeOAuthState(admin,A,state,state),true);return state;
}

test('erases only owner YouTube API data, including published evidence; preserves drafts and assets',async t=>{
  const admin=await fixture(t);await publication();await publication(B,DB);
  await q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'original.mp4','video/mp4',10,'uploaded_existing','uploaded')",[A,DA,`${A}/post-assets/1234567890abcdef-${DA}.mp4`]);
  const before=(await q('select content,title,content_meta,status from mara_drafts where id=$1',[DA]))[0];
  assert.equal((await privacy.eraseYouTubeData(admin,A)).erased,true);
  for(const table of ['youtube_connections','youtube_connection_secrets','youtube_oauth_states','youtube_publish_queue','youtube_performance_snapshots'])assert.equal(await count(table),0,table);
  assert.deepEqual((await q('select content,title,content_meta,status from mara_drafts where id=$1',[DA]))[0],before);
  assert.equal((await q('select provider_ref from mara_drafts where id=$1',[DA]))[0].provider_ref,null);
  assert.equal(await count('post_draft_assets'),1);assert.equal(await count('youtube_erased_publications'),1);
  assert.equal(await count('youtube_publish_queue',B),1);assert.equal(await count('youtube_connections',B),1);
  assert.equal((await q('select count(*)::int n from voom_credit_ledger'))[0].n,0);
});
test('repeated erasure is idempotent and revocation stores ciphertext only',async t=>{
  const admin=await fixture(t);await privacy.eraseYouTubeData(admin,A);await privacy.eraseYouTubeData(admin,A);
  assert.equal(await count('youtube_revocation_tasks'),1);
  const [task]=await q('select * from youtube_revocation_tasks where owner_user_id=$1',[A]);
  assert.ok(!JSON.stringify(task).includes('synthetic-refresh'));assert.equal(task.attempts,0);
});
test('revocation retries survive errors and acknowledge only the matching lease',async t=>{
  const admin=await fixture(t);await privacy.eraseYouTubeData(admin,A);
  let calls=0;const client={revokeToken:async token=>{calls++;assert.equal(token,'synthetic-refresh');return false;}};
  assert.deepEqual(await privacy.retryYouTubeRevocations(admin,KEY,client,A),{attempted:1,completed:0});
  assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_revocation_tasks'),1);
  await q("update youtube_revocation_tasks set next_attempt_at=now()-interval '1 minute' where owner_user_id=$1",[A]);
  assert.deepEqual(await privacy.retryYouTubeRevocations(admin,KEY,{revokeToken:async()=>true},A),{attempted:1,completed:1});assert.equal(calls,1);
  assert.equal(await count('youtube_revocation_tasks'),0);
});
test('two revocation claimers cannot receive the same task; wrong acknowledgement cannot delete it',async t=>{
  const admin=await fixture(t);await privacy.eraseYouTubeData(admin,A);
  const first=await admin.rpc('claim_youtube_revocation_tasks',{p_limit:1,p_owner:A});
  const second=await admin.rpc('claim_youtube_revocation_tasks',{p_limit:1,p_owner:A});
  assert.equal(first.data.length,1);assert.equal(second.data.length,0);
  const result=await admin.rpc('finish_youtube_revocation',{p_id:first.data[0].id,p_claim:'99999999-9999-4999-8999-999999999999',p_success:true});assert.equal(result.data,false);
  assert.equal(await count('youtube_revocation_tasks'),1);
});
test('pending revocation blocks reconnection; fresh consent cannot replay an erased publication',async t=>{
  const admin=await fixture(t);await publication();await privacy.eraseYouTubeData(admin,A);
  await assert.rejects(connect(admin,A,await renewedConsent(admin)),/youtube_connection_save_failed/);
  await privacy.retryYouTubeRevocations(admin,KEY,{revokeToken:async()=>true},A);
  await assert.rejects(connect(admin),/youtube_connection_save_failed/);
  await connect(admin,A,await renewedConsent(admin));
  const result=await admin.rpc('upsert_youtube_publish_queue_item',{p_owner_user_id:A,p_draft_id:DA,p_calendar_item_id:null,p_youtube_format:'video',p_title:'My original title',p_description:'',p_privacy_status:'private',p_made_for_kids:false,p_category_id:'22',p_scheduled_at:new Date(),p_waiting_for_media:false});
  assert.match(result.error.message,/youtube_previous_submission_erased_do_not_retry/);assert.equal(await count('youtube_publish_queue'),0);
  const {enqueueYouTubePublishItem}=await import('../lib/youtube/publish-queue.ts');
  await assert.rejects(enqueueYouTubePublishItem(admin,{ownerId:A,draftId:DA,calendarItemId:null,youtubeFormat:'video',title:'Test',description:'',privacyStatus:'private',madeForKids:false,scheduledAt:new Date().toISOString()}),/youtube_previous_submission_erased_do_not_retry/);
});
test('stale writes and cached provider clients cannot resurrect data after erasure',async t=>{
  const admin=await fixture(t);const job=await publication();const epoch=await privacy.assertYouTubeGrant(admin,A);
  let calls=0;const guarded=privacy.guardYouTubeClient({getVideo:async()=>{calls++;}},admin,A,epoch);
  await privacy.eraseYouTubeData(admin,A,false);
  await assert.rejects(guarded.getVideo('fake','fakevideo01'));assert.equal(calls,0);
  const r=await admin.from('youtube_performance_snapshots').insert({owner_user_id:A,publish_queue_id:job,youtube_video_id:'fakevideo01',content_type:'video',published_at:new Date(),collected_at:new Date(),metrics:{views:4}});
  assert.ok(r.error);assert.equal(await count('youtube_performance_snapshots'),0);
});
test('invalid_grant erases derived records immediately; a transient refresh failure does not',async t=>{
  const admin=await fixture(t);await publication();await q("update youtube_connections set access_token_expires_at=now()-interval '1 hour' where owner_user_id=$1",[A]);
  await assert.rejects(data.getYouTubeServerCredentials(admin,A,KEY,{refreshAccessToken:async()=>{throw new YouTubeApiError('network','token_refresh');}}));
  assert.equal(await count('youtube_publish_queue'),1);
  await assert.rejects(data.getYouTubeServerCredentials(admin,A,KEY,{refreshAccessToken:async()=>{throw new YouTubeApiError('auth','token_refresh','invalid_grant',400);}}));
  assert.equal(await count('youtube_publish_queue'),0);assert.equal(await count('youtube_connections'),0);
});
test('a failed purge leaves a durable block; maintenance can finish later',async t=>{
  const admin=await fixture(t);const rpc=admin.rpc;
  admin.rpc=(name,args)=>name==='erase_youtube_data'?Promise.resolve({data:null,error:{message:'timeout'}}):rpc(name,args);
  await assert.rejects(privacy.eraseYouTubeData(admin,A),/youtube_erasure_failed/);
  await assert.rejects(privacy.assertYouTubeGrant(admin,A));
  admin.rpc=rpc;assert.equal((await admin.rpc('prune_youtube_api_data',{p_limit:25})).error,null);assert.equal(await count('youtube_connections'),0);
});
test('published-row protection still rejects arbitrary deletes outside the erasure transaction',async t=>{
  const admin=await fixture(t);await publication();
  const r=await admin.from('youtube_publish_queue').delete().eq('owner_user_id',A);assert.match(r.error.message,/youtube_publish_already_published/);
});
test('account deletion purges YouTube evidence before FK cascades and retains a revocation task without owner identity',async t=>{
  const admin=await fixture(t);await publication();await privacy.eraseYouTubeData(admin,A);await q('delete from auth.users where id=$1',[A]);
  assert.equal(await count('youtube_publish_queue'),0);assert.equal(await count('youtube_connections'),0);
  assert.equal((await q('select owner_user_id from youtube_revocation_tasks'))[0].owner_user_id,null);
  assert.equal(await count('youtube_connections',B),1);
});
test('28-day cleanup removes stale API evidence and analytics, not original drafts',async t=>{
  const admin=await fixture(t);await publication();
  await q("update youtube_publish_queue set last_provider_check_at=now()-interval '29 days' where owner_user_id=$1",[A]);
  await q("update youtube_performance_snapshots set collected_at=now()-interval '29 days' where owner_user_id=$1",[A]);
  await privacy.runYouTubePrivacyMaintenance({db:admin,config:null});
  assert.equal(await count('youtube_publish_queue'),0);assert.equal(await count('youtube_performance_snapshots'),0);assert.equal(await count('mara_drafts'),1);assert.equal(await count('youtube_connections'),1);
});
test('idle or invalid connections are rechecked without uploads; transient errors do not advance verification',async t=>{
  const admin=await fixture(t);await q("update youtube_connections set authorization_checked_at=now()-interval '2 days'");
  let calls=0;const client={getMyChannel:async()=>{calls++;throw new YouTubeApiError('server','channel');}};
  const before=(await q('select authorization_checked_at from youtube_connections where owner_user_id=$1',[A]))[0].authorization_checked_at;
  await privacy.runYouTubePrivacyMaintenance({db:admin,config,client});assert.equal(calls,2);
  assert.deepEqual((await q('select authorization_checked_at from youtube_connections where owner_user_id=$1',[A]))[0].authorization_checked_at,before);
});
test('revocation ciphertext expires after six days even when provider configuration is disabled',async t=>{
  const admin=await fixture(t);await privacy.eraseYouTubeData(admin,A);
  const [deadline]=await q("select extract(epoch from expires_at-clock_timestamp())::int seconds from youtube_revocation_tasks");
  assert.ok(Math.abs(deadline.seconds-6*86400)<5,'unchanged 0065 gives a six-day retry credential, not seven');
  await q("update youtube_revocation_tasks set expires_at=now()-interval '1 second'");
  const result=await privacy.runYouTubePrivacyMaintenance({db:admin,config:null});assert.equal(result.operatorAttention,true);
  const [task]=await q('select encrypted_token,iv,auth_tag,expired from youtube_revocation_tasks');assert.deepEqual(task,{encrypted_token:null,iv:null,auth_tag:null,expired:true});
  const claimed=await admin.rpc('claim_youtube_revocation_tasks',{p_limit:1,p_owner:A});
  assert.deepEqual(claimed.data,[],'an expired credential is never claimable');
  await assert.rejects(connect(admin),/youtube_connection_save_failed/,'expiry is not confirmed revocation or permission to reconnect');
  assert.equal(await count('youtube_connections'),0);
});

test('expiry between the database claim and provider call cannot use the retry credential',async t=>{
  const admin=await fixture(t);await privacy.eraseYouTubeData(admin,A);
  const rpc=admin.rpc;
  for(const expires_at of [new Date(Date.now()-1000).toISOString(),undefined,'invalid-date']){
    admin.rpc=async(name,args)=>{
      const result=await rpc(name,args);
      if(name==='claim_youtube_revocation_tasks') for(const row of result.data??[])row.expires_at=expires_at;
      return result;
    };
    let calls=0;
    const result=await privacy.retryYouTubeRevocations(admin,KEY,{revokeToken:async()=>{calls++;return true;}},A);
    assert.equal(result.completed,0);assert.equal(calls,0);
    assert.equal(await count('youtube_revocation_tasks'),1,'unknown/expired use cannot falsely acknowledge revocation');
    await q("update youtube_revocation_tasks set next_attempt_at=now()-interval '1 second' where owner_user_id=$1",[A]);
  }
});

test('quarantined restore replay removes resurrected API data and retains no-repeat markers and originals',async t=>{
  const admin=await fixture(t);await publication();
  await q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'keep.mp4','video/mp4',100,'uploaded_existing','uploaded')",[A,DA,`${A}/youtube-uploads/${DA}.mp4`]);
  const originals=(await q('select title,content,content_meta,proposed_publish_at from mara_drafts where id=$1',[DA]))[0];
  const unrelated=(await q('select to_jsonb(c) row from youtube_connections c where owner_user_id=$1',[B]))[0];
  // Independent test-only journal survives the simulated rollback of DB state.
  // This is NOT an implemented external store or an authorization to restore.
  const independentJournal=[];
  await db.exec('savepoint pre_erasure_backup');
  independentJournal.push({owner:A,scope:'youtube_only'});
  await privacy.eraseYouTubeData(admin,A,false);
  assert.equal(await count('youtube_connections'),0);
  await db.exec('rollback to savepoint pre_erasure_backup');
  assert.equal(await count('youtube_connections'),1,'a restore can resurrect credentials');
  const [restoredBarrier]=await q('select blocked,erased_at from youtube_privacy_controls where owner_user_id=$1',[A]);
  assert.deepEqual(restoredBarrier,{blocked:false,erased_at:null},'the database journal and access block roll back too');
  // No provider call/worker is allowed in this quarantine simulation.
  for(const event of independentJournal)await privacy.eraseYouTubeData(admin,event.owner,false);
  for(const table of ['youtube_connections','youtube_connection_secrets','youtube_publish_queue','youtube_performance_snapshots'])assert.equal(await count(table),0);
  assert.equal(await count('youtube_erased_publications'),1);
  assert.equal(await count('post_draft_assets'),1);
  assert.deepEqual((await q('select title,content,content_meta,proposed_publish_at from mara_drafts where id=$1',[DA]))[0],originals);
  assert.deepEqual((await q('select to_jsonb(c) row from youtube_connections c where owner_user_id=$1',[B]))[0],unrelated);
  await assert.rejects(privacy.assertYouTubeGrant(admin,A));
  // Even a deliberately re-opened barrier cannot make an erased submission new.
  await q('update youtube_privacy_controls set blocked=false where owner_user_id=$1',[A]);
  const replay=await admin.rpc('upsert_youtube_publish_queue_item',{p_owner_user_id:A,p_draft_id:DA,p_calendar_item_id:null,p_youtube_format:'video',p_title:'Keep',p_description:'',p_privacy_status:'private',p_made_for_kids:false,p_category_id:'22',p_scheduled_at:new Date(),p_waiting_for_media:false});
  assert.match(replay.error.message,/youtube_previous_submission_erased_do_not_retry/);
});
test('authenticated and anonymous roles cannot run destructive RPCs or read pending secrets',async t=>{
  const admin=await fixture(t);
  const [r]=await q("select has_function_privilege('authenticated','public.erase_youtube_data(uuid,boolean,text)','execute') allowed,has_table_privilege('authenticated','public.youtube_revocation_tasks','select') readable");assert.deepEqual(r,{allowed:false,readable:false});
  const [server]=await q("select has_table_privilege('service_role','public.youtube_privacy_controls','update') writable,has_table_privilege('service_role','public.youtube_revocation_tasks','select') readable");assert.deepEqual(server,{writable:false,readable:false});
  await db.exec('set local role authenticated');await db.exec('savepoint denied');
  await assert.rejects(q('select public.erase_youtube_data($1)',[B]),/permission denied/);await db.exec('rollback to denied; reset role');
  await privacy.eraseYouTubeData(admin,A,false);
  await db.exec('set local role service_role');
  assert.equal((await q('select public.erase_youtube_data($1,false) receipt',[A]))[0].receipt.erased,true);
  await db.exec('reset role');
});
for(const [label,user,origin,body,status] of [
  ['signed out',null,'https://voom.today',{confirmation:'DELETE YOUTUBE DATA'},401],
  ['cross origin',{id:A},'https://evil.invalid',{confirmation:'DELETE YOUTUBE DATA'},403],
  ['no confirmation',{id:A},'https://voom.today',{},400],
  ['owner spoof',{id:A},'https://voom.today',{confirmation:'DELETE YOUTUBE DATA',owner:B},400],
])test(`erasure route rejects ${label}`,async t=>{
  await fixture(t);globalThis.__ytPrivacy.user=user;
  const response=await DELETE(new Request('https://voom.today/api/integrations/youtube/data',{method:'DELETE',headers:{origin,'content-type':'application/json'},body:JSON.stringify(body)}));
  assert.equal(response.status,status);assert.equal(await count('youtube_connections'),1);assert.equal(await count('youtube_connections',B),1);
});
test('explicit owner request erases only that owner and returns no provider data',async t=>{
  await fixture(t);const response=await DELETE(new Request('https://voom.today/api/integrations/youtube/data',{method:'DELETE',headers:{origin:'https://voom.today','content-type':'application/json'},body:JSON.stringify({confirmation:'DELETE YOUTUBE DATA'})}));
  assert.equal(response.status,200);assert.deepEqual(await response.json(),{erased:true,revocationPending:true});assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_connections',B),1);
});
test('Google invalid_token revocation is terminal success, not a retry loop',async()=>{
  const client=new YouTubeClient(config,async()=>Response.json({error:'invalid_token'},{status:400}));assert.equal(await client.revokeToken('fake'),true);
});
test('reconciliation route reuses its authenticated schedule and never schedules a new worker',async()=>{
  const route=await readFile(new URL('../app/api/cron/youtube-reconcile/route.ts',import.meta.url),'utf8');
  assert.ok(route.indexOf('bearerMatches(request, secret)')<route.indexOf('await runYouTubePrivacyMaintenance()'));
  assert.ok(route.indexOf('await runYouTubePrivacyMaintenance()')<route.indexOf('await runYouTubeReconciliation('));
});

test('erasure leaves non-YouTube content and settled media credits byte-for-byte intact',async t=>{
  const admin=await fixture(t);const [c]=await q('insert into mara_conversations(owner_user_id) values($1) returning id',[A]);
  const [post]=await q("insert into mara_drafts(owner_user_id,conversation_id,kind,channel,title,content,provider_ref) values($1,$2,'instagram_post','Instagram','Keep image','Keep caption','instagram-ref') returning *",[A,c.id]);
  const [credit]=await q("insert into voom_credit_ledger(owner_user_id,generation_id,media_type,credits,source,status) values($1,'synthetic-existing-video','video',40,'user_request','settled') returning *",[A]);
  await publication();await privacy.eraseYouTubeData(admin,A);
  assert.deepEqual((await q('select * from mara_drafts where id=$1',[post.id]))[0],post);
  assert.deepEqual((await q('select * from voom_credit_ledger where id=$1',[credit.id]))[0],credit);
  assert.equal((await q('select status from mara_drafts where id=$1',[DA]))[0].status,'draft');
});
test('provider result arriving after erasure is discarded; no further calls or restored history',async t=>{
  const admin=await fixture(t);await publication();const epoch=await privacy.assertYouTubeGrant(admin,A);
  let release,started;const begun=new Promise(r=>{started=r;});
  const client=privacy.guardYouTubeClient({getVideo:async()=>{started();return new Promise(r=>{release=r;});}},admin,A,epoch);
  const pending=client.getVideo('fake','fakevideo01');await begun;await privacy.eraseYouTubeData(admin,A,false);
  release({videoId:'fakevideo01',privacyStatus:'private'});await assert.rejects(pending);
  assert.equal(await count('youtube_publish_queue'),0);assert.equal(await count('youtube_performance_snapshots'),0);
});
test('an old provider error cannot erase a newer consent grant',async t=>{
  const admin=await fixture(t);const epoch=await privacy.assertYouTubeGrant(admin,A);let release,started;
  const begun=new Promise(r=>{started=r;});
  const client=privacy.guardYouTubeClient({getVideo:async()=>{started();return new Promise((r,reject)=>{release=reject;});}},admin,A,epoch);
  const pending=client.getVideo('fake','fakevideo01');await begun;await connect(admin);
  const replacement=await privacy.assertYouTubeGrant(admin,A);assert.notEqual(replacement,epoch);
  release(new YouTubeApiError('auth','video_read','authorization_revoked',401));await assert.rejects(pending);
  assert.equal(await privacy.assertYouTubeGrant(admin,A),replacement);
});

test('confirmed missing Google scope stops repeated access and erases only that grant',async t=>{
  const admin=await fixture(t);await publication();const epoch=await privacy.assertYouTubeGrant(admin,A);let calls=0;
  const client=privacy.guardYouTubeClient(new YouTubeClient(config,async()=>{calls++;return Response.json({error:{errors:[{reason:'insufficientPermissions'}]}},{status:403});}),admin,A,epoch);
  await assert.rejects(client.getVideo('fake','fakevideo01'));await assert.rejects(client.getVideo('fake','fakevideo01'));
  assert.equal(calls,1);assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_connections',B),1);
});

test('API-disabled and app-client configuration errors are not falsely treated as consent withdrawal',async t=>{
  const admin=await fixture(t);const epoch=await privacy.assertYouTubeGrant(admin,A);
  const client=privacy.guardYouTubeClient(new YouTubeClient(config,async()=>Response.json({error:{errors:[{reason:'accessNotConfigured'}]}},{status:403})),admin,A,epoch);
  await assert.rejects(client.getVideo('fake','fakevideo01'));assert.equal(await count('youtube_connections'),1);
  assert.equal(privacy.confirmedYouTubeAuthorizationLoss(new YouTubeApiError('auth','token_refresh','unauthorized_client',400)),false);
});
test('a delayed refresh cannot overwrite a replacement token grant',async t=>{
  const admin=await fixture(t);await q("update youtube_connections set access_token_expires_at=now()-interval '1 hour' where owner_user_id=$1",[A]);
  const client={refreshAccessToken:async()=>{await connect(admin);return {accessToken:'stale-refresh',expiresIn:3600,grantedScopes:YOUTUBE_SCOPES};}};
  await assert.rejects(data.getYouTubeServerCredentials(admin,A,KEY,client));
  const credentials=await data.getYouTubeServerCredentials(admin,A,KEY,{});assert.equal(credentials.accessToken,'synthetic-access');
});
test('the database rejects stale refresh persistence even after the final application check',async t=>{
  const admin=await fixture(t);const epoch=await privacy.assertYouTubeGrant(admin,A);await connect(admin);
  const r=await admin.rpc('update_youtube_access_token',{p_owner_user_id:A,p_encrypted_access_token:'stale',p_access_iv:'stale',p_access_auth_tag:'stale',p_access_key_version:2,p_access_token_expires_at:new Date(),p_expected_epoch:epoch});
  assert.equal(r.data,false);assert.equal((await data.getYouTubeServerCredentials(admin,A,KEY,{})).accessToken,'synthetic-access');
});
test('daily authorization checks refresh real metadata only on confirmed success',async t=>{
  const admin=await fixture(t);await q("update youtube_connections set authorization_checked_at=now()-interval '2 days'");
  const client={getMyChannel:async()=>({channelId:`channel-${A}`,title:'Updated title',handle:'@updated',thumbnailUrl:null})};
  const r=await privacy.runYouTubePrivacyMaintenance({db:admin,config,client});
  assert.equal(r.verified,1);assert.equal(await count('youtube_connections',B),0,'different channel identity is erased, not overwritten');
  assert.equal((await q('select channel_title from youtube_connections where owner_user_id=$1',[A]))[0].channel_title,'Updated title');
});
test('failed requests retain their original deadline and expose overdue backlog without provider data',async t=>{
  const admin=await fixture(t);await admin.rpc('request_youtube_erasure',{p_owner_user_id:A});
  await q("update youtube_privacy_controls set requested_at=now()-interval '8 days' where owner_user_id=$1",[A]);
  await admin.rpc('request_youtube_erasure',{p_owner_user_id:A});
  const result=await admin.rpc('youtube_privacy_backlog');assert.equal(Number(result.data.overdueErasures),1);
  await privacy.eraseYouTubeData(admin,A,false);const done=await admin.rpc('youtube_privacy_backlog');assert.equal(Number(done.data.overdueErasures),0);assert.equal(Number(done.data.lateErasures),1);
});

test('migration installs over existing connection and credit records without deletion or provider calls',async()=>{
  const local=await createSupabaseLite({stopBefore:'0065'});
  try{
    await local.db.query('insert into auth.users(id) values($1)',[A]);
    await local.db.query("insert into youtube_connections(owner_user_id,channel_id,channel_title) values($1,'keep-channel','Keep title')",[A]);
    await local.db.query("insert into voom_credit_ledger(owner_user_id,generation_id,media_type,credits,source,status) values($1,'preserve-credit','video',40,'user_request','settled')",[A]);
    const before=await local.db.query('select * from voom_credit_ledger');
    await local.applyPending();
    assert.deepEqual((await local.db.query('select * from voom_credit_ledger')).rows,before.rows);
    const [row]=(await local.db.query('select channel_id,channel_title,authorization_checked_at,authorization_epoch from youtube_connections')).rows;
    assert.equal(row.channel_id,'keep-channel');assert.equal(row.channel_title,'Keep title');assert.equal(row.authorization_checked_at,null);assert.match(row.authorization_epoch,/^[a-f0-9-]{36}$/);
    assert.equal((await local.db.query('select count(*)::int n from youtube_privacy_controls')).rows[0].n,0);
  }finally{await local.db.close();}
});
