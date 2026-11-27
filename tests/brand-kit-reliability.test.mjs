import './helpers/server-only-shim.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {createSupabaseLite} from './helpers/pglite-supabase.mjs';
import {nativeVideoDb} from './helpers/native-video-db.mjs';
registerHooks({resolve(s,c,next){
 const code=s==='next/cache'?'export function revalidatePath(){}':s==='@/utils/supabase/server'?'export async function createClient(){return globalThis.__brandDb}':s==='@/utils/supabase/admin'?'export function createAdminClient(){if(globalThis.__brandAdmin)return globalThis.__brandAdmin;throw Error("test_admin_disabled")}':s==='@/lib/rate-limit'?'export async function consumeAiRateLimit(){return true};export function rateLimitedResponse(){return Response.json({}, {status:429})}':s==='@/lib/voom/server-data'||s==='./server-data'&&c.parentURL.endsWith('/lib/voom/mutations.ts')?'export async function getCurrentUser(){return globalThis.__brandUser}':null;
 return code?{url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true}:next(s,c);
}});
// This entire file is offline, including imports and tests without local counters.
globalThis.fetch = async () => { throw new Error('External HTTP forbidden in Brand Kit reliability tests'); };
const {saveOnboarding}=await import('../lib/voom/mutations.ts');
const {appendBrandKitVersion}=await import('../lib/brand/versions.ts');
const {loadBrandKit,BrandKitReadError,EMPTY_BRAND_KIT,brandKitFailureResponse}=await import('../lib/brand/context.ts');
const {loadPostBrandContext}=await import('../lib/post/server-data.ts');
const {runOwnerWorkflow}=await import('../lib/voom/workflow/service.ts');
let db,base;
test.before(async()=>{({db}=await createSupabaseLite());base=nativeVideoDb(db,{standalone:true})});
test.after(async()=>{await db?.close()});
async function owner(){delete globalThis.__brandAdmin;const id=(await db.query('insert into auth.users(id) values(gen_random_uuid()) returning id')).rows[0].id;globalThis.__brandUser={id};return id}
const input=()=>({displayName:'Tester',brandName:'Reliable brand',brandDescription:'Synthetic local business',industry:'Retail',targetCustomer:['Local residents'],mainGoal:'Awareness',brandPersonality:['Friendly'],preferredChannels:['Instagram'],monthlyAdBudget:'',contentFrequency:'2-3x_week',automationLevel:'manual',publishingPermission:'',kit:{offerings:['Coffee'],rules:['Never promise cures'],words:['guaranteed'],notes:'Owner confirmed',facts:['Opened in 2020'],brief:'Confirmed brief'}});
function client({fail,afterRead,ambiguous=false}={}){
 const calls=[];return Object.assign(Object.create(base),{calls,from(table){let op='read',patch;const q=base.from(table);let proxy;proxy=new Proxy(q,{get(target,key){if(key==='then')return async(resolve,reject)=>{try{
 const call={table,op,patch};calls.push(call);const fault=fail?.(call);if(fault&&!ambiguous){resolve({data:null,error:{message:'Synthetic failure',code:'XX000'}});return}
 const result=await target;if(table==='brand_kits'&&op==='read')await afterRead?.(result);
 resolve(fault?{data:null,error:{message:'Uncertain response',code:'XX000'}}:result);
 }catch(e){reject(e)}};
 const value=target[key];return typeof value==='function'?(...args)=>{if(['insert','update','upsert'].includes(key)){op=key;patch=args[0]}value.apply(target,args);return proxy}:value;}});return proxy}});
}
async function state(id){return(await db.query('select * from public.businesses where owner_user_id=$1',[id])).rows[0]}
async function kits(id){return(await db.query('select * from public.brand_kits where owner_user_id=$1 order by version',[id])).rows}
const use=c=>(globalThis.__brandDb=c,c);
test('onboarding succeeds only with persisted kit and completion; the same retry adds no duplicate version',async()=>{
 const id=await owner(),c=use(client());assert.equal((await saveOnboarding(input())).ok,true);assert.equal((await state(id)).onboarding_completed,true);
 assert.equal((await kits(id)).length,1);assert.deepEqual((await kits(id))[0].answers.avoid,{rules:['Never promise cures'],words:['guaranteed']});
 assert.equal((await saveOnboarding(input())).ok,true);assert.equal((await kits(id)).length,1);
 const mutations=c.calls.filter(x=>x.op!=='read');assert(mutations.findIndex(x=>x.table==='brand_kits')<mutations.findIndex(x=>x.patch.onboarding_completed===true));
});
test('partial kit failure keeps basic information and incomplete setup; retry saves restrictions once',async()=>{
 const id=await owner();let once=true;use(client({fail:x=>x.table==='brand_kits'&&x.op==='insert'&&once?(once=false,true):false}));
 const result=await saveOnboarding(input());assert.equal(result.ok,false);assert.match(result.error,/basic business details were saved.*Brand Kit.*retry/);
 assert.equal((await state(id)).brand_name,'Reliable brand');assert.equal((await state(id)).onboarding_completed,false);assert.equal((await kits(id)).length,0);
 assert.equal((await saveOnboarding(input())).ok,true);assert.equal((await state(id)).onboarding_completed,true);assert.equal((await kits(id)).length,1);
});
test('completion failure and an ambiguous committed kit write retry without duplicating the saved version',async()=>{
 for(const ambiguous of [false,true]){
  const id=await owner();let once=true;use(client({ambiguous,fail:x=>once&&(ambiguous?x.table==='brand_kits'&&x.op==='insert':x.table==='businesses'&&x.op==='update'&&x.patch.onboarding_completed===true)?(once=false,true):false}));
  assert.equal((await saveOnboarding(input())).ok,false);assert.equal((await state(id)).onboarding_completed,false);assert.equal((await kits(id)).length,1);
  assert.equal((await saveOnboarding(input())).ok,true);assert.equal((await state(id)).onboarding_completed,true);assert.equal((await kits(id)).length,1);
 }
});
test('failed newest-kit reads never append a replacement or erase confirmed information; existing completion is preserved',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);const before=await kits(id);
 use(client({fail:x=>x.table==='brand_kits'&&x.op==='read'}));const result=await saveOnboarding(input());assert.equal(result.ok,false);assert.equal((await state(id)).onboarding_completed,true);assert.deepEqual(await kits(id),before);
});
test('concurrent append collisions preserve both sections and owner isolation without losing restrictions',async()=>{
 const id=await owner(),other=await owner();await appendBrandKitVersion(base,id,{source:'brand_hub',answers:{avoid:{rules:['No cures'],words:['guaranteed']}}});
 let reads=0,release;const barrier=new Promise(r=>release=r);
 const concurrent=client({afterRead:async()=>{if(++reads<=2){if(reads===2)release();await barrier}}});
 const results=await Promise.all([appendBrandKitVersion(concurrent,id,{source:'brand_hub',answers:{notes:'New note'}}),appendBrandKitVersion(concurrent,id,{source:'brand_hub',answers:{facts_confirmed:['Confirmed fact']}})]);
 assert(results.every(Boolean));const rows=await kits(id);assert.equal(rows.length,3);assert.equal(rows.at(-1).answers.notes,'New note');assert.deepEqual(rows.at(-1).answers.facts_confirmed,['Confirmed fact']);assert.deepEqual(rows.at(-1).answers.avoid,{rules:['No cures'],words:['guaranteed']});assert.equal((await kits(other)).length,0);
});
test('a valid missing kit stays supported while SQL errors and transport errors are retryable unavailable states',async()=>{
 const id=await owner();assert.deepEqual(await loadBrandKit(base,id),EMPTY_BRAND_KIT);
 const unavailable=client({fail:x=>x.table==='brand_kits'&&x.op==='read'});await assert.rejects(loadBrandKit(unavailable,id),BrandKitReadError);
 await assert.rejects(loadBrandKit({from(){throw Error('Network unavailable')}},id),BrandKitReadError);
 const response=brandKitFailureResponse(new BrandKitReadError());assert.equal(response.status,503);assert.equal((await response.json()).retryable,true);
});
test('Post Studio and rolling workflow stop before providers or workflow writes if saved restrictions cannot load',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);
 const c=client({fail:x=>x.table==='brand_kits'&&x.op==='read'});let networkCalls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{networkCalls++;throw Error('External requests prohibited')};
 try{await assert.rejects(loadPostBrandContext(c,id),BrandKitReadError);await assert.rejects(runOwnerWorkflow(c,{ownerId:id,trigger:'replenish'}),BrandKitReadError);}finally{globalThis.fetch=original}
 assert.equal(networkCalls,0);assert(c.calls.every(x=>x.op==='read'));
 const other=await owner();const own=await loadBrandKit(base,id);assert.deepEqual(own.avoidRules,['Never promise cures']);assert.deepEqual(own.bannedWords,['guaranteed']);assert.deepEqual(await loadBrandKit(base,other),EMPTY_BRAND_KIT);
});

