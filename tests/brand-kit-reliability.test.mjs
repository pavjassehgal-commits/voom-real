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
