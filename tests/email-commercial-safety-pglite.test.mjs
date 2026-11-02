import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseLite, migrationSql } from "./helpers/pglite-supabase.mjs";
const { dispatchSafeMarketingEmail } = await import("../lib/email/marketing-safety.ts");

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
let db;
const one = async (sql, params=[]) => (await db.query(sql,params)).rows[0];
test.before(async()=>{
  ({db}=await createSupabaseLite({stopBefore:"0073"}));
  await db.query("insert into auth.users(id,email) values($1,'a@example.com'),($2,'b@example.com')",[A,B]);
  await db.query("insert into public.businesses(owner_user_id,brand_name,plan) values($1,'Business A','pro'),($2,'Business B','pro')",[A,B]);
  await db.query("insert into public.contacts(owner_id,email,email_status) values($1,'legacy@example.com','subscribed')",[A]);
  const before=await one("select row_to_json(c)::text value from public.contacts c where email='legacy@example.com'");
  await db.exec(migrationSql("0073_email_marketing_safety.sql"));
  const after=await one("select email_status,email_consent_at,email_consent_source from public.contacts where email='legacy@example.com'");
  assert.equal(after.email_status,'subscribed'); assert.equal(after.email_consent_at,null); assert.equal(after.email_consent_source,null);
  assert.match(before.value,/legacy@example.com/);
});
test.after(async()=>{await db?.close();});

const rpcArgs={ reserve_marketing_email_submission:['p_owner','p_key','p_kind','p_source','p_to','p_hash'],record_marketing_email_submission:['p_owner','p_key','p_state','p_message','p_error'] };
const client={ async rpc(name,args){ try { const keys=rpcArgs[name];const row=await one(`select public.${name}(${keys.map((_,i)=>`$${i+1}`).join(',')}) result`,keys.map(k=>args[k]));return {data:row.result,error:null};}catch(error){return {data:null,error:{message:error.message}};} } };
async function ready(owner=A,email=`test-${crypto.randomUUID()}@example.com`){
  const business=await one('select id from public.businesses where owner_user_id=$1',[owner]);
  await db.query("select public.claim_marketing_email_domain($1,$2,$3)",[owner, owner===A?'a.example.com':'b.example.com','1'.repeat(64)]);
  await db.query("update public.voom_email_domains set dns_verified_at=now(),provider_verified_at=now(),provider_domain_id=$2 where owner_user_id=$1 and domain=$3",[owner,owner===A?'domain-a-12345':'domain-b-12345',owner===A?'a.example.com':'b.example.com']);
  await db.query("select public.upsert_email_identity($1,$2)",[owner,JSON.stringify({displayName:'Business',fromAddress:owner===A?'hello@a.example.com':'hello@b.example.com',replyTo:'support@example.com'})]);
  await db.query("update public.voom_email_identities set legal_name='Real Business',postal_address='123 Example Street, Test City' where owner_user_id=$1",[owner]);
  await db.query("insert into public.contacts(owner_id,email,email_status,email_consent_source,email_consent_at) values($1,$2,'subscribed','manual_attestation',now()) on conflict(owner_id,email) do nothing",[owner,email]);
  const campaign=await one("insert into public.voom_campaigns(owner_user_id,kind,name,objective,audience,content,status,approved_at) values($1,'email','Test','Test goal','Subscribers','Approved body','approved',now()) returning id",[owner]);
  const recipient=await one("select * from public.add_campaign_recipient($1,$2,$3,'Test',now(),'recorded-consent')",[owner,campaign.id,email]);
  const send=await one("select * from public.claim_campaign_send($1,$2,$3,$4)",[owner,campaign.id,recipient.id,`claim-${crypto.randomUUID()}`]);
  return {ownerId:owner,sourceKind:'campaign',sourceId:send.id,idempotencyKey:`campaign-email:${send.id}`,to:email,from:owner===A?'Business <hello@a.example.com>':'Business <hello@b.example.com>',replyTo:'support@example.com',subject:'Harmless test',preheader:'Preview',html:'<p>Original message</p>',text:'Original message',oneClickUnsubscribeUrl:'https://voom.example/api/unsubscribe?token=signed',campaignId:campaign.id};
}
async function enable(){await db.exec("update public.voom_email_sending_policy set enabled=true,next_send_at='-infinity',business_daily_limit=50,business_monthly_limit=500,provider_daily_limit=90,provider_monthly_limit=2700");}
const provider=(fn=async()=>({ok:true,provider:'resend',providerMessageId:crypto.randomUUID(),providerStatus:'accepted',errorCode:null,errorKind:null,errorMessage:null,ambiguous:false}))=>{const calls=[];return {calls,async send(input){calls.push(input);return fn(input);}};};