test('concurrent identical onboarding append attempts share one version despite JSONB object key ordering',async()=>{
 const id=await owner();let reads=0,release;const barrier=new Promise(r=>release=r);
 const c=client({afterRead:async()=>{if(++reads<=2){if(reads===2)release();await barrier}}});
 const payload={source:'onboarding',skipUnchanged:true,answers:{avoid:{words:['banned'],rules:['mandatory']},notes:'Same'},brief:'Same brief'};
 const results=await Promise.all([appendBrandKitVersion(c,id,payload),appendBrandKitVersion(c,id,payload)]);
 assert(results.every(r=>r?.version===1));assert.equal((await kits(id)).length,1);
});
test('actual Post image, caption and Marketing Plan routes return retryable 503 without generation calls on kit read failure',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);
 const conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[id])).rows[0].id;
 const draft=(await db.query("insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content) values($1,$2,'instagram_post','instagram','Test','Test') returning id",[id,conv])).rows[0].id;
 await db.query("insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size) values($1,$2,$3,'test.png','image/png',10)",[id,draft,`${id}/test.png`]);
 const c=client({fail:x=>x.table==='brand_kits'&&x.op==='read'});globalThis.__brandAdmin=c;
 let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('No provider requests permitted')};
 try{
  for(const path of ['generate','suggest']){
   const route=await import(`../app/api/posts/[id]/${path}/route.ts`);
   const response=await route.POST(new Request('https://test.invalid',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}),{params:Promise.resolve({id:draft})});
   assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,'brand_kit_unavailable');assert.equal(body.retryable,true);assert.match(body.error,/Brand Kit.*retry/);
  }
  const plan=await import('../app/api/plan/route.ts');const response=await plan.POST(new Request('https://test.invalid',{method:'POST',body:'{}',headers:{'Content-Type':'application/json'}}));assert.equal(response.status,503);assert.equal((await response.json()).code,'brand_kit_unavailable');
 }finally{globalThis.fetch=original;delete globalThis.__brandAdmin}
 assert.equal(calls,0);assert(c.calls.every(x=>x.op==='read'));assert.equal((await db.query('select count(*)::int n from public.mara_media_generations where owner_user_id=$1',[id])).rows[0].n,0);
});

