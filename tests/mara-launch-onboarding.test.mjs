import './helpers/server-only-shim.mjs';
import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { registerHooks } from 'node:module';
import { createSupabaseLite } from './helpers/pglite-supabase.mjs';
import { nativeVideoDb } from './helpers/native-video-db.mjs';

const OWNER='77777777-7777-4777-8777-777777777777';
registerHooks({resolve(s,c,next){
  const doubles={
    'next/cache':'export function revalidatePath(){}',
    '@/lib/voom/server-data':'export async function getCurrentUser(){return {id:"'+OWNER+'"}}',
    '@/utils/supabase/server':'export async function createClient(){return globalThis.__launchOnboarding}',
  };
  return doubles[s]?{shortCircuit:true,url:'data:text/javascript,'+encodeURIComponent(doubles[s])}:next(s,c);
}});
const {saveOnboarding}=await import('../lib/voom/mutations.ts');
let pg;
before(async()=>{({db:pg}=await createSupabaseLite());});
after(()=>pg?.close());
const input=overrides=>({displayName:'Alex',brandName:'Synthetic Coffee',brandDescription:'An independent café.',industry:'Restaurant / Café',targetCustomer:['Local residents'],mainGoal:'Awareness',brandPersonality:['Friendly'],preferredChannels:['Instagram','LinkedIn'],monthlyAdBudget:'Organic only',contentFrequency:'Daily',automationLevel:'MARA drafts, I approve',publishingPermission:'Yes — always ask first',website:'',...overrides});
async function fixture(t,{plan='pro',exists=true,mode='manual'}={}){
  await pg.exec('begin');
  await pg.query('insert into auth.users(id) values($1)',[OWNER]);
  if(exists)await pg.query("insert into businesses(owner_user_id,plan,automation_level,publishing_permission) values($1,$2,$3,'Existing consent')",[OWNER,plan,mode]);
  await pg.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${OWNER}',false);select set_config('request.jwt.claims','{"role":"authenticated","sub":"${OWNER}"}',false)`);
  globalThis.__launchOnboarding=nativeVideoDb(pg);
  globalThis.__launchOnboarding.auth={getClaims:async()=>({data:{claims:{sub:OWNER,email:'synthetic@example.invalid'}},error:null})};
  t.after(async()=>{delete globalThis.__launchOnboarding;await pg.exec('reset role;rollback');});
}
const business=async()=>(await pg.query('select * from businesses where owner_user_id=$1',[OWNER])).rows[0];

test('real onboarding action updates an existing Pro business under authenticated 0071 without INSERT/default-Free validation',async t=>{
  await fixture(t);const before=await business();
  assert.deepEqual(await saveOnboarding(input()),{ok:true},JSON.stringify(globalThis.__launchOnboarding.errors));
  const after=await business();assert.equal(after.id,before.id);assert.equal(after.plan,'pro');assert.equal(after.automation_level,'assisted');assert.equal(after.onboarding_completed,true);assert.equal(after.allow_automatic_paid_media,false);
  assert.equal((await pg.query('select count(*)::int n from businesses')).rows[0].n,1);
});
for(const exists of [false,true])test(`Free onboarding cannot escalate (${exists?'existing':'new'} business), and direct browser writes remain blocked`,async t=>{
  await fixture(t,{plan:'free',exists});
  assert.deepEqual(await saveOnboarding(input({automationLevel:'autopilot'})),{ok:true});
  const row=await business();assert.equal(row.plan,'free');assert(!['assisted','autopilot'].includes(row.automation_level));
  const db=globalThis.__launchOnboarding;
  for(const patch of [{automation_level:'assisted'},{automation_level:'autopilot'},{allow_automatic_paid_media:true},{plan:'max'}]){
    const result=await db.from('businesses').update(patch).eq('owner_user_id',OWNER).select('id').maybeSingle();assert(result.error,'browser escalation was accepted');
  }
});
test('skipped onboarding mode/consent preserves the existing values and all entitlement fields',async t=>{
  await fixture(t,{plan:'max',mode:'autopilot'});const before=await business();
  assert.equal((await saveOnboarding(input({automationLevel:'',publishingPermission:''}))).ok,true);
  const after=await business();for(const key of ['id','plan','automation_level','publishing_permission','allow_automatic_paid_media','automation_paused_at'])assert.deepEqual(after[key],before[key],key);
});
