import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {importApp} from './helpers/rendered-surface.mjs';
registerHooks({resolve(s,c,next){const code=s==='@/lib/voom/server-data'?'export async function getCurrentUser(){return globalThis.__pauseUiUser}':s==='@/utils/supabase/admin'?'export function createAdminClient(){return globalThis.__pauseUiAdmin}':null;return code?{url:'data:text/javascript,'+encodeURIComponent(code),shortCircuit:true}:next(s,c)}});
const pause=await importApp('app/api/automation/pause/route.ts'),resume=await importApp('app/api/automation/resume/route.ts');
const OWNER='aaaaaaaa-0000-4000-8000-000000000088';
function setup(snapshot,{user=true,fail=false}={}){
 const calls=[];globalThis.__pauseUiUser=user?{id:OWNER}:null;
 globalThis.__pauseUiAdmin={async rpc(name,args){calls.push({name,args});return fail?{error:{message:'synthetic'},data:null}:{error:null,data:name==='pause_all_automation'?{alreadyPaused:false,socialJobsStopped:{instagram:1,youtube:0,tiktok:0},lifecycleFlowsPaused:0}:{wasPaused:true,automationMode:'autopilot',plan:'max',notRestored:{cancelledAutopilotJobs:1,pausedLifecycleFlows:0}}}},from(table){const q={select(fields){calls.push({table,fields});return q},eq(field,value){calls.push({field,value});return q},async maybeSingle(){return{data:snapshot===undefined?null:{automation_paused_at:snapshot},error:null}}};return q}};return calls;
}
const request=kind=>new Request('https://test.invalid/api/automation/'+kind,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({idempotencyKey:'synthetic-pause-ui-test-key',...(kind==='resume'?{confirm:true}:{})})});
test('Pause and Resume responses include a fresh owner-scoped database snapshot, even if the operation acknowledgement differs',async()=>{
 for(const[kind,route,snapshot]of[['pause',pause,null],['resume',resume,'2026-11-26T06:00:00Z']]){
 const calls=setup(snapshot),response=await route.POST(request(kind));assert.equal(response.status,200);assert.deepEqual((await response.json()).pauseState,{pausedAt:snapshot});
 assert.equal(calls[0].args.p_owner_user_id,OWNER);assert.deepEqual(calls[1],{table:'businesses',fields:'automation_paused_at'});assert.deepEqual(calls[2],{field:'owner_user_id',value:OWNER});
 }
});
test('unreadable pause state is explicit; UI must not infer current state from paused/resumed acknowledgement',async()=>{
 setup(undefined);const r=await pause.POST(request('pause'));assert.equal(r.status,200);assert.equal((await r.json()).pauseState,null);
});
test('unauthenticated requests and failed RPCs do not produce a successful state snapshot',async()=>{
 let calls=setup(null,{user:false});assert.equal((await pause.POST(request('pause'))).status,401);assert.equal(calls.length,0);
 calls=setup(null,{fail:true});const r=await resume.POST(request('resume'));assert.equal(r.status,503);assert.equal((await r.json()).pauseState,undefined);assert.equal(calls.length,1);
});
