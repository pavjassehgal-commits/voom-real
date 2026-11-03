import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import {test,before,beforeEach,after} from 'node:test';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
const {processTransactionalEmail}=await import('../lib/transactional-email/core.ts');
let db;
const A='00000000-0000-4000-8000-000000000074',B='00000000-0000-4000-8000-000000000075';
before(async()=>{({db}=await createSupabaseLite());await db.exec('alter table auth.users add column email_confirmed_at timestamptz, add column confirmation_sent_at timestamptz');});
after(async()=>{await db?.close();});
beforeEach(async()=>{
  await db.exec('truncate voom_transactional_emails cascade; truncate voom_auth_email_limits; delete from auth.users');
  await db.query("insert into auth.users(id,email,email_confirmed_at,confirmation_sent_at) values($1,'owner@example.test',now(),now()),($2,'other@example.test',null,null)",[A,B]);
  await db.exec("update voom_transactional_email_policy set enabled=false,welcome_start_at=null,next_send_at=now(),quota_day=null,quota_month=null,day_attempts=0,month_attempts=0");
});
const enable=()=>db.exec("update voom_transactional_email_policy set enabled=true,welcome_start_at=now()-interval '1 hour'");
const queue=id=>db.query('select queue_voom_welcome($1)',[id]);
const claim=async()=>(await db.query('select * from claim_voom_transactional_email()')).rows;
test('migration OFF; no backfill; unconfirmed and older accounts cannot receive welcomes',async()=>{
  await queue(A);assert.equal((await db.query('select * from voom_transactional_emails')).rows.length,0);
  await enable();await queue(B);assert.equal((await db.query('select * from voom_transactional_emails')).rows.length,0);
  await db.query("update auth.users set created_at=now()-interval '2 days' where id=$1",[A]);await queue(A);assert.equal((await claim()).length,0);
});
test('repeated/concurrent enqueue deduplicates with real PG uniqueness; one claim only',async()=>{
  await enable();await Promise.all(Array.from({length:12},()=>queue(A)));
  assert.equal((await db.query('select * from voom_transactional_emails')).rows.length,1);
  assert.equal((await Promise.all([claim(),claim()])).flat().length,1);
});
test('browser roles cannot read outbox or execute privileged functions',async()=>{
  for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(db.query('select * from voom_transactional_emails'),/permission denied/);await assert.rejects(queue(A),/permission denied/);await assert.rejects(db.query("select consume_voom_auth_email_limit(repeat('a',64),repeat('b',64))"),/permission denied/);await db.exec('reset role');}
});
test('changed recipient cancels queued welcome; account deletion removes its private evidence',async()=>{
  await enable();await queue(A);await db.query("update auth.users set email='changed@example.test' where id=$1",[A]);assert.equal((await claim()).length,0);
  assert.equal((await db.query('select status from voom_transactional_emails')).rows[0].status,'cancelled');await db.query('delete from auth.users where id=$1',[A]);assert.equal((await db.query('select * from voom_transactional_emails')).rows.length,0);
});
test('claim fencing and stale-claim handling cannot authorize another provider submission',async()=>{
  await enable();await queue(A);const [e]=await claim();await assert.rejects(db.query('select prepare_voom_transactional_email($1,$2,$3)',[e.id,B,JSON.stringify({to:[e.recipient],html:'x',text:'x'})]),/claim_invalid/);
  await db.exec("update voom_transactional_emails set claimed_at=now()-interval '2 minutes';update voom_transactional_email_policy set next_send_at=now()");assert.equal((await claim()).length,0);assert.equal((await db.query('select status from voom_transactional_emails')).rows[0].status,'uncertain');
});
test('frozen body cannot change; expired retry window fails without provider submission',async()=>{
  await enable();await queue(A);const [e]=await claim(),body={to:[e.recipient],html:'original',text:'original'};
  await db.query('select prepare_voom_transactional_email($1,$2,$3)',[e.id,e.claim_token,JSON.stringify(body)]);
  const same=await db.query('select prepare_voom_transactional_email($1,$2,$3) payload',[e.id,e.claim_token,JSON.stringify({...body,html:'changed'})]);assert.deepEqual(same.rows[0].payload,body);
  await db.query("select finish_voom_transactional_email($1,$2,'retryable',null,'provider_rate_limited')",[e.id,e.claim_token]);
  await db.exec("update voom_transactional_emails set first_attempt_at=now()-interval '24 hours',next_attempt_at=now();update voom_transactional_email_policy set next_send_at=now()");assert.equal((await claim()).length,0);assert.equal((await db.query('select status from voom_transactional_emails')).rows[0].status,'failed');
});
test('receipt replay is idempotent; another provider message cannot bind or downgrade delivery',async()=>{
  await enable();await queue(A);const [e]=await claim();await db.query('select prepare_voom_transactional_email($1,$2,$3)',[e.id,e.claim_token,JSON.stringify({to:[e.recipient],html:'x',text:'x'})]);
  const receive=(event,id,status)=>db.query('select record_voom_transactional_receipt($1,$2,$3,$4)',[e.id,event,id,status]);
  await receive('evt_1','msg_1','delivered');await receive('evt_1','msg_1','delivered');await receive('evt_2','msg_1','accepted');assert.equal((await db.query('select status from voom_transactional_emails')).rows[0].status,'delivered');assert.equal((await db.query('select * from voom_transactional_email_receipts')).rows.length,2);await assert.rejects(receive('evt_3','wrong','delivered'),/message_conflict/);
});
test('auth limiter rejects NULL, bounds recipient requests, and stores hashes only',async()=>{
  assert.equal((await db.query('select consume_voom_auth_email_limit(null,null) ok')).rows[0].ok,false);
  for(let i=0;i<3;i++)assert.equal((await db.query("select consume_voom_auth_email_limit(repeat('a',64),repeat('b',64)) ok")).rows[0].ok,true);
  assert.equal((await db.query("select consume_voom_auth_email_limit(repeat('a',64),repeat('b',64)) ok")).rows[0].ok,false);
  assert.equal((await db.query("select count(*)::int n from voom_auth_email_limits where subject_hash !~ '^[a-f0-9]{64}$'")).rows[0].n,0);
});
test('actual DB → mocked Resend → accepted, with no duplicate worker submission',async()=>{
  await enable();await queue(A);let sends=0;
  const adapter={async rpc(name,args={}){try{const keys=Object.keys(args),values=keys.map(k=>k==='p_payload'?JSON.stringify(args[k]):args[k]);const result=await db.query('select * from '+name+'('+keys.map((k,i)=>k+'=> $'+(i+1)).join(',')+')',values);return {data:name==='claim_voom_transactional_email'?result.rows:name==='prepare_voom_transactional_email'?result.rows[0][name]:null,error:null};}catch(error){return {error,data:null};}}};
  const config={key:'synthetic',secret:'s'.repeat(32),site:'https://staging.example.test',from:'no-reply@example.test',testRecipient:'owner@example.test',webhook:''};
  const fetch=async()=>{sends++;return Response.json({id:'msg_real_db_mock_provider'});};
  assert.equal((await processTransactionalEmail(adapter,config,fetch)).status,'accepted');assert.equal((await processTransactionalEmail(adapter,config,fetch)).status,'idle');assert.equal(sends,1);assert.deepEqual((await db.query('select status,attempts from voom_transactional_emails')).rows[0],{status:'accepted',attempts:1});
});
test('worker recovers a lost callback enqueue but excludes auto-confirmed users',async()=>{
  await enable();await db.query('update auth.users set confirmation_sent_at=null where id=$1',[A]);assert.equal((await claim()).length,0);
  await db.query('update auth.users set confirmation_sent_at=now() where id=$1',[A]);assert.equal((await claim()).length,1);
});
test('daily and monthly attempt caps block claims without changing pending mail',async()=>{
  await enable();await queue(A);
  await db.exec("update voom_transactional_email_policy set quota_day=(now() at time zone 'UTC')::date,day_attempts=50");assert.equal((await claim()).length,0);
  await db.exec("update voom_transactional_email_policy set day_attempts=0,quota_month=date_trunc('month',now() at time zone 'UTC')::date,month_attempts=500");assert.equal((await claim()).length,0);
  assert.equal((await db.query('select status from voom_transactional_emails')).rows[0].status,'pending');
});
test('definitively rejected retries are bounded at three, never create another outbox record',async()=>{
  await enable();await queue(A);
  for(let n=1;n<=3;n++){
    await db.exec('update voom_transactional_email_policy set next_send_at=now();update voom_transactional_emails set next_attempt_at=now()');
    const [e]=await claim();assert.equal(e.attempts,n);await db.query("select finish_voom_transactional_email($1,$2,'retryable',null,'provider_rate_limited')",[e.id,e.claim_token]);
  }
  await db.exec('update voom_transactional_email_policy set next_send_at=now()');assert.equal((await claim()).length,0);
  assert.deepEqual((await db.query('select status,attempts from voom_transactional_emails')).rows,[{status:'failed',attempts:3}]);
});
