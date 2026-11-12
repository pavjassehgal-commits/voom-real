import './helpers/server-only-shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {Webhook} from 'standardwebhooks';
const {createResendDomainApiClient}=await import('../lib/email/domain-client.ts');
const {createResendApiClient}=await import('../lib/email/core.ts');
const {deliveryScopeTags,readDeliveryScope,validDeliveryProof}=await import('../lib/email/delivery-scope.ts');
const {createResendWebhookHandler}=await import('../lib/email/webhook-handler.ts');
const {verifyResendWebhook,normalizeResendWebhook}=await import('../lib/email/providers/resend.ts');
const {dispatchSafeMarketingEmail}=await import('../lib/email/marketing-safety.ts');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const source='33333333-3333-4333-8333-333333333333';
const env={VERCEL_ENV:'preview',EMAIL_DELIVERY_SCOPE:'email-safety-staging',EMAIL_DELIVERY_SCOPE_SECRET:'synthetic-staging-proof-secret-123456789'};
const scope=readDeliveryScope(env);
const hookSecret='whsec_'+Buffer.from('synthetic-only-webhook-signing-key').toString('base64');
const config={provider:'resend',apiKey:'synthetic-sending',fromAddress:'preview@example.invalid',fromName:'Test',webhookSecret:hookSecret,apiBaseUrl:'https://api.resend.com'};
test.before(()=>{globalThis.fetch=async()=>{throw new Error('Real network forbidden');};});

