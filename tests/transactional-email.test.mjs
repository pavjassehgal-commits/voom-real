import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {Webhook} from 'standardwebhooks';
const {transactionalConfig,recoveryProof,validRecoveryProof,emailDocument,processTransactionalEmail,handleTransactionalWebhook,hmac}=await import('../lib/transactional-email/core.ts');
import {requestAuthEmail,AUTH_EMAIL_MESSAGE} from '../lib/transactional-email/auth-requests.ts';
const secret='synthetic-auth-secret-not-real-'.repeat(2);
const config={key:'synthetic-resend-key',secret,site:'https://staging.example.test',from:'no-reply@example.test',webhook:'whsec_'+Buffer.from('synthetic-webhook-secret-not-real').toString('base64'),testRecipient:'owner@example.test'};
const job={id:'00000000-0000-4000-8000-000000000074',owner_user_id:'00000000-0000-4000-8000-000000000075',recipient:'owner@example.test',claim_token:'claim',payload:null};
function fake(options={}){const calls=[];return {calls,async rpc(name,args){calls.push({name,args});if(name==='claim_voom_transactional_email')return {data:[{...job,recipient:options.recipient||job.recipient}],error:null};if(name==='prepare_voom_transactional_email')return {data:args.p_payload,error:options.failPrepare?{}:null};return {data:null,error:options.failFinish?{}:null};}};}
test('OFF by default, dedicated credentials only, fixed Production identity and Preview recipient restriction',()=>{
  assert.equal(transactionalConfig({EMAIL_PROVIDER_API_KEY:'marketing'}),null);
  assert.throws(()=>transactionalConfig({VOOM_TRANSACTIONAL_EMAIL_ENABLED:'true',EMAIL_PROVIDER_API_KEY:'marketing'}));
  const env={VOOM_TRANSACTIONAL_EMAIL_ENABLED:'true',VOOM_TRANSACTIONAL_RESEND_API_KEY:'own',VOOM_AUTH_EMAIL_SECRET:secret,NEXT_PUBLIC_SITE_URL:'https://voom.today',VERCEL_ENV:'production',NODE_ENV:'production'};
  assert.equal(transactionalConfig(env).from,'no-reply@voom.today');
  assert.throws(()=>transactionalConfig({...env,VOOM_TRANSACTIONAL_FROM_ADDRESS:'other@example.test'}));
  assert.throws(()=>transactionalConfig({...env,VERCEL_ENV:'preview'}));
  assert.equal(transactionalConfig({...env,VERCEL_ENV:'preview',NEXT_PUBLIC_SITE_URL:config.site,VOOM_TRANSACTIONAL_TEST_RECIPIENT:job.recipient}).testRecipient,job.recipient);
});
test('recovery proof is owner/session-bound, short-lived and tamper resistant',()=>{
  const now=1000000,proof=recoveryProof('owner','session',secret,now);
  assert.equal(validRecoveryProof(proof,'owner','session',secret,now+1),true);
  for(const [owner,session,key,time,p] of [['other','session',secret,now,proof],['owner','other',secret,now,proof],['owner','session','short',now,proof],['owner','session',secret,now+600000,proof],['owner','session',secret,now,proof+'x'],['owner','session',secret,now,undefined]])assert.equal(validRecoveryProof(p,owner,session,key,time),false);
});
test('reset and resend never disclose account existence, provider failures or throttle outcome',async()=>{
  for(const allowed of [true,false])for(const result of ['known','unknown','error']){let sends=0;assert.deepEqual(await requestAuthEmail(async()=>allowed,async()=>{sends++;if(result==='error')throw Error('private');return result;}),{success:true,message:AUTH_EMAIL_MESSAGE});assert.equal(sends,allowed?1:0);}
  let sends=0;assert.deepEqual(await requestAuthEmail(async()=>{throw Error('db');},async()=>sends++),{success:true,message:AUTH_EMAIL_MESSAGE});assert.equal(sends,0);
});
test('mobile email document escapes supplied text and uses the official mark',()=>{
  const html=emailDocument('<script>x</script>','" & message','Go','https://example.test/?a=1&b=2',config.site);
  assert.doesNotMatch(html,/<script>/);for(const pattern of [/&lt;script&gt;/,/max-width:560px/,/name="viewport"/,/role="presentation"/,/e73c1c43/])assert.match(html,pattern);
});
test('accepted email uses only dedicated key, one provider call and stable idempotency key',async()=>{
  const db=fake(),requests=[];assert.deepEqual(await processTransactionalEmail(db,config,async(url,init)=>{requests.push({url,init});return Response.json({id:'msg_test'});}),{status:'accepted'});
  assert.equal(requests.length,1);assert.equal(requests[0].url.toString(),'https://api.resend.com/emails');assert.equal(requests[0].init.headers.get('Authorization'),'Bearer '+config.key);
  assert.equal(requests[0].init.headers.get('Idempotency-Key'),'voom-welcome/'+job.id);assert.equal(db.calls[1].name,'prepare_voom_transactional_email');assert.equal(db.calls.at(-1).args.p_status,'accepted');
});
for(const [label,response,status] of [['429',()=>new Response('{}',{status:429}),'retryable'],['503',()=>new Response('{}',{status:503}),'uncertain'],['missing id',()=>Response.json({}),'uncertain'],['401',()=>new Response('{}',{status:401}),'failed'],['lost response',()=>{throw Error('timeout');},'uncertain']])test(`provider ${label}: no blind second submission`,async()=>{let count=0;const db=fake();assert.equal((await processTransactionalEmail(db,config,async()=>{count++;return response();})).status,status);assert.equal(count,1);assert.equal(db.calls.at(-1).args.p_status,status);});
test('payload persistence failure or non-approved staging recipient prevents provider calls',async()=>{
  for(const options of [{failPrepare:true},{recipient:'other@example.test'}]){let count=0;assert.notEqual((await processTransactionalEmail(fake(options),config,async()=>{count++;return Response.json({id:'test'});})).status,'accepted');assert.equal(count,0);}
});
test('failed result persistence remains uncertain after exactly one accepted provider call',async()=>{let count=0;assert.equal((await processTransactionalEmail(fake({failFinish:true}),config,async()=>{count++;return Response.json({id:'test'});})).status,'uncertain');assert.equal(count,1);});
function signed(data){const payload=JSON.stringify({type:'email.delivered',data}),id='test_event',timestamp=new Date();return new Request('https://example.test',{method:'POST',body:payload,headers:{'svix-id':id,'svix-timestamp':String(Math.floor(timestamp.getTime()/1000)),'svix-signature':new Webhook(config.webhook).sign(id,timestamp,payload)}});}
test('signed receipts are environment-bound; forgeries never reach DB and storage failures return 503',async()=>{
  const db=fake();assert.equal((await handleTransactionalWebhook(new Request('https://example.test',{method:'POST',body:'{}'}),db,config)).status,403);assert.equal(db.calls.length,0);
  const data={email_id:'msg_test',tags:{voom_tx_id:job.id,voom_tx_proof:hmac(secret,'delivery',job.id+'|'+config.site)}};
  assert.equal((await handleTransactionalWebhook(signed(data),db,config)).status,200);assert.equal(db.calls.length,1);
  const untouched=fake();assert.equal((await handleTransactionalWebhook(signed(data),untouched,{...config,site:'https://other.test'})).status,200);assert.equal(untouched.calls.length,0);
  assert.equal((await handleTransactionalWebhook(signed(data),{async rpc(){return {error:{}};}},config)).status,503);
});
test('real auth routes verify ownership; recovery GET consumes no token; no schedule or automatic Preview',async()=>{
  const read=p=>readFile(new URL('../'+p,import.meta.url),'utf8'),actions=await read('app/forgot-password/actions.ts');
  assert.match(actions,/auth\.getUser\(\)/);assert.match(actions,/validRecoveryProof/);assert.match(actions,/auth\.updateUser\(\{\s*password\s*\}\)/);assert.doesNotMatch(actions,/auth\.admin|generateLink/);
  assert.doesNotMatch(await read('app/auth/recovery/page.tsx'),/exchangeCodeForSession|verifyOtp/);
  assert.match(await read('app/api/cron/transactional-email/route.ts'),/bearerMatches/);
  const vercel=JSON.parse(await read('vercel.json'));assert.equal(vercel.git.deploymentEnabled['codex/transactional-customer-email'],false);assert.equal(vercel.crons.some(c=>c.path.includes('transactional')),false);
});