test('migration defaults commercial sending OFF; no legacy consent is invented',async()=>{
  assert.equal((await one('select enabled from public.voom_email_sending_policy')).enabled,false);
  await assert.rejects(()=>ready(),/marketing_email_disabled/);
  await enable(); const p=await ready(); await db.exec('update public.voom_email_sending_policy set enabled=false');
  const fake=provider(); const r=await dispatchSafeMarketingEmail(client,p,fake);
  assert.equal(r.errorCode,'marketing_email_disabled');assert.equal(fake.calls.length,0);
  assert.equal((await one("select email_consent_at from public.contacts where email='legacy@example.com'")).email_consent_at,null);
});
test('two businesses cannot claim each other’s domain, parent or subdomain',async()=>{
  await assert.rejects(()=>db.query("select public.claim_marketing_email_domain($1,'a.example.com',$2)",[B,'2'.repeat(64)]),/domain_unavailable/);
  await assert.rejects(()=>db.query("select public.claim_marketing_email_domain($1,'child.a.example.com',$2)",[B,'2'.repeat(64)]),/domain_unavailable/);
  await assert.rejects(()=>db.query("select public.claim_marketing_email_domain($1,'example.com',$2)",[B,'2'.repeat(64)]),/domain_unavailable/);
});
test('accepted submission is delivered to the provider once, with RFC8058 headers; repeated calls reuse receipt',async()=>{
  await enable();const p=await ready();const fake=provider();
  const first=await dispatchSafeMarketingEmail(client,p,fake);const second=await dispatchSafeMarketingEmail(client,p,fake);
  assert.equal(first.ok,true);assert.equal(second.providerMessageId,first.providerMessageId);assert.equal(fake.calls.length,1);
  assert.equal(fake.calls[0].headers['List-Unsubscribe-Post'],'List-Unsubscribe=One-Click');
  assert.equal(fake.calls[0].headers['List-Unsubscribe'],`<${p.oneClickUnsubscribeUrl}>`);
});
test('lost provider response blocks every later submission, including after the provider’s 24-hour dedupe window',async()=>{
  await enable();const p=await ready();const fake=provider(async()=>{throw new Error('response lost after accept');});
  const first=await dispatchSafeMarketingEmail(client,p,fake);assert.equal(first.ambiguous,true);
  await db.query("update public.voom_email_submissions set created_at=now()-interval '3 days' where source_id=$1",[p.sourceId]);
  assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).ambiguous,true);assert.equal(fake.calls.length,1);
  assert.equal((await one('select count(*)::int n from public.voom_email_send_meter where logical_key=$1',[p.idempotencyKey])).n,1);
});
test('provider success followed by a failed database result write cannot cause a second provider call',async()=>{
  await enable();const p=await ready();const fake=provider();
  const broken={rpc:(name,args)=>name==='record_marketing_email_submission'?Promise.resolve({error:{message:'unavailable'}}):client.rpc(name,args)};
  assert.equal((await dispatchSafeMarketingEmail(broken,p,fake)).ambiguous,true);
  assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).ambiguous,true);assert.equal(fake.calls.length,1);
});
test('missing result-write confirmation is uncertain and cannot authorize another provider call',async()=>{
  await enable();const p=await ready();const fake=provider();
  const missing={rpc:(name,args)=>name==='record_marketing_email_submission'?Promise.resolve({data:null,error:null}):client.rpc(name,args)};
  assert.equal((await dispatchSafeMarketingEmail(missing,p,fake)).ambiguous,true);
  assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).ambiguous,true);assert.equal(fake.calls.length,1);
});
test('explicit provider rejection permits only bounded, delayed, byte-identical retries',async()=>{
  await enable();const p=await ready();const fake=provider(async()=>({ok:false,provider:'resend',providerMessageId:null,providerStatus:null,errorCode:'HTTP_429',errorKind:'rejected',errorMessage:'Rate limited',ambiguous:false}));
  await dispatchSafeMarketingEmail(client,p,fake);
  assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).errorCode,'email_retry_not_due');
  await db.query("update public.voom_email_submissions set updated_at=now()-interval '2 minutes' where source_id=$1",[p.sourceId]);
  assert.equal((await dispatchSafeMarketingEmail(client,{...p,text:'changed'},fake)).errorCode,'email_payload_changed');
  await db.exec("update public.voom_email_sending_policy set next_send_at='-infinity'");
  await dispatchSafeMarketingEmail(client,p,fake);assert.equal(fake.calls.length,2);
  await db.query("update public.voom_email_submissions set created_at=now()-interval '24 hours',updated_at=now()-interval '2 minutes' where source_id=$1",[p.sourceId]);
  assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).errorCode,'email_retry_window_closed');assert.equal(fake.calls.length,2);
});
test('cross-owner source, withdrawn approval, unknown consent and suppression all fail before provider call',async()=>{
  for(const scenario of ['owner','approval','consent','suppression']){
    await enable();const p=await ready();const fake=provider();let input=p;
    if(scenario==='owner') input={...p,ownerId:B};
    if(scenario==='approval') await db.query("update public.voom_campaigns set status='draft',approved_at=null where id=$1",[p.campaignId]);
    if(scenario==='consent') await db.query("update public.contacts set email_status='unknown' where owner_id=$1 and email=$2",[A,p.to]);
    if(scenario==='suppression') await db.query("select public.record_email_suppression($1,$2,'manual')",[A,p.to]);
    assert.equal((await dispatchSafeMarketingEmail(client,input,fake)).ok,false,scenario);assert.equal(fake.calls.length,0,scenario);
  }
});
test('missing safety database cannot authorize a send',async()=>{
  const fake=provider();const p=await ready();const r=await dispatchSafeMarketingEmail({rpc:async()=>{throw new Error('database down');}},p,fake);
  assert.equal(r.errorCode,'email_safety_check_unavailable');assert.equal(fake.calls.length,0);
});
test('unavailable suppression storage fails the actual SQL send gate before any provider call',async()=>{
  await enable();const p=await ready();const fake=provider();
  await db.exec('begin; alter table public.voom_email_suppressions rename to synthetic_unavailable_suppressions');
  try {assert.equal((await dispatchSafeMarketingEmail(client,p,fake)).ok,false);assert.equal(fake.calls.length,0);}
  finally {await db.exec('rollback');}
});
test('business and provider allowances and global throttle hold across separate logical sends',async()=>{
  await enable();const p=await ready();const q=await ready();const fake=provider();
  await dispatchSafeMarketingEmail(client,p,fake);
  assert.equal((await dispatchSafeMarketingEmail(client,q,fake)).errorCode,'email_provider_throttled');
  const used=(await one('select count(*)::int n from public.voom_email_send_meter where owner_user_id=$1 and created_at>current_date',[A])).n;
  await db.query("update public.voom_email_sending_policy set next_send_at='-infinity',business_daily_limit=$1",[used]);
  assert.equal((await dispatchSafeMarketingEmail(client,q,fake)).errorCode,'email_business_allowance_reached');
  await db.exec("update public.voom_email_sending_policy set business_daily_limit=50,provider_daily_limit=1");
  const other=await ready(B);
  assert.equal((await dispatchSafeMarketingEmail(client,other,fake)).errorCode,'email_provider_allowance_reached');assert.equal(fake.calls.length,1);
});
test('authenticated owners cannot write verification/budgets/submissions or execute server-only gates',async()=>{
  await db.exec(`set role authenticated;set request.jwt.claim.sub='${B}'`);
  try {
    assert.equal((await db.query('select * from public.voom_email_domains where owner_user_id=$1',[A])).rows.length,0);
    await assert.rejects(()=>db.exec("update public.voom_email_domains set provider_verified_at=now()"),/permission denied/);
    await assert.rejects(()=>db.exec("update public.voom_email_sending_policy set enabled=true"),/permission denied/);
    await assert.rejects(()=>db.query("select public.claim_marketing_email_domain($1,'victim.example.com',$2)",[B,'3'.repeat(64)]),/permission denied/);
  } finally {await db.exec('reset role');}
});
test('webhook receipts survive out-of-order arrival; retry atomically records bounce suppression and deduplicates',async()=>{
  await enable();const p=await ready();const event=`event-${crypto.randomUUID()}`;const message=`msg-${crypto.randomUUID()}`;
  const run=()=>one("select public.record_marketing_email_webhook($1,$2,'email.bounced','bounced',now()) ok",[event,message]);
  assert.equal((await run()).ok,true); // durable receipt, not falsely marked processed
  assert.equal((await one('select processed_at from public.voom_email_webhook_receipts where event_id=$1',[event])).processed_at,null);
  await db.query("select public.record_campaign_send_provider_result($1,$2,'accepted','accepted',$3)",[A,p.sourceId,message]);
  assert.equal((await one('select public.reconcile_marketing_email_webhooks() n')).n,1);
  assert.equal((await run()).ok,true);assert.equal((await run()).ok,true);
  assert.equal((await one('select count(*)::int n from public.voom_email_suppressions where owner_id=$1 and email=$2',[A,p.to])).n,1);
  assert.equal((await one('select count(*)::int n from public.voom_email_webhook_receipts where event_id=$1',[event])).n,1);
});
test('verified provider tags reconcile a lost send response without any second provider submission',async()=>{
  await enable();await db.exec('delete from public.voom_email_business_controls');const p=await ready();
  const fake=provider(async()=>{throw new Error('response lost');});await dispatchSafeMarketingEmail(client,p,fake);
  const message=`accepted-${crypto.randomUUID()}`;
  assert.equal((await one("select public.record_marketing_email_webhook($1,$2,'email.delivered','delivered',now(),$3,'campaign') ok",[`event-${message}`,message,p.sourceId])).ok,true);
  const result=await dispatchSafeMarketingEmail(client,p,fake);assert.equal(result.ok,true);assert.equal(result.providerMessageId,message);assert.equal(fake.calls.length,1);
  assert.equal((await one('select internal_status from public.campaign_sends where id=$1',[p.sourceId])).internal_status,'delivered');
  await one("select public.record_marketing_email_webhook($1,$2,'email.opened','opened',now(),$3,'campaign')",[`opened-${message}`,message,p.sourceId]);
  assert.equal((await one('select internal_status from public.campaign_sends where id=$1',[p.sourceId])).internal_status,'delivered');
});
test('provider API slot serializes requests globally and never authorizes parallel slots',async()=>{
  await db.exec("update public.voom_email_sending_policy set next_api_at='-infinity'");
  assert.equal((await one('select public.claim_marketing_email_provider_slot() n')).n,0);
  assert.ok((await one('select public.claim_marketing_email_provider_slot() n')).n>0);
});
test('failed suppression write rolls back webhook completion; retry succeeds after recovery',async()=>{
  const p=await ready();const message=`msg-${crypto.randomUUID()}`;const event=`event-${crypto.randomUUID()}`;
  await db.query("select public.record_campaign_send_provider_result($1,$2,'accepted','accepted',$3)",[A,p.sourceId,message]);
  await db.exec("create function public.synthetic_suppression_failure() returns trigger language plpgsql as $$ begin raise exception 'synthetic storage failure'; end $$; create trigger synthetic_suppression_failure before insert on public.voom_email_suppressions for each row execute function public.synthetic_suppression_failure()");
  try {await assert.rejects(()=>one("select public.record_marketing_email_webhook($1,$2,'email.complained','complained',now())",[event,message]),/synthetic storage failure/);}
  finally {await db.exec('drop trigger synthetic_suppression_failure on public.voom_email_suppressions;drop function public.synthetic_suppression_failure()');}
  assert.equal((await one('select count(*)::int n from public.voom_email_webhook_receipts where event_id=$1',[event])).n,0);
  assert.equal((await one("select public.record_marketing_email_webhook($1,$2,'email.complained','complained',now()) ok",[event,message])).ok,true);
});
test('address changes never transfer consent; consent events remain auditable',async()=>{
  const p=await ready();await db.query("update public.contacts set email='new-address@example.com' where owner_id=$1 and email=$2",[A,p.to]);
  const c=await one("select email_status,email_consent_at from public.contacts where email='new-address@example.com'");
  assert.equal(c.email_status,'unknown');assert.equal(c.email_consent_at,null);
  assert.ok((await one("select count(*)::int n from public.voom_email_consent_events where owner_user_id=$1",[A])).n>0);
});
test('overlapping requests for the same delivery never invoke the provider twice',async()=>{
  await enable();await db.exec('delete from public.voom_email_business_controls');const p=await ready();
  let release;const pending=new Promise(resolve=>{release=resolve;});let started;const began=new Promise(resolve=>{started=resolve;});
  const fake=provider(async()=>{started();await pending;return {ok:true,provider:'resend',providerMessageId:crypto.randomUUID(),providerStatus:'accepted',errorCode:null,errorKind:null,errorMessage:null,ambiguous:false};});
  const first=dispatchSafeMarketingEmail(client,p,fake);await began;
  const second=await dispatchSafeMarketingEmail(client,p,fake);assert.equal(second.ambiguous,true);release();await first;assert.equal(fake.calls.length,1);
});
test('pending domain challenges cannot squat another business’s domain, but only one proven owner can bind',async()=>{
  await db.query("select public.claim_marketing_email_domain($1,'shared.test.example',$2)",[A,'a'.repeat(64)]);
  await db.query("select public.claim_marketing_email_domain($1,'shared.test.example',$2)",[B,'b'.repeat(64)]);
  await db.query("select public.bind_marketing_email_domain($1,'shared.test.example','shared-domain-id',true)",[A]);
  await assert.rejects(()=>db.query("select public.bind_marketing_email_domain($1,'shared.test.example','other-domain-id',true)",[B]),/domain_unavailable/);
});
test('a verified complaint suspends only its business, never another tenant',async()=>{
  // The earlier fault-injection complaint was retried successfully.
  // Subsequent tests reset controls to isolate their own sends.
  const p=await ready();const id=`complaint-${crypto.randomUUID()}`;
  await db.query("select public.record_campaign_send_provider_result($1,$2,'accepted','accepted',$3)",[A,p.sourceId,id]);
  await one("select public.record_marketing_email_webhook($1,$2,'email.complained','complained',now())",[`event-${id}`,id]);
  assert.equal((await one('select suspended from public.voom_email_business_controls where owner_user_id=$1',[A])).suspended,true);
  assert.equal((await one('select count(*)::int n from public.voom_email_business_controls where owner_user_id=$1 and suspended',[B])).n,0);
});
test('owner-activated sequence passes the same SQL gate; pausing before dispatch blocks it',async()=>{
  await enable();await db.exec('delete from public.voom_email_business_controls');
  const p=await ready();const c=await one('select id from public.contacts where owner_id=$1 and email=$2',[A,p.to]);
  const payload={flowType:'welcome',triggerType:'newly_eligible_contact',createdBy:'user',idempotencyKey:`flow-${crypto.randomUUID()}`,name:'Synthetic welcome',objective:'Welcome',reentryPolicy:'once_per_contact',generationSource:'deterministic',steps:[{position:0,title:'Welcome',purpose:'Welcome',waitMinutes:0,subject:'Welcome',body:'Original approved body',cta:'Reply',contentSource:'deterministic'}]};
  const flow=await one('select * from public.create_email_flow($1,$2)',[A,JSON.stringify(payload)]);
  await db.query("select public.set_email_flow_status($1,$2,'active')",[A,flow.id]);
  await db.query("select public.enroll_email_flow_contact($1,$2,$3,now()+interval '5 minutes',$4)",[A,flow.id,c.id,`enroll-${crypto.randomUUID()}`]);
  const run=await one('select id from public.voom_email_flow_step_runs where flow_id=$1',[flow.id]);
  await db.query("update public.voom_email_flow_step_runs set scheduled_for=now()-interval '1 minute' where id=$1",[run.id]);
  const key=`flow-send:${run.id}`;
  await db.query('select public.claim_email_flow_step_run_v2($1,$2,$3,$4)',[A,run.id,`claim-${crypto.randomUUID()}`,key]);
  const input={...p,sourceKind:'flow',sourceId:run.id,idempotencyKey:key};const fake=provider();
  await db.query("select public.set_email_flow_status($1,$2,'paused')",[A,flow.id]);
  assert.equal((await dispatchSafeMarketingEmail(client,input,fake)).errorCode,'email_source_not_authorized');assert.equal(fake.calls.length,0);
  await db.query("select public.set_email_flow_status($1,$2,'active')",[A,flow.id]);
  const sent=await dispatchSafeMarketingEmail(client,input,fake);assert.equal(sent.ok,true);assert.equal(fake.calls.length,1);
  await one("select public.record_marketing_email_webhook($1,$2,'email.bounced','bounced',now(),$3,'flow')",[`bounce-${run.id}`,sent.providerMessageId,run.id]);
  const acceptedCount=(await one("select count(*)::int n from public.voom_email_flow_events where flow_id=$1 and kind='provider_accepted'",[flow.id])).n;
  await one("select public.record_marketing_email_webhook($1,$2,'email.opened','opened',now(),$3,'flow')",[`open-${run.id}`,sent.providerMessageId,run.id]);
  assert.equal((await one('select status from public.voom_email_flow_step_runs where id=$1',[run.id])).status,'failed');
  assert.equal((await one("select count(*)::int n from public.voom_email_flow_events where flow_id=$1 and kind='provider_accepted'",[flow.id])).n,acceptedCount);
});