test('domain client requires a separate credential, never borrows the send key',()=>{
  for(const e of [{EMAIL_PROVIDER_API_KEY:'send'}, {EMAIL_DOMAIN_API_KEY:'same',EMAIL_PROVIDER_API_KEY:'same'}])assert.throws(()=>createResendDomainApiClient(e),/email_domain_credentials_required/);
});
test('domain reads use only management credential; sends use only restricted delivery credential',async()=>{
  const calls=[];const fetch=async(url,init)=>{calls.push({url:String(url),...init});return Response.json({id:'verified-domain-1'});};
  const domains=createResendDomainApiClient({EMAIL_DOMAIN_API_KEY:'synthetic-domain',EMAIL_PROVIDER_API_KEY:'synthetic-send'},{fetch});
  await domains.request('GET','domains/verified-domain-1');
  await createResendApiClient({...config,apiKey:'synthetic-send'},{fetch}).post('emails',{});
  assert.equal(calls[0].headers.get('Authorization'),'Bearer synthetic-domain');
  assert.equal(calls[1].headers.get('Authorization'),'Bearer synthetic-send');
  assert.equal(calls[0].redirect,'error');
});
test('domain capability cannot send, delete, rotate credentials, redirect or set up domains by default',async()=>{
  let calls=0;const client=createResendDomainApiClient({EMAIL_DOMAIN_API_KEY:'domain'},{fetch:async()=>{calls++;return Response.json({});}});
  for(const [method,path] of [['POST','emails'],['POST','api-keys'],['DELETE','domains/verified-domain-1'],['GET','https://attacker.invalid/domains'],['GET','domains/../emails'],['POST','domains'],['POST','domains/verified-domain-1/verify']])await assert.rejects(()=>client.request(method,path),/email_domain_operation_denied/);
  assert.equal(calls,0);
});
test('explicit domain setup capability supports only existing DNS-gated create/verify paths',async()=>{
  const calls=[];const client=createResendDomainApiClient({EMAIL_DOMAIN_API_KEY:'domain',EMAIL_DOMAIN_SETUP_ENABLED:'true'},{fetch:async(url,init)=>{calls.push({url:String(url),...init});return Response.json({});}});
  await client.request('GET','domains?limit=100&after=cursor-1');
  await client.request('POST','domains',{name:'owner.example'});
  await client.request('POST','domains/verified-domain-1/verify');
  await assert.rejects(()=>client.request('DELETE','domains/verified-domain-1'),/operation_denied/);
  assert.equal(calls.length,3);
});
test('Preview scope fails closed when missing, partial or invalid; legacy Production config stays compatible',()=>{
  for(const e of [{VERCEL_ENV:'preview'},{EMAIL_DELIVERY_SCOPE:'staging'}, {...env,EMAIL_DELIVERY_SCOPE_SECRET:'short'}, {...env,EMAIL_DELIVERY_SCOPE:'bad/scope'}])assert.throws(()=>readDeliveryScope(e));
  assert.equal(readDeliveryScope({VERCEL_ENV:'production'}),null);
});
test('delivery proof binds environment, owner, source ID and kind without exposing its secret',()=>{
  const p={ownerId:A,sourceId:source,sourceKind:'campaign'};
  const tags=deliveryScopeTags(p,scope);const proof=tags[1].value;
  assert.equal(validDeliveryProof(scope,p,proof),true);
  for(const changed of [{...p,ownerId:B},{...p,sourceId:A},{...p,sourceKind:'flow'}])assert.equal(validDeliveryProof(scope,changed,proof),false);
  assert.equal(validDeliveryProof({...scope,name:'production'},p,proof),false);
  assert(!JSON.stringify(tags).includes(scope.secret));
});
function fixture({owner=A,dbError=false,missing=false,collision=null,recordError=false,scopeEnv=env}={}){
  const calls={db:0,reads:0,records:[]};
  const row={owner_user_id:owner,source_id:source,source_kind:'campaign',state:'uncertain',provider_message_id:null};
  const db={from(table){assert.equal(table,'voom_email_submissions');let filters=[];return {select(){return this;},eq(k,v){filters.push([k,v]);return this;},async maybeSingle(){calls.reads++;return {data:missing?null:filters.some(([k])=>k==='provider_message_id')?collision:row,error:dbError?{message:'down'}:null};}};}};
  const handler=createResendWebhookHandler({env:scopeEnv,config:()=>config,verify:verifyResendWebhook,normalize:normalizeResendWebhook,db:()=>{calls.db++;return db;},record:async(_db,input)=>{if(recordError)throw new Error('persistence down');calls.records.push(input);}});
  return {calls,row,handler};
}
function event(type='email.delivered',override={}){
  return {type,created_at:new Date().toISOString(),data:{email_id:'provider-message-1',tags:{voom_delivery:source,voom_kind:'campaign',...Object.fromEntries(deliveryScopeTags({ownerId:A,sourceId:source,sourceKind:'campaign'},scope).map(t=>[t.name,t.value])),...override}}};
}
function request(e,{bad=false}={}){
  const body=JSON.stringify(e),id='event-1',date=new Date();
  const sig=new Webhook(hookSecret).sign(id,date,body);
  return new Request('https://staging.example/api/webhooks/resend',{method:'POST',headers:{'svix-id':id,'svix-timestamp':String(Math.floor(date.getTime()/1000)),'svix-signature':bad?'v1,forged':sig},body});
}
test('unsigned/tampered callbacks never access the database',async()=>{
  const f=fixture();assert.equal((await f.handler(request(event(),{bad:true}))).status,403);assert.equal(f.calls.db,0);
});
test('validly signed Production/unrelated callbacks are discarded without any staging reads or writes',async()=>{
  const f=fixture();for(const tags of [{}, {voom_scope:'production',voom_proof:'a'.repeat(64)}]){
    const e=event('email.complained');e.data.tags=tags;
    assert.equal((await f.handler(request(e))).status,200);
  }
  // Explicitly remove every tag as shared transactional events have none.
  const e=event();e.data.tags={};assert.equal((await f.handler(request(e))).status,200);
  assert.equal(f.calls.records.length,0);
  assert.equal(f.calls.db,0);
});
test('no scope configuration in Preview causes retryable failure, never legacy processing',async()=>{
  const f=fixture({scopeEnv:{VERCEL_ENV:'preview'}});assert.equal((await f.handler(request(event()))).status,503);assert.equal(f.calls.db,0);
});
test('forged business binding and mismatched message IDs cannot update another tenant',async()=>{
  const f=fixture({owner:B});assert.equal((await f.handler(request(event('email.bounced')))).status,403);assert.equal(f.calls.records.length,0);
  const g=fixture();g.row.provider_message_id='different-message';assert.equal((await g.handler(request(event()))).status,403);assert.equal(g.calls.records.length,0);
  const h=fixture({collision:{owner_user_id:B,source_id:B,source_kind:'campaign'}});assert.equal((await h.handler(request(event()))).status,403);assert.equal(h.calls.records.length,0);
});
test('delivery/bounce/complaint callbacks for the exact authorized submission reach the durable gate',async()=>{
  for(const type of ['email.delivered','email.bounced','email.complained']){
    const f=fixture();assert.equal((await f.handler(request(event(type)))).status,200);
    assert.equal(f.calls.records[0].sourceId,source);assert.equal(f.calls.records[0].eventType,type);
  }
});
test('missing submissions, database errors and failed recording remain retryable and recover',async()=>{
  for(const options of [{missing:true},{dbError:true},{recordError:true}]){
    const f=fixture(options);assert.equal((await f.handler(request(event()))).status,503);assert.equal(f.calls.records.length,0);
  }
  const f=fixture();for(let n=0;n<2;n++)assert.equal((await f.handler(request(event()))).status,200);
  assert.equal(f.calls.records[0].eventId,f.calls.records[1].eventId,'replays keep the existing SQL deduplication key');
});
test('legacy Production keeps existing untagged callbacks but never processes staging-scoped events',async()=>{
  const f=fixture({scopeEnv:{VERCEL_ENV:'production'}}),e=event();
  assert.equal((await f.handler(request(e))).status,200);assert.equal(f.calls.db,0);
  e.data.tags={};assert.equal((await f.handler(request(e))).status,200);assert.equal(f.calls.records.length,1);
});
test('missing Preview proof configuration blocks marketing before reservation or provider submission',async()=>{
  const old=process.env.VERCEL_ENV;process.env.VERCEL_ENV='preview';
  try {
    const result=await dispatchSafeMarketingEmail({rpc(){throw new Error('Must not reserve');}}, {ownerId:A,sourceId:source,sourceKind:'campaign'}, {send(){throw new Error('Must not send');}});
    assert.equal(result.errorCode,'email_delivery_scope_required');
  } finally {if(old===undefined)delete process.env.VERCEL_ENV;else process.env.VERCEL_ENV=old;}
});
