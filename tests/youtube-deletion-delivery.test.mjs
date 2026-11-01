import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test, {before, after} from 'node:test';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite, migrationSql} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb} from './helpers/native-video-db.mjs';
const {createDeletionTransport, journalEnvelope}=await import('../lib/youtube/deletion-delivery.ts');
const {eraseYouTubeData, runYouTubePrivacyMaintenance, assertYouTubeGrant}=await import('../lib/youtube/privacy.ts');

const A='11111111-1111-4111-8111-111111111111', B='22222222-2222-4222-8222-222222222222';
const env={YOUTUBE_DELETION_DELIVERY_APPROVED:'true',YOUTUBE_DELETION_JOURNAL_URL:'https://journal.example/events',
  YOUTUBE_DELETION_JOURNAL_TOKEN:'synthetic-journal-credential-32-chars',YOUTUBE_DELETION_ALERT_URL:'https://alerts.example/events',
  YOUTUBE_DELETION_ALERT_TOKEN:'synthetic-alert-credential-32-chars'};
const event={id:A,owner_user_id:B,scope:'erase',requested_at:'2026-10-31T00:00:00Z',cutoff_at:null,
  journal_receipt:null,failure_code:null,failed_at:null,alerted_at:null,claim:A,applied_at:null,completion_receipt:null};
function receiver(){
  const records=new Map(),calls=[];let failJournal=false,failAlert=false,lostAck=false,failCompletion=false;
  return {records,calls,set journalFailure(v){failJournal=v;},set alertFailure(v){failAlert=v;},set lostAck(v){lostAck=v;},set completionFailure(v){failCompletion=v;},
    async request(url,init){
      calls.push({url,id:init.headers['Idempotency-Key'],body:JSON.parse(init.body)});
      assert.equal(init.redirect,'error');assert.equal(init.cache,'no-store');assert.ok(init.signal);
      const body=JSON.parse(init.body),alert=url.includes('alerts.example');
      if(alert?failAlert:failJournal || (failCompletion && body.stage==='active_erasure'))return Response.json({error:'sensitive-provider-message'},{status:503});
      const id=init.headers['Idempotency-Key'],hash=createHash('sha256').update(init.body).digest('hex');
      const prior=records.get(id);if(prior)assert.equal(prior.payloadSha256,hash,'same id always has identical immutable payload');
      const ack=prior??{eventId:id,payloadSha256:hash,durable:true,receiptId:'synthetic-receipt:'+id};records.set(id,ack);
      if(lostAck){lostAck=false;throw Error('lost response with secret');}return Response.json(ack);
    }};
}
test('disabled or unapproved destinations never cause external I/O',async()=>{
  let calls=0;const request=async()=>{calls++;throw Error('network forbidden');};
  for(const candidate of [{},{...env,YOUTUBE_DELETION_DELIVERY_APPROVED:'false'},{...env,YOUTUBE_DELETION_ALERT_TOKEN:''}]){
    const t=createDeletionTransport(candidate,request);await assert.rejects(t.journal(event),/destination_unavailable/);
  }assert.equal(calls,0);
});
for(const url of ['http://journal.example','https://localhost','https://127.0.0.1','https://[::1]','https://journal.example?secret=x','https://user:pass@journal.example','https://journal.internal'])
  test('rejects unsafe destination '+url,async()=>{let calls=0;await assert.rejects(createDeletionTransport({...env,YOUTUBE_DELETION_JOURNAL_URL:url},async()=>{calls++;}).journal(event));assert.equal(calls,0);});
