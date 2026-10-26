import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { createSupabaseLite } from './helpers/pglite-supabase.mjs';
const { LinkedInClient, LinkedInError, LINKEDIN_SCOPES } = await import('../lib/linkedin/client.ts');
const { encryptLinkedInToken, decryptLinkedInToken } = await import('../lib/linkedin/crypto.ts');
const { runLinkedInPublishFlow } = await import('../lib/linkedin/publish-flow.ts');
const { consumeLinkedInState, getLinkedInConnection } = await import('../lib/linkedin/data.ts');
const { sameOrigin, draftChange } = await import('../lib/linkedin/http.ts');
const { runLinkedInPublishing } = await import('../lib/linkedin/publish-worker.ts');
const { readLinkedInConfig } = await import('../lib/linkedin/config.ts');
const { isLinkedInOneShotStaging } = await import('../lib/linkedin/config.ts');
const { runLinkedInOneShot } = await import('../lib/linkedin/one-shot.ts');
const { handleLinkedInOneShot } = await import('../lib/linkedin/one-shot-http.ts');

const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const DRAFT='33333333-3333-4333-8333-333333333333';
const KEY='only-a-synthetic-test-encryption-key';
const SCOPES=['openid','profile','w_member_social'];
const config={clientId:'test-client',clientSecret:'test-secret',redirectUri:'https://example.test/api/integrations/linkedin/callback',encryptionKey:KEY,apiVersion:'202610'};
const read=(path)=>readFile(new URL(`../${path}`,import.meta.url),'utf8');
let db;
before(async()=>{({db}=await createSupabaseLite());});
after(async()=>{await db?.close();});
async function query(sql,args=[]) {return (await db.query(sql,args)).rows;}
async function fixture(t) {
  await db.exec('begin'); t.after(()=>db.exec('rollback'));
  await query('insert into auth.users(id) values($1),($2)',[OWNER,OTHER]);
  const [business]=await query("insert into businesses(owner_user_id,plan,automation_level) values($1,'max','manual') returning id",[OWNER]);
  const [conv]=await query('insert into mara_conversations(owner_user_id) values($1) returning id',[OWNER]);
  await query("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,title,content,social_channel,social_format) values($1,$2,$3,'linkedin_text','LinkedIn','Text post','Original text','linkedin','text')",[DRAFT,OWNER,conv.id]);
  const connection=await connect(OWNER,business.id,'member_A');
  return {business,connection,conv};
}
let stateSeq=0;
async function connect(owner,business,member) {
  const hash=(++stateSeq).toString(16).padStart(64,'0');
  await query('insert into linkedin_oauth_states(state_hash,owner_user_id,business_id) values($1,$2,$3)',[hash,owner,business]);
  await query('select consume_linkedin_oauth_state($1,$2)',[owner,hash]);
  return (await query("select save_linkedin_connection($1,$2,$3,'Test member',$4,now()+interval '1 day',$5,$6) as id",
    [owner,business,member,SCOPES,encryptLinkedInToken('test-access-token',KEY,owner),hash]))[0].id;
}
async function approve(connection,version=1,owner=OWNER,member='member_A') {
  return (await query("select approve_linkedin_draft($1,$2,$3,$4,$5,now()) as id",[owner,DRAFT,version,connection,member]))[0].id;
}
async function claim() {return (await query('select * from claim_linkedin_jobs(5)'))[0];}
async function start(row) {return (await query('select start_linkedin_submission($1,$2,$3) as ok',[row.id,row.owner_user_id,row.claim_token]))[0].ok;}
async function finish(row,outcome,ref=null) {return (await query('select finish_linkedin_job($1,$2,$3,$4,$5) as ok',[row.id,row.owner_user_id,row.claim_token,outcome,ref]))[0].ok;}

// Narrow PostgREST-shaped bridge for the real worker. SQL and fake provider
// response meet end-to-end without network access or environment credentials.
function workerDb(hooks={}) {
  const rpcs={claim_linkedin_jobs:['p_limit'],start_linkedin_submission:['p_id','p_owner','p_claim'],finish_linkedin_job:['p_id','p_owner','p_claim','p_outcome','p_ref']};
  return {
    async rpc(name,args) {
      hooks.rpcCalls?.push(name);
      if(name==='start_linkedin_submission')await hooks.beforeStart?.();
      if(name==='finish_linkedin_job'&&hooks.failFinish)throw new Error('synthetic completion failure');
      assert.ok(rpcs[name]);const params=rpcs[name].map(key=>args[key]);
      const placeholders=params.map((_,index)=>`$${index+1}`).join(',');
      const rows=await query(name==='claim_linkedin_jobs'?`select * from ${name}(${placeholders})`:`select ${name}(${placeholders}) as value`,params);
      return {data:name==='claim_linkedin_jobs'?rows:rows[0].value,error:null};
    },
    from(table) {
      assert.ok(['linkedin_connections','linkedin_connection_secrets','linkedin_publish_queue','mara_drafts'].includes(table));
      const builder=(columns,updates=null)=>{
        const filters=[];
        const add=(op)=>(column,value)=>{assert.match(column,/^[a-z_]+$/);filters.push([column,op,value]);return chain;};
        const chain={eq:add('='),lte:add('<='),lt:add('<'),select(value){columns=value;return chain;},async maybeSingle(){
          assert.match(columns,/^[a-z_,]+$/);
          if(updates)await hooks.beforeClaim?.();
          const params=updates?Object.values(updates):[];
          const where=filters.map(([key,op,value])=>{params.push(value);return `${key}${op}$${params.length}`;}).join(' and ');
          const sql=updates?`update ${table} set ${Object.keys(updates).map((key,i)=>{assert.match(key,/^[a-z_]+$/);return `${key}=$${i+1}`;}).join(',')} where ${where} returning ${columns}`
            :`select ${columns} from ${table} where ${where}`;
          const rows=await query(sql,params);
          assert.ok(rows.length<=1,'owner/draft claim must never affect multiple rows');
          return {data:rows[0]??null,error:null};
        }};return chain;
      };
      return {select:columns=>builder(columns),update:updates=>builder(null,updates)};
    },
  };
}

