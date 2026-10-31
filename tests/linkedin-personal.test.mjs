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
function workerDb() {
  const rpcs={claim_linkedin_jobs:['p_limit'],start_linkedin_submission:['p_id','p_owner','p_claim'],finish_linkedin_job:['p_id','p_owner','p_claim','p_outcome','p_ref']};
  return {
    async rpc(name,args) {
      assert.ok(rpcs[name]);const params=rpcs[name].map(key=>args[key]);
      const placeholders=params.map((_,index)=>`$${index+1}`).join(',');
      const rows=await query(name==='claim_linkedin_jobs'?`select * from ${name}(${placeholders})`:`select ${name}(${placeholders}) as value`,params);
      return {data:name==='claim_linkedin_jobs'?rows:rows[0].value,error:null};
    },
    from(table) {
      assert.ok(['linkedin_connections','linkedin_connection_secrets'].includes(table));
      return {select(columns){
        assert.match(columns,/^[a-z_,]+$/);const filters=[];
        const chain={eq(column,value){assert.match(column,/^[a-z_]+$/);filters.push([column,value]);return chain;},async maybeSingle(){
          const rows=await query(`select ${columns} from ${table} where ${filters.map(([key],i)=>`${key}=$${i+1}`).join(' and ')}`,filters.map(([,value])=>value));
          return {data:rows[0]??null,error:null};
        }};return chain;
      }};
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
test('a Marketing Plan LinkedIn text draft uses the existing version-bound queue and edit withdrawal',async(t)=>{
  const {connection,business}=await fixture(t);
  const [plan]=await query(`insert into marketing_plans(owner_user_id,business_id,business_goal,weekly_strategy,selected_channels,content_frequency,valid_from,valid_until)
    values($1,$2,'Useful business awareness','Seven selected-channel daily recommendations',array['LinkedIn'],'Daily',current_date,current_date+6) returning id`,[OWNER,business.id]);
  await query("update mara_drafts set source_plan_id=$1,source_plan_item_key=current_date::text||'|linkedin_text',proposed_publish_at=now()+interval '1 hour' where id=$2",[plan.id,DRAFT]);
  const [draft]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  assert.equal((await query('select * from linkedin_publish_queue')).length,0);
  assert.equal((await query('select * from claim_linkedin_jobs(5)')).length,0,'MARA recommendation alone is never publishable');
  const sendAt=new Date(Date.now()+3600000).toISOString();
  await query('select approve_linkedin_draft($1,$2,$3,$4,$5,$6)',[OWNER,DRAFT,draft.content_version,connection,'member_A',sendAt]);
  const [approved]=await query('select * from mara_drafts where id=$1',[DRAFT]);
  await query('select approve_linkedin_draft($1,$2,$3,$4,$5,$6)',[OWNER,DRAFT,approved.content_version,connection,'member_A',sendAt]);
  assert.equal((await query('select * from linkedin_publish_queue')).length,1);
  assert.equal((await query("select * from content_calendar_items where social_channel='linkedin' and social_format='text'")).length,1);
  await query('select edit_linkedin_draft($1,$2,$3,$4,$5,false)',[OWNER,DRAFT,approved.content_version,'Revised professional text',sendAt]);
  assert.equal((await query('select status from linkedin_publish_queue'))[0].status,'cancelled');
  assert.equal((await query('select source_plan_id from mara_drafts where id=$1',[DRAFT]))[0].source_plan_id,plan.id);
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
test('overlapping cron runs claim a due approved post once and leave unapproved and future drafts untouched',async(t)=>{
  const {connection,conv}=await fixture(t);await approve(connection);
  const future='44444444-4444-4444-8444-444444444444';
  const unapproved='55555555-5555-4555-8555-555555555555';
  for(const id of [future,unapproved])await query("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,title,content,social_channel,social_format) values($1,$2,$3,'linkedin_text','LinkedIn','Unrelated','Do not publish','linkedin','text')",[id,OWNER,conv.id]);
  await query("select approve_linkedin_draft($1,$2,1,$3,'member_A',now()+interval '1 day')",[OWNER,future,connection]);
  let calls=0;const client={async publishText(token,member,text){assert.equal(text,'Original text');calls++;return 'urn:li:share:789';}};
  const results=await Promise.all([runLinkedInPublishing({config,db:workerDb(),client}),runLinkedInPublishing({config,db:workerDb(),client})]);
  assert.equal(calls,1);assert.equal(results.flatMap(result=>result.results).length,1);
  assert.equal((await query('select status from linkedin_publish_queue where draft_id=$1',[future]))[0].status,'scheduled');
  assert.equal((await query('select count(*)::int as n from linkedin_publish_queue where draft_id=$1',[unapproved]))[0].n,0);
  assert.equal((await query('select status from mara_drafts where id=$1',[unapproved]))[0].status,'draft');
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
test('all mutation routes derive owner from authentication; worker uses the authenticated production cron boundary',async()=>{
  for(const route of ['connect','disconnect','drafts','drafts/[id]']) {
    const src=await read(`app/api/integrations/linkedin/${route}/route.ts`);
    assert.match(src,/getCurrentUser\(\)/);assert.match(src,/if \(!user\)/);assert.match(src,/sameOrigin\(request\)/);
  }
  const worker=await read('app/api/cron/linkedin-publish/route.ts');assert.match(worker,/handleLinkedInCron/);
  assert.match(await read('lib/linkedin/cron.ts'),/bearerMatches/);
  const deploymentConfig=JSON.parse(await read('vercel.json'));
  assert.deepEqual(deploymentConfig.crons.filter(row=>row.path==='/api/cron/linkedin-publish'),[
    {path:'/api/cron/linkedin-publish',schedule:'*/5 * * * *'},
  ]);
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
