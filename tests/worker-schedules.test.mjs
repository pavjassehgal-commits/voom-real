import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
import {readWorkerSchedule,renderWorkerCommand,validateInventory} from '../supabase/ops/validate-worker-schedules.mjs';

const root=new URL('../',import.meta.url);
const read=p=>readFileSync(new URL(p,root),'utf8');
const sql=read('supabase/ops/schedule-workers.sql'),config=readWorkerSchedule(sql);
// Non-sensitive projection of saved Production evidence (30 October): jobs 1–9
// in youtube-performance-timeout-prepared.json, with its verified job-7 correction.
// Renewal row 10 below is SYNTHETIC: user confirmed its direct-POST repair; exact
// current command/host/timeout were not captured here. No live queries are run.
const verified=[
  ['voom-instagram-publish-5m','*/5 * * * *','instagram-publish',null],
  ['voom-media-generation-2m','*/2 * * * *','media-generation',null],
  ['voom-instagram-performance-sync','0 */6 * * *','instagram-performance',null],
  ['voom-email-flows-15m','*/15 * * * *','email-flows',310000],
  ['voom-youtube-publish-5m','*/5 * * * *','youtube-publish',null],
  ['voom-youtube-reconcile-5m','*/5 * * * *','youtube-reconcile',null],
  ['voom-youtube-performance-hourly','0 * * * *','youtube-performance',310000],
  ['voom-tiktok-publish-5m','*/5 * * * *','tiktok-publish',null],
  ['voom-tiktok-reconcile-5m','*/5 * * * *','tiktok-reconcile',null],
];
const observedCommand=(path,timeout,base='https://voom-real.vercel.app')=>`select net.http_post(
 url := '${base}/api/cron/${path}',
 headers := jsonb_build_object('Authorization', 'Bearer ' ||
 (select decrypted_secret from vault.decrypted_secrets where name = 'voom_instagram_cron_secret')),
 body := '{}'::jsonb${timeout===null?'':', timeout_milliseconds := '+timeout}
);`;
function inventory(){return {database:'postgres',username:'postgres',jobs:[
  ...verified.map(([jobname,schedule,path,timeout],i)=>({jobid:i+1,jobname,schedule,command:observedCommand(path,timeout),active:true,database:'postgres',username:'postgres'})),
  {jobid:10,jobname:'voom-instagram-token-refresh-6h',schedule:'41 */6 * * *',command:observedCommand('instagram-token-refresh',310000,'https://voom.today'),active:true,database:'postgres',username:'postgres'},
]};}