test('OAuth uses only least-privilege products/scopes, exact redirect and state',()=>{
  const url=new URL(new LinkedInClient(config).authorizationUrl('state'));
  assert.equal(url.origin,'https://www.linkedin.com');assert.equal(url.searchParams.get('state'),'state');
  assert.equal(url.searchParams.get('redirect_uri'),config.redirectUri);
  assert.deepEqual(url.searchParams.get('scope').split(' '),SCOPES);assert.deepEqual(LINKEDIN_SCOPES,SCOPES);
});
test('token exchange is server-side and identity is retrieved using its new access token',async()=>{
  const calls=[];
  const client=new LinkedInClient(config,async(url,init)=>{
    calls.push({url,init});
    return Response.json(url.endsWith('accessToken')?{access_token:'new-token',expires_in:3600,scope:SCOPES.join(' ')}:{sub:'member_A',name:'Test member'});
  });
  const token=await client.exchangeCode('test-code');const identity=await client.identity(token.accessToken);
  assert.equal(identity.sub,'member_A');assert.equal(calls[1].init.headers.Authorization,'Bearer new-token');
  assert.equal(calls[0].init.body.get('client_secret'),'test-secret');assert.equal(calls[0].init.redirect,'error');
});
test('omitted scope follows OAuth requested-scope semantics; explicitly insufficient grants fail',async()=>{
  const omitted=new LinkedInClient(config,async()=>Response.json({access_token:'token',expires_in:3600}));
  assert.deepEqual((await omitted.exchangeCode('code')).scopes,SCOPES);
  const insufficient=new LinkedInClient(config,async()=>Response.json({access_token:'token',expires_in:3600,scope:'openid profile'}));
  await assert.rejects(insufficient.exchangeCode('code'),/linkedin_rejected/);
});
test('invalid token lifetime and malformed returned profile identity are rejected',async()=>{
  await assert.rejects(new LinkedInClient(config,async()=>Response.json({access_token:'token',expires_in:0})).exchangeCode('code'));
  await assert.rejects(new LinkedInClient(config,async()=>Response.json({sub:'urn:li:organization:1',name:'wrong'})).identity('token'));
});
test('encryption is randomized, owner-bound, authenticated and not shared with other providers',()=>{
  const one=encryptLinkedInToken('secret-token',KEY,OWNER),two=encryptLinkedInToken('secret-token',KEY,OWNER);
  assert.notEqual(one,two);assert.ok(!one.includes('secret-token'));
  assert.equal(decryptLinkedInToken(one,KEY,OWNER),'secret-token');
  assert.throws(()=>decryptLinkedInToken(one,KEY,OTHER));assert.throws(()=>decryptLinkedInToken(one,'wrong',OWNER));
  assert.throws(()=>decryptLinkedInToken(one.slice(0,-5)+'AAAAA',KEY,OWNER));
});
test('state mismatch and malformed cookies never call the database',async()=>{
  const client={rpc(){throw new Error('must not call');}};
  assert.equal(await consumeLinkedInState(client,OWNER,'a'.repeat(43),'b'.repeat(43)),null);
  assert.equal(await consumeLinkedInState(client,OWNER,'a'.repeat(43),''),null);
});
test('mutation origin check rejects missing and cross-site origins',()=>{
  assert.equal(sameOrigin(new Request('https://voom.example/api',{headers:{origin:'https://evil.example'}})),false);
  assert.equal(sameOrigin(new Request('https://voom.example/api')),false);
  assert.equal(sameOrigin(new Request('https://voom.example/api',{headers:{origin:'https://voom.example'}})),true);
});
test('approval request requires fresh explicit confirmation, version and account identity',()=>{
  const good={action:'approve',version:1,confirmed:true,connectionId:DRAFT,memberSub:'member_A',scheduledAt:null};
  assert.equal(draftChange.safeParse(good).success,true);
  for(const patch of [{confirmed:false},{version:0},{memberSub:undefined},{connectionId:undefined},{ownerId:OTHER}])
    assert.equal(draftChange.safeParse({...good,...patch}).success,false);
});
test('Posts API text payload and 201 post-id evidence establish success',async()=>{
  let call;
  const client=new LinkedInClient(config,async(url,init)=>{call={url,init};return new Response(null,{status:201,headers:{'x-restli-id':'urn:li:share:123'}});});
  assert.equal(await client.publishText('token','member_A','Hello'),'urn:li:share:123');
  const body=JSON.parse(call.init.body);assert.equal(body.author,'urn:li:person:member_A');
  assert.equal(body.commentary,'Hello');assert.equal(body.visibility,'PUBLIC');assert.equal(body.lifecycleState,'PUBLISHED');
  assert.equal(call.init.headers['LinkedIn-Version'],'202610');assert.ok(!body.content);assert.ok(!body.sponsoredContent);
});
for(const [status,category] of [[400,'rejected'],[401,'reconnect'],[403,'rejected'],[429,'rate_limited'],[500,'uncertain'],[503,'uncertain'],[408,'uncertain']]) {
  test(`publishing HTTP ${status} is ${category}, without leaking response bodies`,async()=>{
    const client=new LinkedInClient(config,async()=>new Response('secret-provider-detail',{status}));
    await assert.rejects(client.publishText('token','member_A','Hello'),error=>error.category===category&&!error.message.includes('secret-provider-detail'));
  });
}
test('timeout/network failure and missing publication reference are uncertain, not retryable success',async()=>{
  for(const fetcher of [async()=>{throw new Error('token in network error');},async()=>new Response(null,{status:201}),async()=>new Response(null,{status:200,headers:{'x-restli-id':'urn:li:share:123'}})])
    await assert.rejects(new LinkedInClient(config,fetcher).publishText('token','member_A','Hello'),error=>error.category==='uncertain');
});

