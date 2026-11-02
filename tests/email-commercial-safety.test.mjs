import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
const {checkOwnedDomain,verifyDomainClaim,normalizeSendingDomain}=await import('../lib/email/domains.ts');
const {resolveBusinessSender}=await import('../lib/email/branded/identity.ts');
const {unsubscribeHandler}=await import('../lib/email/unsubscribe-handler.ts');
const {mintUnsubscribeToken}=await import('../lib/email/branded/unsubscribe.ts');
const {createResendDeliveryProvider,normalizeResendWebhook}=await import('../lib/email/providers/resend.ts');
const {recordDeliveryFromWebhook}=await import('../lib/voom/campaign-delivery.ts');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const claim={domain:'updates.business.example',owner_user_id:A,business_id:'business-a',challenge:'a'.repeat(64),provider_domain_id:'provider-domain-a',dns_verified_at:'2026-11-01',provider_verified_at:'2026-11-01'};
function registry(rows=[claim],unavailable=false){return {from(){let filters=[];return {select(){return this;},update(){return this;},eq(k,v){filters.push([k,v]);return this;},async maybeSingle(){return {data:rows.find(r=>filters.every(([k,v])=>r[k]===v))??null,error:unavailable?{message:'down'}:null};},then(fn){return Promise.resolve({error:unavailable?{message:'down'}:null}).then(fn);}};}};}
function domainProvider(remote={id:claim.provider_domain_id,name:claim.domain,status:'verified'}){const calls=[];return {calls,client:{async request(method,path){calls.push({method,path});return Response.json(remote);}}};}
const txt=async()=>[[`voom-email=${claim.challenge}`]];
test.before(()=>{globalThis.fetch=async()=>{throw new Error('No real provider calls allowed');};});
test('global verified domain alone cannot authorize a business sender',()=>{
  const r=resolveBusinessSender({config:{fromAddress:'no-reply@voom.example',fromName:'Voom'},identity:{from_address:`ceo@${claim.domain}`},brandName:'Other Business',providerDomains:new Map([[claim.domain,'verified']])});
  assert.equal(r.mode,'voom_fallback');assert.equal(r.fromAddress,'no-reply@voom.example');
});
test('two-business domain isolation: only owner A can use its live DNS/provider proof',async()=>{
  const p=domainProvider();assert.equal(await checkOwnedDomain(registry(),A,claim.domain,{client:p.client,txt}),true);
  assert.equal(await checkOwnedDomain(registry(),B,claim.domain,{client:p.client,txt}),false);assert.equal(p.calls.length,1);
});
test('missing or failed DNS proof never authorizes a sender or creates a provider domain',async()=>{
  const p=domainProvider();const deps={client:p.client,txt:async()=>{throw new Error('DNS unavailable');}};
  assert.equal(await checkOwnedDomain(registry(),A,claim.domain,deps),false);
  await assert.rejects(()=>verifyDomainClaim(registry(),A,claim.domain,deps),/dns_ownership_not_verified/);assert.equal(p.calls.length,0);
});
test('provider ID/name mismatch, disabled sending and unverified state cannot authorize',async()=>{
  for(const remote of [{id:'other-domain',name:claim.domain,status:'verified'},{id:claim.provider_domain_id,name:'victim.example',status:'verified'},{id:claim.provider_domain_id,name:claim.domain,status:'pending'},{id:claim.provider_domain_id,name:claim.domain,status:'verified',capabilities:{sending:'disabled'}}]){
    assert.equal(await checkOwnedDomain(registry(),A,claim.domain,{client:domainProvider(remote).client,txt}),false);
  }
});
test('unavailable domain registry fails closed; malformed domain cannot enter DNS/provider paths',async()=>{
  await assert.rejects(()=>checkOwnedDomain(registry([],true),A,claim.domain,{client:domainProvider().client,txt}),/domain_registry_unavailable/);
  for(const bad of ['http://example.com','127.0.0.1','example.com/path','x..example.com','x.example.com\nattack'])assert.throws(()=>normalizeSendingDomain(bad));
});
test('sender display names cannot introduce another From mailbox or newline header',()=>{
  const r=resolveBusinessSender({config:{fromAddress:'n@voom.example',fromName:'Voom'},identity:{from_address:`hello@${claim.domain}`,display_name:'Fake <ceo@victim.example>\r\nBcc: bad@example.com'},brandName:'Business',providerDomains:new Map([[claim.domain,'verified']]),ownedDomainVerified:true});
  assert(!/[\r\n]/.test(r.from));assert(r.from.startsWith('"'));assert(r.from.endsWith(`<hello@${claim.domain}>`));
});
function unsubscribeDb(fail=false){const calls=[];return {calls,from(){return {select(){return this;},eq(){return this;},async maybeSingle(){return {data:{brand_name:'Business A'}};}};},async rpc(name,args){calls.push({name,args});return fail?{error:{message:'down'}}:{data:{status:'unsubscribed'},error:null};}};}
test('RFC8058 form POST needs no login, returns empty 200 and owner-scoped durable unsubscribe; repeats are safe',async()=>{
  process.env.EMAIL_UNSUBSCRIBE_SECRET='synthetic-unsubscribe-secret';const token=mintUnsubscribeToken(A,'customer@example.com');const db=unsubscribeDb();const handler=unsubscribeHandler(()=>db);
  for(let n=0;n<2;n++){const response=await handler(new Request(`https://voom.example/api/unsubscribe?token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'}));assert.equal(response.status,200);assert.equal(await response.text(),'');}
  assert.equal(db.calls[0].args.p_owner_user_id,A);assert.equal(db.calls[0].args.p_email,'customer@example.com');
});
test('forged one-click tokens, malformed POSTs and failed unsubscribe writes never report success',async()=>{
  const db=unsubscribeDb();const handler=unsubscribeHandler(()=>db);
  assert.equal((await handler(new Request('https://voom.example/api/unsubscribe?token=forged',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'}))).status,400);assert.equal(db.calls.length,0);
  const token=mintUnsubscribeToken(A,'customer@example.com');const response=await unsubscribeHandler(()=>unsubscribeDb(true))(new Request('https://voom.example/api/unsubscribe',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token})}));assert.equal(response.status,503);
});
test('unsubscribe requires a confirmed durable result; a missing RPC result cannot be acknowledged',async()=>{
  const token=mintUnsubscribeToken(A,'customer@example.com');
  for(const data of [null,{}, {status:'pending'}]){
    const db=unsubscribeDb();db.rpc=async()=>({data,error:null});
    const response=await unsubscribeHandler(()=>db)(new Request(`https://voom.example/api/unsubscribe?token=${encodeURIComponent(token)}`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'List-Unsubscribe=One-Click'}));
    assert.equal(response.status,503);
  }
});
test('visible unsubscribe links require an explicit click; GET/link scanners cannot opt out customers',async()=>{
  const page=await readFile(new URL('../app/unsubscribe/page.tsx',import.meta.url),'utf8');
  const route=await readFile(new URL('../app/api/unsubscribe/route.ts',import.meta.url),'utf8');
  assert.match(page,/phase: "confirm"/);assert.match(page,/onClick=\{\(\) => void retry\(\)\}/);
  assert.doesNotMatch(page,/useEffect/);assert.match(route,/303/);
});
test('provider timeouts, server errors and malformed 2xx responses are uncertain, never ordinary retryable failures',async()=>{
  for(const response of [new Response('failure',{status:503}),Response.json({unexpected:true})]){
    const result=await createResendDeliveryProvider({post:async()=>response}).send({});assert.equal(result.ambiguous,true);
  }
  assert.equal((await createResendDeliveryProvider({post:async()=>{throw new Error('timeout');}}).send({})).ambiguous,true);
});
test('webhook database error or unmatched receipt is recoverable, never falsely acknowledged',async()=>{
  const input={provider:'resend',providerMessageId:'message-1',eventId:'event-1',eventType:'email.bounced',providerStatus:'bounced',receivedAt:new Date().toISOString()};
  for(const result of [{error:{message:'unavailable'}},{data:false,error:null}])await assert.rejects(()=>recordDeliveryFromWebhook({rpc:async()=>result},input),/webhook_reconciliation_pending/);
  await recordDeliveryFromWebhook({rpc:async()=>({data:true,error:null})},input);
});
test('verified webhook normalization preserves exact source tags and rejects invalid source metadata',()=>{
  const normalize=tags=>normalizeResendWebhook({type:'email.sent',data:{email_id:'message',tags}},new Headers({'svix-id':'signed-event'}));
  assert.equal(normalize({voom_delivery:A,voom_kind:'campaign'}).sourceId,A);
  assert.equal(normalize({voom_delivery:A,voom_kind:'flow'}).sourceKind,'flow');
  assert.equal(normalize({voom_delivery:'invalid',voom_kind:'campaign'}).sourceId,undefined);
  assert.equal(normalize({voom_delivery:A,voom_kind:'another-type'}).sourceId,undefined);
});
test('domain route is authenticated, origin-checked, server-scoped and rate-limit failures block; unsafe Preview is opted out',async()=>{
  const route=await readFile(new URL('../app/api/voom/email-domains/route.ts',import.meta.url),'utf8');
  assert.match(route,/getCurrentUser/);assert.match(route,/request.headers.get\("origin"\)/);assert.match(route,/limited.error \|\| limited.data !== true/);assert.match(route,/user.id, domain/);
  const config=JSON.parse(await readFile(new URL('../vercel.json',import.meta.url),'utf8'));assert.equal(config.git.deploymentEnabled['codex/email-commercial-safety'],false);
});
test('owner DNS proof enables provider DNS instructions/verification without sending email',async()=>{
  const db={...registry(),rpc:async(name,args)=>{assert.equal(name,'bind_marketing_email_domain');assert.equal(args.p_owner,A);return {error:null};}};
  const requests=[];const client={async request(method,path){requests.push({method,path});return Response.json(path.endsWith('/verify')?{object:'domain',id:claim.provider_domain_id}:{id:claim.provider_domain_id,name:claim.domain,status:'pending',records:[{type:'TXT',name:'resend._domainkey',value:'synthetic-dkim'}]});}};
  const result=await verifyDomainClaim(db,A,claim.domain,{client,txt});assert.equal(result.verified,false);assert.equal(result.records.length,1);
  assert(requests.some(r=>r.method==='POST'&&r.path.endsWith('/verify')));assert(!requests.some(r=>r.path==='emails'));
});
test('provider throttle waits only within a bounded budget and fails closed on storage failure',async()=>{
  const {waitForEmailProviderSlot}=await import('../lib/email/provider-throttle.ts');let calls=0;const waits=[];
  await waitForEmailProviderSlot({rpc:async()=>({data:++calls===1?500:0,error:null})},async ms=>{waits.push(ms);});assert.deepEqual(waits,[500]);assert.equal(calls,2);
  await assert.rejects(()=>waitForEmailProviderSlot({rpc:async()=>({error:{message:'down'}})},async()=>{}),/email_provider_throttled/);
  let exhausted=0;await assert.rejects(()=>waitForEmailProviderSlot({rpc:async()=>{exhausted++;return {data:1000,error:null};}},async()=>{}),/email_provider_throttled/);assert.equal(exhausted,4);
});