test('shared Reel/Story/native video service refuses a kit read failure before provider submission or credits',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);
 const c=client({fail:x=>x.table==='brand_kits'&&x.op==='read'});
 const saved={VIDEO_PROVIDER:process.env.VIDEO_PROVIDER,OPENROUTER_API_KEY:process.env.OPENROUTER_API_KEY};
 const original=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('No provider requests permitted')};
 process.env.VIDEO_PROVIDER='openrouter';process.env.OPENROUTER_API_KEY='synthetic-test-key-no-network';
 try{
  const {buildVideoService,startPostStudioVideo}=await import('../lib/mara/video-service.ts');
  await assert.rejects(buildVideoService(c,id),BrandKitReadError);
  // An unavailable provider must not mask the failed brand read and enable fallback.
  process.env.VIDEO_PROVIDER='unconfigured-test-provider';
  await assert.rejects(buildVideoService(c,id),BrandKitReadError);
  assert.equal(await buildVideoService(base,id),null,'successful context reads retain unconfigured-provider fallback');
  process.env.VIDEO_PROVIDER='openrouter';
  const result=await startPostStudioVideo({admin:c,ownerId:id,post:{id:'aaaaaaaa-0000-4000-8000-000000000089',kind:'reel',conversationId:'synthetic',concept:'Synthetic'},brief:'Synthetic',idempotencyToken:'synthetic'});
  assert.equal(result.status,503);assert.match(result.error,/Brand Kit.*retry/);assert.equal(calls,0);assert(c.calls.every(x=>x.op==='read'));
 }finally{globalThis.fetch=original;for(const[k,v]of Object.entries(saved)){if(v===undefined)delete process.env[k];else process.env[k]=v}}
});