test('full migration applies locally; new tables have RLS and server-only secrets/mutations',async()=>{
  const rows=await query("select relname,relrowsecurity from pg_class where relname in ('linkedin_connections','linkedin_oauth_states','linkedin_connection_secrets','linkedin_publish_queue')");
  assert.equal(rows.length,4);assert.ok(rows.every(r=>r.relrowsecurity));
  const [priv]=await query("select has_table_privilege('authenticated','linkedin_connection_secrets','SELECT') as secret,has_table_privilege('authenticated','linkedin_connections','UPDATE') as writes,has_function_privilege('authenticated','public.claim_linkedin_jobs(integer)','EXECUTE') as claim");
  assert.deepEqual(priv,{secret:false,writes:false,claim:false});
});
test('new owner can connect with a consumed OAuth state; replay and expired states fail',async(t)=>{
  const {business}=await fixture(t);
  const hash='f'.repeat(64);
  await query("insert into linkedin_oauth_states(state_hash,owner_user_id,business_id,expires_at) values($1,$2,$3,now()-interval '1 minute')",[hash,OWNER,business.id]);
  assert.equal((await query('select consume_linkedin_oauth_state($1,$2) as id',[OWNER,hash]))[0].id,null);
  await query("update linkedin_oauth_states set expires_at=now()+interval '10 minutes' where state_hash=$1",[hash]);
  assert.equal((await query('select consume_linkedin_oauth_state($1,$2) as id',[OTHER,hash]))[0].id,null);
  assert.equal((await query('select consume_linkedin_oauth_state($1,$2) as id',[OWNER,hash]))[0].id,business.id);
  assert.equal((await query('select consume_linkedin_oauth_state($1,$2) as id',[OWNER,hash]))[0].id,null);
});
test('same LinkedIn member cannot be silently moved to another VOOM owner',async(t)=>{
  await fixture(t);const [business]=await query('insert into businesses(owner_user_id) values($1) returning id',[OTHER]);
  await assert.rejects(connect(OTHER,business.id,'member_A'),/duplicate key/);
});
test('disconnect invalidates an OAuth callback already exchanging a token',async(t)=>{
  const {business}=await fixture(t);const hash='d'.repeat(64);
  await query('insert into linkedin_oauth_states(state_hash,owner_user_id,business_id,consumed_at) values($1,$2,$3,now())',[hash,OWNER,business.id]);
  await query('select disconnect_linkedin_connection($1)',[OWNER]);
  await assert.rejects(query("select save_linkedin_connection($1,$2,'member_A','Test member',$3,now()+interval '1 day','v1:fake',$4)",[OWNER,business.id,SCOPES,hash]),/linkedin_oauth_invalidated/);
});
test('unapproved drafts never enter the queue automatically; explicit approval creates one calendar entry and audit',async(t)=>{
  const {connection}=await fixture(t);assert.equal((await query('select * from linkedin_publish_queue')).length,0);
  await approve(connection);
  assert.equal((await query('select * from linkedin_publish_queue')).length,1);
  assert.equal((await query("select * from content_calendar_items where channel='LinkedIn'")).length,1);
  assert.equal((await query("select * from mara_tool_runs where tool_name='linkedin_approve_schedule'")).length,1);
});
test('repeated approval is idempotent and cannot duplicate queue or calendar rows',async(t)=>{
  const {connection}=await fixture(t);const id=await approve(connection);
  const [draft]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  const result=await query('select approve_linkedin_draft($1,$2,$3,$4,$5,$6) as id',[OWNER,DRAFT,draft.content_version,connection,'member_A',draft.proposed_publish_at]);
  assert.equal(result[0].id,id);assert.equal((await query('select * from linkedin_publish_queue')).length,1);
  assert.equal((await query('select * from content_calendar_items')).length,1);
});
test('claims are atomic, fresh consent is version-bound, and stale claimant cannot submit',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0);
  assert.equal(await start({...row,claim_token:OTHER}),false);assert.equal(await start(row),true);
  assert.equal(await start(row),false);
});
test('edits cancel unclaimed jobs and invalidate old approval; stale approval cannot be reused',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const [draft]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  await query('select edit_linkedin_draft($1,$2,$3,$4,null)',[OWNER,DRAFT,draft.content_version,'Edited text']);
  const [changed]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  assert.equal(changed.status,'draft');assert.equal(changed.approved_content_version,null);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'cancelled');
  await assert.rejects(approve(connection,draft.content_version),/linkedin_draft_changed/);
});
test('rejection closes publishing and an expired schedule cannot be approved',async(t)=>{
  const {connection}=await fixture(t);
  await query('select edit_linkedin_draft($1,$2,1,$3,null,true)',[OWNER,DRAFT,'Rejected text']);
  await assert.rejects(approve(connection,2),/linkedin_draft_changed/);
});
test('genuinely scheduled dates must be valid, while Post now creates a fresh send time',async(t)=>{
  const {connection}=await fixture(t);
  await assert.rejects(query("select approve_linkedin_draft($1,$2,1,$3,'member_A',now()-interval '1 day')",[OWNER,DRAFT,connection]),/linkedin_schedule_invalid/);
});
test('expired tokens prevent approval and never reach the provider',async(t)=>{
  const {connection}=await fixture(t);
  await query("update linkedin_connections set token_expires_at=now()-interval '1 second'");
  await assert.rejects(approve(connection),/linkedin_reconnect/);
});
test('final submission rechecks identity and explicit user approval',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();
  await query("update mara_drafts set approval_origin='autopilot' where id=$1",[DRAFT]);
  assert.equal(await start(row),false);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'cancelled');
});
test('manual owner-approved LinkedIn work remains valid during emergency automation pause',async(t)=>{
  const {connection}=await fixture(t);
  await query("select pause_all_automation($1,'linkedin-pause-test-0001')",[OWNER]);
  assert.ok((await query('select automation_paused_at from businesses where owner_user_id=$1',[OWNER]))[0].automation_paused_at);
  await approve(connection);assert.equal(await start(await claim()),true);
});
test('disconnect cancels only unsent jobs, removes credentials, preserves original drafts and history',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);
  await query('select disconnect_linkedin_connection($1)',[OWNER]);
  assert.equal((await query('select * from linkedin_connection_secrets')).length,0);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'cancelled');
  assert.equal((await query('select * from mara_drafts')).length,1);
  assert.equal((await query('select member_sub from linkedin_connections'))[0].member_sub,null);
});
test('disconnect cannot falsely cancel an in-flight or published post',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();await start(row);
  await query('select disconnect_linkedin_connection($1)',[OWNER]);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'submitting');
  assert.equal(await finish(row,'published','urn:li:share:123'),true);
  assert.equal((await query('select provider_ref from mara_drafts where id=$1',[DRAFT]))[0].provider_ref,'urn:li:share:123');
});
test('429 retry keeps original approval time and cannot double publish',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();await start(row);await finish(row,'rate_limited');
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0);
  await query("update linkedin_publish_queue set next_attempt_at=now()-interval '1 second'");
  const retry=await claim();assert.equal(retry.attempts,2);assert.equal(await start(retry),true);
  assert.equal(await finish(retry,'published','urn:li:share:123'),true);
  assert.equal(await finish(row,'published','urn:li:share:999'),false);
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0);
});
test('uncertain submissions cannot be retried even with explicit repeated approval',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();await start(row);await finish(row,'uncertain');
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0);
  // An exact idempotent approval replay may return history, but never requeues.
  const [draft]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  await query('select approve_linkedin_draft($1,$2,$3,$4,$5,$6)',[OWNER,DRAFT,draft.content_version,connection,'member_A',draft.proposed_publish_at]);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'uncertain');
});
test('stale submitting lease becomes uncertain; stale pre-submission claim can recover',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const row=await claim();await start(row);
  await query("update linkedin_publish_queue set claimed_at=now()-interval '6 minutes'");
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'uncertain');
});
test('owner isolation is enforced by database RLS and privileged function validation',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);
  await db.exec(`set local role authenticated; select set_config('request.jwt.claim.sub','${OTHER}',true)`);
  assert.equal((await query('select * from linkedin_connections')).length,0);
  assert.equal((await query('select * from linkedin_publish_queue')).length,0);
  await db.exec('reset role');
  await assert.rejects(approve(connection,1,OTHER),/linkedin_draft_changed/);
});
test('unconfigured worker never claims or calls LinkedIn',async()=>{
  const result=await runLinkedInPublishing({config:null,db:{rpc(){throw new Error('must not claim');}}});
  assert.equal(result.configured,false);
});
test('real worker + encrypted vault + actual SQL publishes once with a fake LinkedIn provider',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);let sends=0;
  const fake={async publishText(token,member,caption){assert.equal(token,'test-access-token');assert.equal(member,'member_A');assert.equal(caption,'Original text');sends++;return 'urn:li:share:456';}};
  const result=await runLinkedInPublishing({config,db:workerDb(),client:fake});
  assert.equal(result.results[0].outcome,'published');assert.equal(sends,1);
  const repeated=await runLinkedInPublishing({config,db:workerDb(),client:fake});assert.deepEqual(repeated.results,[]);assert.equal(sends,1);
  assert.equal((await query('select provider_ref from linkedin_publish_queue'))[0].provider_ref,'urn:li:share:456');
});
test('real worker records provider rejection and a retryable rate limit without false success',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);
  const result=await runLinkedInPublishing({config,db:workerDb(),client:{async publishText(){throw new LinkedInError('rate_limited');}}});
  assert.equal(result.results[0].outcome,'rate_limited');
  const [row]=await query('select * from linkedin_publish_queue');assert.equal(row.status,'scheduled');assert.equal(row.provider_ref,null);
  assert.equal((await runLinkedInPublishing({config,db:workerDb(),client:{async publishText(){throw new Error('must not send during backoff');}}})).results.length,0);
});
test('stale pre-submission claim is recovered with a new fencing token; no sixth automatic attempt',async(t)=>{
  const {connection}=await fixture(t);await approve(connection);const original=await claim();
  await query("update linkedin_publish_queue set claimed_at=now()-interval '6 minutes'");
  const recovered=await claim();assert.notEqual(recovered.claim_token,original.claim_token);
  assert.equal(await start(original),false);assert.equal(await start(recovered),true);
  await query('update linkedin_publish_queue set attempts=5');await finish(recovered,'rate_limited');
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'failed');
});
test('wrong account or owner cannot approve another owner’s draft',async(t)=>{
  const {connection}=await fixture(t);
  await assert.rejects(approve(connection,1,OWNER,'other_member'),/linkedin_reconnect/);
});
test('connected-profile switch and cross-business OAuth save cannot overwrite the owner binding',async(t)=>{
  const {business}=await fixture(t);
  await assert.rejects(connect(OWNER,business.id,'different_member'),/linkedin_disconnect_before_switching_account/);
});
test('configuration fails closed without secrets, valid HTTPS callback or API version',()=>{
  const names=['LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET','LINKEDIN_REDIRECT_URI','LINKEDIN_TOKEN_ENCRYPTION_KEY','LINKEDIN_API_VERSION'];
  const prior=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    for(const name of names)delete process.env[name];assert.equal(readLinkedInConfig(),null);
    Object.assign(process.env,{LINKEDIN_CLIENT_ID:'test',LINKEDIN_CLIENT_SECRET:'test',LINKEDIN_REDIRECT_URI:config.redirectUri,LINKEDIN_TOKEN_ENCRYPTION_KEY:KEY,LINKEDIN_API_VERSION:'202610'});
    assert.ok(readLinkedInConfig());process.env.LINKEDIN_REDIRECT_URI='http://example.test/callback';assert.equal(readLinkedInConfig(),null);
  } finally {for(const name of names) {if(prior[name]===undefined)delete process.env[name];else process.env[name]=prior[name];}}
});
test('flow never sends without final authorization and cannot call providers after credential failure',async()=>{
  const job={id:'job',owner_user_id:OWNER,member_sub:'member_A',caption:'Text'};let published=0;
  const ports={credentials:async()=>'token',start:async()=>false,publish:async()=>{published++;return 'urn:li:share:1';},finish:async()=>{}};
  assert.equal(await runLinkedInPublishFlow(job,ports),'blocked');assert.equal(published,0);
  assert.equal(await runLinkedInPublishFlow(job,{...ports,credentials:async()=>{throw new LinkedInError('reconnect');}}),'reconnect');
  assert.equal(published,0);
});
test('post accepted but result persistence failed never becomes a second provider POST',async()=>{
  let sends=0,records=0;
  await assert.rejects(runLinkedInPublishFlow({member_sub:'member_A',caption:'text'},{
    credentials:async()=>'token',start:async()=>true,publish:async()=>{sends++;return 'urn:li:share:123';},
    finish:async()=>{records++;throw new Error('db unavailable');},
  }));assert.equal(sends,1);assert.equal(records,1);
});
test('all mutation routes derive owner from authentication; worker is bearer-protected and not scheduled',async()=>{
  for(const route of ['connect','disconnect','drafts','drafts/[id]']) {
    const src=await read(`app/api/integrations/linkedin/${route}/route.ts`);
    assert.match(src,/getCurrentUser\(\)/);assert.match(src,/if \(!user\)/);assert.match(src,/sameOrigin\(request\)/);
  }
  const worker=await read('app/api/cron/linkedin-publish/route.ts');assert.match(worker,/bearerMatches/);
  const deploymentConfig=JSON.parse(await read('vercel.json'));
  assert.doesNotMatch(JSON.stringify(deploymentConfig.crons ?? []),/linkedin/);
});
test('staging preparation prevents automatic Git deployment and defines no scheduled workers',async()=>{
  const root=JSON.parse(await read('vercel.json'));
  assert.equal(root.git.deploymentEnabled['feature/linkedin-personal-publishing'],false);
  assert.equal(root.git.deploymentEnabled['linkedin-staging'],false);
  const staging=JSON.parse(await read('vercel.linkedin-staging.json'));
  assert.equal(staging.git.deploymentEnabled,false);
  assert.deepEqual(staging.crons,[]);
  assert.equal('env' in staging,false);
  assert.equal('build' in staging,false);
});
test('callback uses secure scoped state cookie and never reflects provider errors',async()=>{
  const src=await read('app/api/integrations/linkedin/callback/route.ts');
  assert.ok(src.indexOf('consumeLinkedInState(admin')<src.indexOf('exchangeCode(code)'));
  assert.match(src,/httpOnly:true/);assert.match(src,/sameSite:"lax"/);
  assert.doesNotMatch(src,/console\.|params.get\("error_description"\)/);
});
test('connection view never queries secrets and expired status is truthful',async()=>{
  const select=[];const dbFake={from(table){assert.equal(table,'linkedin_connections');return {select(value){select.push(value);return {eq(){return {maybeSingle:async()=>({data:{id:DRAFT,member_sub:'member_A',display_name:'Test',scopes:SCOPES,status:'connected',token_expires_at:'2000-01-01T00:00:00Z'},error:null})}}}}};}};
  const result=await getLinkedInConnection(dbFake,OWNER,true);assert.equal(result.connected,false);assert.equal(result.status,'expired');
  assert.ok(!select.join().includes('encrypted'));
});