test('requires a bounded durable receipt for the exact id and payload',async()=>{
  for(const reply of [()=>Response.json({}, {status:202}),()=>Response.json({durable:true}),()=>Response.json({eventId:A,payloadSha256:'wrong',durable:true,receiptId:'r'}),()=>new Response('x'.repeat(4097)),()=>{throw Error('secret-token');}]){
    await assert.rejects(createDeletionTransport(env,async()=>reply()).journal(event),e=>e.message==='youtube_deletion_capture_failed');
  }
});
test('lost acknowledgments reuse immutable event and alert identities',async()=>{
  const r=receiver(),t=createDeletionTransport(env,r.request);r.lostAck=true;
  await assert.rejects(t.journal(event));await t.journal(event);assert.equal(r.records.size,1);
  await t.alert(event,'capture_failed');await t.alert({...event,failed_at:'2026-11-01T00:00:00Z'},'capture_failed');assert.equal(r.records.size,2);
  const body=journalEnvelope(event);assert.equal(body.deadlineAt,'2026-11-07T00:00:00.000Z');
  assert.equal(journalEnvelope({...event,scope:'retention',cutoff_at:event.requested_at}).deadlineAt,null);
  assert.deepEqual(Object.keys(body),['version','eventId','ownerId','scope','receivedAt','deadlineAt','cutoffAt']);
});
let db;
before(async()=>{({db}=await createSupabaseLite());});after(()=>db?.close());
const q=async(sql,args=[])=>(await db.query(sql,args)).rows;
async function fixture(t){
  await db.exec('begin');await q('insert into auth.users(id) values($1),($2)',[A,B]);
  for(const owner of [A,B])await q("insert into youtube_connections(owner_user_id,channel_id,channel_title,status,connected_at) values($1,$2,'Synthetic','connected',now())",[owner,'channel-'+owner]);
  const admin=nativeVideoDb(db),rpc=admin.rpc;
  admin.rpc=async(name,args)=>{
    if(name!=='claim_youtube_deletion_events')return rpc(name,args);
    try{return {data:(await q('select * from claim_youtube_deletion_events($1,$2)',[args.p_limit,args.p_owner])).map(v=>JSON.parse(JSON.stringify(v))),error:null};}catch(e){return {data:null,error:{message:e.message}};}
  };
  const old=Object.fromEntries(Object.keys(env).map(k=>[k,process.env[k]])),fetchBefore=globalThis.fetch,r=receiver();
  Object.assign(process.env,env);globalThis.fetch=r.request;
  t.after(async()=>{globalThis.fetch=fetchBefore;for(const [k,v] of Object.entries(old))if(v===undefined)delete process.env[k];else process.env[k]=v;await db.exec('rollback');});
  return {admin,r};
}
const count=async(table,owner=A)=>(await q(`select count(*)::int n from ${table} where owner_user_id=$1`,[owner]))[0].n;
const due=()=>q("update youtube_deletion_events set retry_at=now()-interval '1 second'");
test('unavailable journal blocks erasure and further access, survives retries, then recovers',async t=>{
  const {admin,r}=await fixture(t);r.journalFailure=true;r.alertFailure=true;
  await assert.rejects(eraseYouTubeData(admin,A),/capture_pending/);assert.equal(await count('youtube_connections'),1);
  await assert.rejects(assertYouTubeGrant(admin,A));
  const [first]=await q('select * from youtube_deletion_events');assert.equal(first.failure_code,'capture_failed');assert.equal(first.alerted_at,null);
  await assert.rejects(eraseYouTubeData(admin,A));assert.equal(await count('youtube_deletion_events'),1);
  const [again]=await q('select id,requested_at from youtube_deletion_events');assert.equal(again.id,first.id);assert.deepEqual(again.requested_at,first.requested_at);
  r.journalFailure=false;r.alertFailure=false;await due();await eraseYouTubeData(admin,A,false);
  assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_connections',B),1);
  const [done]=await q('select * from youtube_deletion_events');assert.ok(done.recorded_at&&done.applied_at&&done.completion_receipt&&done.alerted_at);
  await eraseYouTubeData(admin,A,false);assert.equal(await count('youtube_deletion_events'),1);assert.equal(r.records.size,3);
});
test('missing configured destination leaves a durable request and truthful maintenance failure',async t=>{
  const {admin,r}=await fixture(t);delete process.env.YOUTUBE_DELETION_DELIVERY_APPROVED;
  await assert.rejects(eraseYouTubeData(admin,A),/capture_pending/);
  assert.equal(r.calls.length,0);assert.equal((await q('select failure_code from youtube_deletion_events'))[0].failure_code,'destination_unavailable');
  assert.equal((await runYouTubePrivacyMaintenance({db:admin,config:null})).operatorAttention,true);
  assert.equal(await count('youtube_connections'),1);
});
test('authorization loss discovered during maintenance reports a new capture failure in the same run',async t=>{
  const {admin,r}=await fixture(t),rpc=admin.rpc,key='synthetic-maintenance-key';
  const {encryptYouTubeToken}=await import('../lib/youtube/crypto.ts');
  const {YouTubeApiError}=await import('../lib/youtube/client.ts');
  const refresh=encryptYouTubeToken('synthetic-refresh',key),access=encryptYouTubeToken('synthetic-access',key);
  admin.rpc=(name,args)=>name==='get_youtube_connection_secret'?{async maybeSingle(){return {error:null,data:{
    connection_status:'connected',channel_id:'channel-'+A,scopes:[],encrypted_refresh_token:refresh.encryptedToken,refresh_iv:refresh.iv,refresh_auth_tag:refresh.authTag,
    encrypted_access_token:access.encryptedToken,access_iv:access.iv,access_auth_tag:access.authTag,access_token_expires_at:new Date(Date.now()+3600000).toISOString(),
  }};}}:rpc(name,args);
  await q('update youtube_connections set authorization_checked_at=now() where owner_user_id=$1',[B]);
  delete process.env.YOUTUBE_DELETION_DELIVERY_APPROVED;let calls=0;
  const result=await runYouTubePrivacyMaintenance({db:admin,config:{encryptionKey:key,legacyEncryptionKeys:[]},client:{getMyChannel:async()=>{calls++;throw new YouTubeApiError('auth','channel','no_channel');}}});
  assert.equal(calls,1);assert.equal(result.operatorAttention,true);assert.equal(await count('youtube_deletion_events'),1);
  await assert.rejects(assertYouTubeGrant(admin,A));assert.equal(r.calls.length,0);
});
test('lost journal response cannot erase early or create a second logical request',async t=>{
  const {admin,r}=await fixture(t);r.lostAck=true;await assert.rejects(eraseYouTubeData(admin,A),/capture_pending/);
  assert.equal(await count('youtube_connections'),1);await due();await eraseYouTubeData(admin,A,false);
  assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_deletion_events'),1);
  assert.equal(r.calls.filter(c=>c.body.scope==='erase'&&!c.body.stage).length,2);
});
test('active erasure is not reported complete while external completion delivery fails',async t=>{
  const {admin,r}=await fixture(t);r.completionFailure=true;
  await assert.rejects(eraseYouTubeData(admin,A,false),/delivery_pending/);assert.equal(await count('youtube_connections'),0);
  const [row]=await q('select * from youtube_deletion_events');assert.ok(row.applied_at);assert.equal(row.completion_receipt,null);
  r.completionFailure=false;await due();await eraseYouTubeData(admin,A,false);assert.equal(await count('youtube_deletion_events'),1);
});
test('lost database delivery receipt alerts independently and retries without duplicate external events',async t=>{
  const {admin,r}=await fixture(t),rpc=admin.rpc;
  admin.rpc=(name,args)=>name==='finish_youtube_deletion_event'?Promise.resolve({data:false,error:null}):rpc(name,args);
  await assert.rejects(eraseYouTubeData(admin,A,false),/delivery_unconfirmed/);assert.equal(await count('youtube_connections'),1);
  assert.ok(r.calls.some(c=>c.body.code==='delivery_unconfirmed'));
  admin.rpc=rpc;await q("update youtube_deletion_events set claimed_until=now()-interval '1 second',retry_at=now()");
  await eraseYouTubeData(admin,A,false);assert.equal(await count('youtube_deletion_events'),1);assert.equal(await count('youtube_connections'),0);
  assert.equal(r.records.size,3,'one intent, one failure alert, one completion');
});
test('database purge failure remains blocked, alerts durably, and maintenance retries safely',async t=>{
  const {admin,r}=await fixture(t),rpc=admin.rpc;
  admin.rpc=(name,args)=>name==='erase_youtube_data'?Promise.resolve({data:null,error:{message:'private SQL detail'}}):rpc(name,args);
  await assert.rejects(eraseYouTubeData(admin,A),/youtube_erasure_failed/);
  assert.equal(await count('youtube_connections'),1);assert.ok(r.calls.some(c=>c.body.code==='erasure_failed'));
  admin.rpc=rpc;await due();const result=await runYouTubePrivacyMaintenance({db:admin,config:null});
  assert.equal(result.operatorAttention,false);assert.equal(await count('youtube_connections'),0);
});
test('owner-scoped claims, lease checks and browser grants prevent cross-owner mutation',async t=>{
  const {admin,r}=await fixture(t);
  for(const owner of [A,B])await admin.rpc('request_youtube_erasure',{p_owner_user_id:owner});
  const first=await admin.rpc('claim_youtube_deletion_events',{p_limit:5,p_owner:A});assert.equal(first.data.length,1);assert.equal(first.data[0].owner_user_id,A);
  assert.equal((await admin.rpc('claim_youtube_deletion_events',{p_limit:5,p_owner:A})).data.length,0);
  const e=first.data[0];assert.equal((await admin.rpc('finish_youtube_deletion_event',{p_id:e.id,p_owner:B,p_claim:e.claim,p_receipt:'spoofed'})).data,false);
  const [grants]=await q("select has_table_privilege('authenticated','youtube_deletion_events','select') readable,has_table_privilege('service_role','youtube_deletion_events','update') writable,has_function_privilege('authenticated','request_youtube_erasure(uuid,text)','execute') callable,has_function_privilege('service_role','erase_youtube_data_pre_delivery(uuid,boolean,text)','execute') bypass");
  assert.deepEqual(grants,{readable:false,writable:false,callable:false,bypass:false});assert.equal(r.calls.length,0);
});
test('direct account deletion cannot bypass independent capture; recorded deletion permits it',async t=>{
  const {admin}=await fixture(t);await db.exec('savepoint denied_account_delete');
  await assert.rejects(q('delete from auth.users where id=$1',[A]),/capture_required/);await db.exec('rollback to denied_account_delete; release savepoint denied_account_delete');
  assert.equal(await count('youtube_connections'),1);await eraseYouTubeData(admin,A,false);await q('delete from auth.users where id=$1',[A]);
  assert.equal((await q('select count(*)::int n from youtube_deletion_events where owner_user_id=$1',[A]))[0].n,1,'minimal delivery evidence survives account deletion');
});
test('stale authorization cannot be erased without independently recorded intent',async t=>{
  const {admin}=await fixture(t);
  // A stale channel is a full erasure intent; fresh channels remain unrelated.
  await q("update youtube_connections set connected_at=now()-interval '29 days' where owner_user_id=$1",[A]);
  await admin.rpc('prepare_youtube_deletion_events',{p_limit:25});await admin.rpc('prune_youtube_api_data',{p_limit:25});
  assert.equal(await count('youtube_connections'),1);assert.equal(await count('youtube_connections',B),1);
  await runYouTubePrivacyMaintenance({db:admin,config:null});assert.equal(await count('youtube_connections'),0);
});
test('retention capture pins its cutoff across retries and preserves newer and other-owner data',async t=>{
  const {admin}=await fixture(t);
  for(const owner of [A,B])for(const age of [29,1])await q("insert into youtube_performance_snapshots(owner_user_id,youtube_video_id,content_type,published_at,collected_at,metrics) values($1,$2,'video',now()-interval '30 days',now()-make_interval(days=>$3),'{\"views\":1}')",[owner,'synthetic-video-'+age,age]);
  await admin.rpc('prepare_youtube_deletion_events',{p_limit:25});await admin.rpc('prune_youtube_api_data',{p_limit:25});
  assert.equal(await count('youtube_performance_snapshots'),2);
  const [intent]=await q("select id,cutoff_at from youtube_deletion_events where owner_user_id=$1 and scope='retention'",[A]);
  await admin.rpc('prepare_youtube_deletion_events',{p_limit:25});
  assert.deepEqual((await q("select id,cutoff_at from youtube_deletion_events where owner_user_id=$1 and scope='retention'",[A]))[0],intent);
  const {deliverDeletionEvents}=await import('../lib/youtube/deletion-delivery.ts');
  await deliverDeletionEvents(admin,A,createDeletionTransport(env,globalThis.fetch));await admin.rpc('prune_youtube_api_data',{p_limit:25});
  assert.equal(await count('youtube_performance_snapshots'),1);assert.equal(await count('youtube_performance_snapshots',B),2);assert.equal(await count('youtube_connections'),1);
});
test('independent receipts survive a simulated restore; replay stays owner-scoped',async t=>{
  const {admin,r}=await fixture(t);await db.exec('savepoint before_restore');await eraseYouTubeData(admin,A,false);
  const original=r.calls.find(c=>c.body.scope==='erase'&&!c.body.stage).body;
  await db.exec('rollback to before_restore');assert.equal(await count('youtube_connections'),1);assert.ok(r.records.has(original.eventId));
  // Restore remains quarantined; replay the independently verified owner, no Google call.
  await eraseYouTubeData(admin,original.ownerId,false);assert.equal(await count('youtube_connections'),0);assert.equal(await count('youtube_connections',B),1);
});
test('0065 is unchanged; forward migration does not schedule jobs or touch other integrations',async()=>{
  const migration=await readFile(new URL('../supabase/migrations/0069_youtube_deletion_delivery.sql',import.meta.url),'utf8');
  assert.doesNotMatch(migration,/cron\.schedule|net\.http|instagram|tiktok|linkedin|storage\.buckets/i);
  const old=await readFile(new URL('../supabase/migrations/0065_youtube_data_retention.sql',import.meta.url));
  assert.equal(createHash('sha256').update(old).digest('hex'),'2f612e4070dc2ed95d0fcbc463fe56dfe9d0618c806259f00a8002964de0a1f5');
});
test('0069 upgrades in place: prepared erasure calls cannot bypass the new gate',async t=>{
  const local=await createSupabaseLite({stopBefore:'0069'});t.after(()=>local.db.close());
  await local.db.query('insert into auth.users(id) values($1)',[A]);
  await local.db.query("insert into youtube_connections(owner_user_id,channel_id,status) values($1,'synthetic-existing','connected')",[A]);
  const before=await local.db.query("select 'erase_youtube_data(uuid,boolean,text)'::regprocedure::oid id");
  await local.db.exec('prepare old_eraser(uuid) as select erase_youtube_data($1,false)');
  await local.db.exec(migrationSql('0069_youtube_deletion_delivery.sql'));
  assert.deepEqual((await local.db.query("select 'erase_youtube_data(uuid,boolean,text)'::regprocedure::oid id")).rows,before.rows);
  await assert.rejects(local.db.exec(`execute old_eraser('${A}')`),/capture_required/);
  assert.equal((await local.db.query('select count(*)::int n from youtube_connections')).rows[0].n,1);
});