const {loadNewestBrandAssets,removeUnreferencedBrandAssets,removeBrandAssetObjects}=await import('../lib/brand/asset-storage.ts');
const {loadBrandContext,BusinessContextReadError}=await import('../lib/brand/context.ts');
const {loadBrandKitHistory}=await import('../lib/brand/read.ts');
function image(id,kind,n){return {id:`00000000-0000-4000-8000-${String(n).padStart(12,'0')}`,kind,path:`${id}/${kind}/00000000-0000-4000-8000-${String(n).padStart(12,'0')}.png`,mimeType:'image/png',byteSize:10,description:'Synthetic',chips:[],look:'',describedBy:''}}
function storageFence(c,objects=new Map()){
 const calls=[];c.storage={from(){return {remove:async paths=>{calls.push(paths);for(const p of paths)objects.delete(p);return {error:null}},list:async()=>{throw Error('Sweeping uncommitted uploads is forbidden')}}}};
 return {calls,objects};
}
test('review P1 exact sequence: initial asset read fails, later reads/save succeed without uploads, all saved references survive',async()=>{
 const id=await owner(),logo=image(id,'logo',1),product=image(id,'product',2);use(client());assert.equal((await saveOnboarding({...input(),kit:{...input().kit,assets:[logo,product]}})).ok,true);
 let first=true;const c=use(client({fail:x=>x.table==='brand_kits'&&x.op==='read'&&first?(first=false,true):false}));
 const storage=storageFence(c,new Map([[logo.path,true],[product.path,true]]));globalThis.__brandAdmin=c;
 // This is the old optional pre-read: it must now be unavailable, never [].
 await assert.rejects(loadNewestBrandAssets(c,id),BrandKitReadError);
 assert.deepEqual(await loadNewestBrandAssets(c,id),[logo,product]);
 assert.equal((await saveOnboarding(input())).ok,true);assert.deepEqual((await kits(id)).at(-1).assets,[logo,product]);
 assert.deepEqual(storage.calls,[]);assert.equal(storage.objects.size,2);
 const version=(await kits(id)).at(-1).version;await removeUnreferencedBrandAssets(c,id,version);assert.deepEqual(storage.calls,[]);
});
test('cleanup retains historical versions, in-flight uploads and other owners across concurrent saves and retries',async()=>{
 const id=await owner(),other=await owner(),old=image(id,'logo',11),next=image(id,'logo',12),inFlight=image(id,'product',13),foreign=image(other,'logo',14);
 const c=client();const storage=storageFence(c,new Map([old,next,inFlight,foreign].map(a=>[a.path,true])));
 const a=await appendBrandKitVersion(c,id,{source:'brand_hub',answers:{},assets:[old]});
 await Promise.all([removeUnreferencedBrandAssets(c,id,a.version),appendBrandKitVersion(c,id,{source:'brand_hub',answers:{},assets:[next]})]);
 await removeBrandAssetObjects(c,id,[old.path,inFlight.path,foreign.path]);
 await removeUnreferencedBrandAssets(client({fail:x=>x.table==='brand_kits'}),id,999);
 assert.equal(storage.objects.size,4);assert.deepEqual(storage.calls,[]);assert.equal((await kits(id)).length,2);assert.deepEqual((await kits(other)),[]);
});
test('business and profile read failures are unavailable, not missing business; successful missing business stays null',async()=>{
 const id=await owner();assert.equal(await loadBrandContext(base,id),null);
 for(const table of ['businesses','profiles'])await assert.rejects(loadBrandContext(client({fail:x=>x.table===table}),id),BusinessContextReadError);
 await assert.rejects(loadBrandContext({from(){throw Error('Transport failed')}},id),BusinessContextReadError);
 const response=brandKitFailureResponse(new BusinessContextReadError());assert.equal(response.status,503);assert.equal((await response.json()).code,'business_context_unavailable');
});
async function reelFixture(id){
 const conv=(await db.query('insert into public.mara_conversations(owner_user_id) values($1) returning id',[id])).rows[0].id;
 const draft=(await db.query("insert into public.mara_drafts(owner_user_id,conversation_id,kind,channel,title,content) values($1,$2,'reel','instagram','Synthetic educational tips','Synthetic caption') returning id",[id,conv])).rows[0].id;
 const action=(await db.query("insert into public.mara_pending_actions(owner_user_id,conversation_id,tool_name,summary,new_value,status,idempotency_key) values($1,$2,'choose_reel_production','Synthetic', $3,'pending',gen_random_uuid()::text) returning id",[id,conv,JSON.stringify({draftId:draft,concept:'Educational tips',script:'Simple educational tips'})])).rows[0].id;
 return {draft,action};
}
test('Reel POST blocks business failures, kit failures and saved restrictions before fallback AI, card writes or credits',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);const {action}=await reelFixture(id);
 const saved=process.env.VIDEO_PROVIDER;process.env.VIDEO_PROVIDER='unconfigured-test-provider';
 try{
  const route=await import('../app/api/reels/produce/[actionId]/route.ts');
  for(const [table,code]of [['businesses','business_context_unavailable'],['brand_kits','brand_kit_unavailable'],[null,'brand_restrictions_unavailable']]){
   const c=client({fail:x=>x.table===table&&x.op==='read'});globalThis.__brandAdmin=c;const response=await route.POST(new Request('https://test.invalid',{method:'POST',body:'{}'}),{params:Promise.resolve({actionId:action})});
   assert.equal(response.status,503);const body=await response.json();assert.equal(body.code,code);assert.equal(body.retryable,true);assert(c.calls.every(x=>x.op==='read'));
  }
  const row=(await kits(id)).at(-1);assert.deepEqual(row.answers.avoid,{rules:['Never promise cures'],words:['guaranteed']});
 }finally{if(saved===undefined)delete process.env.VIDEO_PROVIDER;else process.env.VIDEO_PROVIDER=saved}
});
test('Post image and caption return retryable business-context 503, not profile-incomplete 409',async()=>{
 const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);const {draft}=await reelFixture(id);
 await db.query("update public.mara_drafts set kind='instagram_post' where id=$1",[draft]);
 await db.query("insert into public.post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size) values($1,$2,$3,'test.png','image/png',10)",[id,draft,`${id}/test.png`]);
 for(const path of ['generate','suggest']){
  const c=client({fail:x=>x.table==='businesses'&&x.op==='read'});globalThis.__brandAdmin=c;const route=await import(`../app/api/posts/[id]/${path}/route.ts`);
  const response=await route.POST(new Request('https://test.invalid',{method:'POST',body:'{}'}),{params:Promise.resolve({id:draft})});assert.equal(response.status,503);assert.equal((await response.json()).code,'business_context_unavailable');assert(c.calls.every(x=>x.op==='read'));
 }
});
test('history distinguishes legitimate empty history from read errors and does not leak another owner',async()=>{
 const id=await owner(),other=await owner();assert.deepEqual(await loadBrandKitHistory(base,id),[]);
 await appendBrandKitVersion(base,id,{source:'brand_hub',answers:{notes:'Synthetic private note'}});assert.equal((await loadBrandKitHistory(base,id)).length,1);assert.deepEqual(await loadBrandKitHistory(base,other),[]);
 await assert.rejects(loadBrandKitHistory(client({fail:x=>x.table==='brand_kits'}),id),BrandKitReadError);
});