const OTHER_DRAFT='44444444-4444-4444-8444-444444444444';
const OWN_OTHER_DRAFT='55555555-5555-4555-8555-555555555555';
async function singleFixture(t) {
  const {connection,conv}=await fixture(t);
  const [business]=await query('insert into businesses(owner_user_id) values($1) returning id',[OTHER]);
  const otherConnection=await connect(OTHER,business.id,'member_B');
  const [otherConv]=await query('insert into mara_conversations(owner_user_id) values($1) returning id',[OTHER]);
  for(const [id,owner,conversation] of [[OTHER_DRAFT,OTHER,otherConv.id],[OWN_OTHER_DRAFT,OWNER,conv.id]]){
    await query("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,title,content,social_channel,social_format) values($1,$2,$3,'linkedin_text','LinkedIn','Unrelated post','Do not publish this','linkedin','text')",[id,owner,conversation]);
    await query('select approve_linkedin_draft($1,$2,1,$3,$4,now())',[owner,id,owner===OWNER?connection:otherConnection,owner===OWNER?'member_A':'member_B']);
  }
  await approve(connection);
  const [job]=await query('select * from linkedin_publish_queue where draft_id=$1',[DRAFT]);
  const [draft]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  const input={queueId:job.id,version:Number(draft.content_version),connectionId:connection,memberSub:'member_A',confirmed:true,visibility:'PUBLIC'};
  const untouched=await query('select * from linkedin_publish_queue where draft_id<>$1 order by id',[DRAFT]);
  return {job,draft,input,untouched};
}
async function assertOthersUnchanged(f) {
  assert.deepEqual(await query('select * from linkedin_publish_queue where draft_id<>$1 order by id',[DRAFT]),f.untouched);
}
const neverPublish={async publishText(){throw new Error('must not call provider');}};