test('manifest matches saved Production names, endpoints, cadences and corrected timeouts',()=>{
  assert.equal(config.workers.length,10);
  assert.deepEqual(config.workers.slice(0,9).map(w=>[w.name,w.schedule,w.path.split('/').at(-1),w.timeout]),verified);
  assert.ok(config.workers.slice(0,9).every(w=>!w.preserveTimeout));
  const renewal=config.workers[9];assert.equal(renewal.schedule,'41 */6 * * *');assert.equal(renewal.timeout,290000);assert.equal(renewal.preserveTimeout,true);
});
test('rendered commands use only direct POST/Vault, and every worker supports POST',()=>{
  for(const w of config.workers){
    const command=renderWorkerCommand(config,w),match=config.shape.exec(command);
    assert.ok(match,w.name);assert.equal(match[1],w.base+w.path);assert.equal(match[2]??null,w.timeout===null?null:String(w.timeout));
    assert.match(command,/'Bearer '\s*\|\|/);assert.doesNotMatch(command,/call_worker|http_get/);
    const route=read('app'+w.path+'/route.ts');assert.match(route,/export const POST = GET/);
  }
});
test('no missing custom helper, schema or broad security-definer helper is installed',()=>{
  assert.doesNotMatch(sql,/voom_ops\.call_worker\s*\(|create\s+(?:or replace\s+)?function|create\s+schema|create\s+extension|security definer|grant all/i);
  for(const dependency of ['cron.job','vault.decrypted_secrets','net.http_post(text,jsonb,jsonb,jsonb,integer)','cron.schedule(text,text,text)'])assert.ok(sql.includes("'"+dependency+"'"));
  assert.match(sql,/count\(\*\).*vault\.decrypted_secrets[\s\S]*<>1/);
  assert.match(sql,/length\(btrim\(decrypted_secret\)\)>0/);
});
test('atomic, serialized and creation-only SQL cannot overwrite or silently recreate existing jobs',()=>{
  assert.match(sql,/\nbegin;[\s\S]*\ncommit;/);
  assert.match(sql,/lock table cron\.job in share row exclusive mode/);
  assert.match(sql,/set local lock_timeout = '3s'/);
  assert.doesNotMatch(sql,/cron\.(?:unschedule|alter_job)\s*\(|(?:update|delete from)\s+cron\.job/i);
  assert.ok(sql.indexOf('continue;')<sql.indexOf('perform cron.schedule'));
  assert.ok(sql.indexOf("current_setting('voom_ops.create_jobs',true)")<sql.indexOf('perform cron.schedule'));
  assert.equal((sql.match(/perform cron\.schedule\(/g)??[]).length,1);
  const outside=sql.replace(/\$command\$[\s\S]*?\$command\$/,'');
  assert.doesNotMatch(outside,/(?:perform|select)\s+net\.http_post\s*\(/i,'no request executed by the installer');
});
test('repeated inventory checks preserve every original byte, ID, state and unrelated job',()=>{
  const state=inventory();state.jobs.push({jobid:99,jobname:'unrelated',schedule:'* * * * *',command:'select unrelated_private_action()',active:false,database:'other',username:'other'});
  const before=JSON.stringify(state);
  for(let i=0;i<3;i++){const result=validateInventory(config,state);assert.equal(result.length,10);assert.ok(result.every(v=>v.unchanged));}
  assert.equal(JSON.stringify(state),before);
});
test('the renewal command keeps its actual host and timeout, never applies the new-install default',()=>{
  for(const base of ['https://voom.today','https://voom-real.vercel.app'])for(const timeout of [null,290000,310000]){
    const state=inventory();state.jobs[9].command=observedCommand('instagram-token-refresh',timeout,base);
    const before=JSON.stringify(state),result=validateInventory(config,state);
    assert.equal(result[9].timeoutMs,timeout);assert.equal(JSON.stringify(state),before);
  }
});
for(const [label,change,code] of [
  ['missing helper',s=>{s.jobs[9].command="select voom_ops.call_worker('/api/cron/instagram-token-refresh')";},'unsupported_or_unsafe_command'],
  ['changed schedule',s=>{s.jobs[0].schedule='1-59/5 * * * *';},'job_metadata_drift'],
  ['changed endpoint',s=>{s.jobs[0].command=observedCommand('instagram-publish',null,'https://attacker.example');},'unsupported_or_unsafe_command'],
  ['changed Vault name',s=>{s.jobs[0].command=s.jobs[0].command.replace('voom_instagram_cron_secret','voom_cron_secret');},'unsupported_or_unsafe_command'],
  ['lost Bearer space',s=>{s.jobs[0].command=s.jobs[0].command.replace("'Bearer '","'Bearer'");},'unsupported_or_unsafe_command'],
  ['lost email timeout',s=>{s.jobs[3].command=observedCommand('email-flows',null);},'timeout_drift'],
  ['changed performance timeout',s=>{s.jobs[6].command=observedCommand('youtube-performance',290000);},'timeout_drift'],
  ['duplicate canonical name',s=>{s.jobs.push({...s.jobs[0],jobid:55});},'duplicate_job_name'],
  ['duplicate endpoint under old name',s=>{s.jobs.push({...s.jobs[5],jobid:55,jobname:'voom-youtube-reconcile-10m'});},'endpoint_alias_conflict'],
  ['old alias instead of canonical name',s=>{s.jobs[5].jobname='voom-youtube-reconcile-10m';},'endpoint_alias_conflict'],
  ['inactive job',s=>{s.jobs[0].active=false;},'job_metadata_drift'],
  ['other owner',s=>{s.jobs[0].username='different';},'job_metadata_drift'],
  ['other database',s=>{s.jobs[0].database='different';},'job_metadata_drift'],
  ['missing job',s=>{s.jobs.pop();},'managed_job_missing'],
  ['unsafe renewal timeout',s=>{s.jobs[9].command=observedCommand('instagram-token-refresh',900000);},'timeout_drift'],
  ['literal credential',s=>{s.jobs[0].command=s.jobs[0].command.replace(/\(select decrypted_secret[^)]*\)/,"'synthetic-private-value'");},'unsupported_or_unsafe_command'],
  ['appended SQL',s=>{s.jobs[0].command+=' select unrelated_private_action();';},'unsupported_or_unsafe_command'],
])test('rejects '+label+' without modifying or exposing commands',()=>{
  const state=inventory();change(state);const before=JSON.stringify(state);
  assert.throws(()=>validateInventory(config,state),error=>error.message===code);assert.equal(JSON.stringify(state),before);
});
test('repository validation catches a reintroduced helper, unanchored parser and duplicate manifest',()=>{
  assert.throws(()=>readWorkerSchedule(sql+"\nselect voom_ops.call_worker('/api/cron/instagram-token-refresh');"),/missing_helper_dependency/);
  assert.throws(()=>readWorkerSchedule(sql.replace('$$shape$;','$shape$;')),/command_shape_unanchored/);
  assert.throws(()=>readWorkerSchedule(sql.replace("('voom-media-generation-2m'","('voom-instagram-publish-5m'")),/duplicate_manifest/);
});
test('offline CLI reports scope honestly and never prints private paths/errors',()=>{
  const tool=new URL('../supabase/ops/validate-worker-schedules.mjs',import.meta.url);
  const ok=spawnSync(process.execPath,[tool.pathname],{encoding:'utf8'});
  assert.equal(ok.status,0);assert.deepEqual(JSON.parse(ok.stdout),{status:'PASS',scope:'repository_only',workers:10,sqlExecuted:false});
  const bad=spawnSync(process.execPath,[tool.pathname,'--inventory','/synthetic-private-missing-file'],{encoding:'utf8'});
  assert.equal(bad.status,1);assert.doesNotMatch(bad.stderr,/synthetic-private|ENOENT/);assert.equal(JSON.parse(bad.stderr).sqlExecuted,false);
});
test('existing Vercel scheduling remains separate and is not duplicated in the manifest',()=>{
  const vercel=JSON.parse(read('vercel.json'));
  for(const job of vercel.crons)assert.ok(!config.workers.some(w=>w.path===job.path));
  assert.ok(vercel.crons.some(j=>j.path==='/api/cron/linkedin-publish'&&j.schedule==='*/5 * * * *'));
});
test('PR branch cannot auto-deploy and all existing Vercel settings remain unchanged',()=>{
  const vercel=JSON.parse(read('vercel.json'));
  assert.equal(vercel.git.deploymentEnabled['codex/scheduled-worker-config-drift'],false);
  delete vercel.git.deploymentEnabled['codex/scheduled-worker-config-drift'];
  assert.deepEqual(vercel,{
    git:{deploymentEnabled:Object.fromEntries([
      'codex/linkedin-production-release','codex/linkedin-marketing-plan','codex/marketing-plan-action-handoff',
      'codex/native-plan-video-generation','codex/youtube-owner-refresh-diagnostic','codex/youtube-canonical-oauth',
      'codex/youtube-native-mp4-upload','codex/youtube-resumable-uploads','fix/instagram-token-renewal',
    ].map(branch=>[branch,false]))},
    crons:[{path:'/api/cron/weekly-plans',schedule:'0 3 * * *'},
      {path:'/api/cron/trend-collection',schedule:'0 4 * * *'},
      {path:'/api/cron/linkedin-publish',schedule:'*/5 * * * *'}],
  });
});