test('Post/Reel/native polling honors local hard timeout during context outage; live jobs remain retryable and untouched',async()=>{
 for(const surface of ['post','reel','tiktok','youtube'])for(const expired of [false,true]){
  const id=await owner();use(client());assert.equal((await saveOnboarding(input())).ok,true);const {draft,action}=await reelFixture(id);
  const conv=(await db.query('select conversation_id from public.mara_drafts where id=$1',[draft])).rows[0].conversation_id;
  if(surface==='tiktok'||surface==='youtube'){
   const plan=(await db.query("insert into public.marketing_plans(owner_user_id,business_id,business_goal,weekly_strategy,selected_channels,content_frequency,valid_from,valid_until) values($1,$2,'Awareness','Synthetic',array['tiktok','youtube'],7,'2099-01-01','2099-01-07') returning id",[id,(await state(id)).id])).rows[0].id;
   const kind=surface==='tiktok'?'tiktok_video':'youtube_short';
   await db.query('update public.mara_drafts set kind=$1,channel=$2,source_plan_id=$3,source_plan_item_key=$4,social_channel=$2,social_format=$5 where id=$6',[kind,surface,plan,`2099-01-01|${kind}`,surface==='tiktok'?'video':'short',draft]);
  }
  const created=new Date(Date.now()-(expired?120:1)*60000).toISOString();
  const gen=(await db.query("insert into public.mara_media_generations(owner_user_id,conversation_id,draft_id,media_type,prompt,aspect_ratio,status,provider_job_id,idempotency_key,created_at) values($1,$2,$3,'video','Synthetic','9:16','generating','synthetic-existing-provider-job',gen_random_uuid()::text,$4) returning id",[id,conv,draft,created])).rows[0].id;
  await db.query("update public.mara_pending_actions set new_value=new_value || $1::jsonb where id=$2",[JSON.stringify({generationId:gen,productionStatus:'video_generating'}),action]);
  const c=client({fail:x=>x.table===(surface==='reel'?'businesses':'brand_kits')&&x.op==='read'});globalThis.__brandAdmin=c;c.rpc=async()=>{throw Error('No credit reservation allowed while polling')};
  const route=surface==='post'?await import('../app/api/posts/[id]/generation/route.ts'):surface==='reel'?await import('../app/api/reels/produce/[actionId]/route.ts'):await import('../app/api/social-drafts/[id]/generation/route.ts');
  const response=await route.GET(new Request('https://test.invalid'),{params:Promise.resolve(surface==='reel'?{actionId:action}:{id:draft})});
  assert.equal(response.status,expired?200:503,`${surface}, expired=${expired}`);
  const row=(await db.query('select * from public.mara_media_generations where id=$1',[gen])).rows[0];assert.equal(row.status,expired?'failed':'generating');assert.equal(row.provider_job_id,'synthetic-existing-provider-job');
  if(expired){assert.equal(row.error_code,'provider_timeout');assert(c.calls.filter(x=>x.op!=='read').every(x=>['mara_media_generations','mara_pending_actions'].includes(x.table)));}
  else {
   assert.equal((await response.json()).retryable,true);assert(c.calls.every(x=>x.op==='read'));
   if(surface==='reel'){
    const {produceWorkflowMedia}=await import('../lib/voom/workflow/media.ts');
    for(const reason of [new BrandKitReadError(),new BusinessContextReadError()]){
     const outcome=await produceWorkflowMedia(c,{ownerId:id,draftId:draft,conversationId:conv,contentType:'reel',concept:'Synthetic',visualBrief:''},{explicit:true,now:new Date(Date.now()+16*60000),deps:{advance:async()=>{throw reason}}});
     assert.deepEqual(outcome,{ok:false,code:reason.code});
    }
    assert(c.calls.every(x=>x.op==='read'));
   }
  }
 }
});