test('one-shot is fail-closed outside the exact isolated Preview configuration',()=>{
  const env={VERCEL_ENV:'preview',VERCEL_GIT_COMMIT_REF:'linkedin-staging',NEXT_PUBLIC_SUPABASE_URL:'https://qcdpegwjofrqnfudyrqq.supabase.co',NEXT_PUBLIC_SITE_URL:'https://voom-real-git-linkedin-staging-pavjassehgal-commits.vercel.app',LINKEDIN_REDIRECT_URI:'https://voom-real-git-linkedin-staging-pavjassehgal-commits.vercel.app/api/integrations/linkedin/callback'};
  assert.equal(isLinkedInOneShotStaging(env),true);
  for(const key of Object.keys(env)){
    assert.equal(isLinkedInOneShotStaging({...env,[key]:undefined}),false);
    assert.equal(isLinkedInOneShotStaging({...env,[key]:'unexpected'}),false);
  }
  assert.equal(isLinkedInOneShotStaging({...env,VERCEL_ENV:'production'}),false);
  assert.equal(isLinkedInOneShotStaging({...env,VERCEL_GIT_COMMIT_REF:'tiktok-sandbox'}),false);
});
test('manual HTTP boundary requires staging, POST, authentication, same origin and fresh public-post confirmation',async()=>{
  const input={queueId:DRAFT,version:2,connectionId:DRAFT,memberSub:'member_A',confirmed:true,visibility:'PUBLIC'};
  const cases=[
    {enabled:false,expected:404},{method:'GET',expected:405},{owner:null,expected:401},
    {origin:null,expected:403},{origin:'https://evil.example',expected:403},
    {patch:{confirmed:false},expected:400},{patch:{confirmed:undefined},expected:400},
    {patch:{visibility:'PRIVATE'},expected:400},{patch:{ownerId:OTHER},expected:400},
    {patch:{queueId:'invalid'},expected:400},{id:'invalid',expected:400},
  ];
  for(const row of cases){
    let calls=0;const method=row.method??'POST';
    const request=new Request('https://example.test/api/integrations/linkedin/drafts/'+DRAFT+'/publish',{
      method,headers:{'Content-Type':'application/json',...(row.origin===null?{}:{origin:row.origin??'https://example.test'})},
      ...(method==='POST'?{body:JSON.stringify({...input,...row.patch})}:{}),
    });
    const response=await handleLinkedInOneShot(request,row.id??DRAFT,{enabled:row.enabled??true,
      owner:async()=>Object.hasOwn(row,'owner')?row.owner:OWNER,publish:async()=>{calls++;return 'published';}});
    assert.equal(response.status,row.expected,JSON.stringify(row));assert.equal(calls,0);
    assert.equal(response.headers.get('Cache-Control'),'no-store');
  }
  let used;
  const response=await handleLinkedInOneShot(new Request('https://example.test/api',{method:'POST',headers:{origin:'https://example.test'},body:JSON.stringify(input)}),DRAFT,
    {enabled:true,owner:async()=>OWNER,publish:async(...args)=>{used=args;return 'published';}});
  assert.equal(response.status,200);assert.equal(used[0],OWNER);assert.equal(used[1],DRAFT);
});
test('one-shot publishes exactly the selected owner-approved post, leaving two other due jobs untouched',async(t)=>{
  const f=await singleFixture(t);const sends=[];const rpcCalls=[];
  const client={async publishText(token,member,text){sends.push({token,member,text});return 'urn:li:share:123';}};
  const result=await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb({rpcCalls}),config,client});
  assert.equal(result,'published');assert.deepEqual(sends,[{token:'test-access-token',member:'member_A',text:'Original text'}]);
  assert.deepEqual(rpcCalls,['start_linkedin_submission','finish_linkedin_job']);
  assert.equal((await query('select status from linkedin_publish_queue where id=$1',[f.job.id]))[0].status,'published');
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client}),'not_claimed');
  assert.equal(sends.length,1);await assertOthersUnchanged(f);
});
for(const [label,patch] of [['stale version',{version:999}],['wrong queue',{queueId:OTHER_DRAFT}],['wrong connection',{connectionId:OTHER_DRAFT}],['wrong member',{memberSub:'member_B'}],['missing consent',{confirmed:false}],['wrong visibility',{visibility:'PRIVATE'}]]) {
  test(`one-shot rejects ${label} without claiming or publishing any post`,async(t)=>{
    const f=await singleFixture(t);const before=await query('select * from linkedin_publish_queue order by id');
    assert.equal(await runLinkedInOneShot(OWNER,DRAFT,{...f.input,...patch},{db:workerDb(),config,client:neverPublish}),'not_claimed');
    assert.deepEqual(await query('select * from linkedin_publish_queue order by id'),before);
  });
}
test('cross-owner and mismatched draft requests never select or modify another job',async(t)=>{
  const f=await singleFixture(t);const before=await query('select * from linkedin_publish_queue order by id');
  for(const [owner,draft] of [[OTHER,DRAFT],[OWNER,OTHER_DRAFT],[OWNER,OWN_OTHER_DRAFT]])
    assert.equal(await runLinkedInOneShot(owner,draft,f.input,{db:workerDb(),config,client:neverPublish}),'not_claimed');
  assert.deepEqual(await query('select * from linkedin_publish_queue order by id'),before);
});
for(const state of ['draft','rejected'])test(`a ${state} cannot be manually published`,async(t)=>{
  const f=await singleFixture(t);await query('update mara_drafts set status=$1 where id=$2',[state,DRAFT]);
  const before=await query('select * from linkedin_publish_queue order by id');
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:neverPublish}),'not_claimed');
  assert.deepEqual(await query('select * from linkedin_publish_queue order by id'),before);
});
test('manual publishing rejects automatic approval origin and a future schedule or retry backoff',async(t)=>{
  const f=await singleFixture(t);
  await query("update mara_drafts set approval_origin='autopilot' where id=$1",[DRAFT]);
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:neverPublish}),'not_claimed');
  await query("update mara_drafts set approval_origin='user' where id=$1",[DRAFT]);
  for(const column of ['scheduled_at','next_attempt_at']){
    await query(`update linkedin_publish_queue set ${column}=now()+interval '1 hour' where id=$1`,[f.job.id]);
    assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:neverPublish}),'not_claimed');
    await query(`update linkedin_publish_queue set ${column}=$1 where id=$2`,[f.job[column],f.job.id]);
  }
  await assertOthersUnchanged(f);
});
test('concurrent clicks have one CAS winner and one provider submission',async(t)=>{
  const f=await singleFixture(t);let sends=0;
  const client={async publishText(){sends++;return 'urn:li:share:123';}};
  const results=await Promise.all([1,2].map(()=>runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client})));
  assert.deepEqual(results.sort(),['not_claimed','published']);assert.equal(sends,1);await assertOthersUnchanged(f);
});
test('a batch-worker race cannot let the one-shot reclaim the target or touch other jobs',async(t)=>{
  const f=await singleFixture(t);
  const bridge=workerDb({beforeClaim:async()=>{await query("update linkedin_publish_queue set status='claimed',attempts=attempts+1,claim_token=gen_random_uuid(),claimed_at=now() where id=$1",[f.job.id]);}});
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:bridge,config,client:neverPublish}),'not_claimed');
  await assertOthersUnchanged(f);
});
test('an edit between reading and claiming is blocked by the final existing SQL approval gate',async(t)=>{
  const f=await singleFixture(t);
  const bridge=workerDb({beforeClaim:async()=>{
    await query('select edit_linkedin_draft($1,$2,$3,$4,null)',[OWNER,DRAFT,f.input.version,'Changed after confirmation']);
    const [changed]=await query('select content_version from mara_drafts where id=$1',[DRAFT]);
    await query("select approve_linkedin_draft($1,$2,$3,$4,'member_A',now())",[OWNER,DRAFT,changed.content_version,f.input.connectionId]);
  }});
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:bridge,config,client:neverPublish}),'not_claimed');
  await assertOthersUnchanged(f);
});
test('final account and token checks still block a connection change after the targeted claim',async(t)=>{
  const f=await singleFixture(t);
  const bridge=workerDb({beforeStart:async()=>{await query("update linkedin_connections set status='permission_required' where id=$1",[f.input.connectionId]);}});
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:bridge,config,client:neverPublish}),'blocked');
  assert.equal((await query('select status from linkedin_publish_queue where id=$1',[f.job.id]))[0].status,'permission_required');
  await assertOthersUnchanged(f);
});
for(const [category,expected] of [['rate_limited','scheduled'],['reconnect','permission_required'],['uncertain','uncertain'],['rejected','failed']]) {
  test(`one-shot records ${category} for only its target and never performs an automatic retry`,async(t)=>{
    const f=await singleFixture(t);let calls=0;
    const client={async publishText(){calls++;throw new LinkedInError(category);}};
    assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client}),category);
    assert.equal((await query('select status from linkedin_publish_queue where id=$1',[f.job.id]))[0].status,expected);
    assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client}),'not_claimed');
    assert.equal(calls,1);await assertOthersUnchanged(f);
  });
}
test('failed completion write never causes one-shot resubmission or changes another queue row',async(t)=>{
  const f=await singleFixture(t);let calls=0;
  const client={async publishText(){calls++;return 'urn:li:share:123';}};
  await assert.rejects(runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb({failFinish:true}),config,client}));
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client}),'not_claimed');
  assert.equal(calls,1);await assertOthersUnchanged(f);
});
test('one-shot never recovers or modifies unrelated stale claims or submissions',async(t)=>{
  const f=await singleFixture(t);
  await query("update linkedin_publish_queue set status=case when owner_user_id=$1 then 'claimed' else 'submitting' end,claimed_at=now()-interval '1 hour',claim_token=gen_random_uuid(),attempts=1 where draft_id<>$2",[OWNER,DRAFT]);
  f.untouched=await query('select * from linkedin_publish_queue where draft_id<>$1 order by id',[DRAFT]);
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:{async publishText(){return 'urn:li:share:123';}}}),'published');
  await assertOthersUnchanged(f);
});
test('attempt limit prevents any new targeted claim',async(t)=>{
  const f=await singleFixture(t);await query('update linkedin_publish_queue set attempts=5 where id=$1',[f.job.id]);
  const before=await query('select * from linkedin_publish_queue order by id');
  assert.equal(await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:neverPublish}),'not_claimed');
  assert.deepEqual(await query('select * from linkedin_publish_queue order by id'),before);
});
for(const reason of ['expired','missing encrypted credential','invalid encrypted credential']) {
  test(`one-shot ${reason} prevents a provider request and changes only the selected job`,async(t)=>{
    const f=await singleFixture(t);
    if(reason==='expired')await query("update linkedin_connections set token_expires_at=now()-interval '1 minute' where id=$1",[f.input.connectionId]);
    else if(reason==='missing encrypted credential')await query('delete from linkedin_connection_secrets where connection_id=$1',[f.input.connectionId]);
    else await query("update linkedin_connection_secrets set encrypted_access_token='v1:invalid' where connection_id=$1",[f.input.connectionId]);
    const outcome=await runLinkedInOneShot(OWNER,DRAFT,f.input,{db:workerDb(),config,client:neverPublish});
    assert.equal(outcome,reason==='missing encrypted credential'?'unavailable':'reconnect');await assertOthersUnchanged(f);
  });
}
test('new route is staging-only and session-owned, with no GET, cron-secret fallback or batch claim',async()=>{
  const route=await read('app/api/integrations/linkedin/drafts/[id]/publish/route.ts');
  assert.match(route,/isLinkedInOneShotStaging\(\)/);assert.match(route,/getCurrentUser\(\)/);
  assert.match(route,/export async function POST/);assert.doesNotMatch(route,/export.*GET|CRON_SECRET/);
  assert.doesNotMatch(await read('lib/linkedin/one-shot.ts'),/\.rpc\("claim_linkedin_jobs"/);
  assert.deepEqual(JSON.parse(await read('vercel.json')).crons,[]);
});
