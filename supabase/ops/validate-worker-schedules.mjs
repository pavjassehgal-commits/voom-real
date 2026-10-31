/** Offline validator only: reads files, never connects to a DB or executes SQL. */
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const bases=['https://voom-real.vercel.app','https://voom.today'];
const fail=code=>{throw new Error(code);}; // Never echo commands, headers or secrets.
export function readWorkerSchedule(sql){
  if(/voom_ops\.call_worker\s*\(/i.test(sql))fail('missing_helper_dependency');
  const block=sql.match(/-- BEGIN WORKER MANIFEST[^\n]*\n([\s\S]*?)-- END WORKER MANIFEST/)?.[1]?.replace(/--[^\n]*/g,'');
  if(!block)fail('manifest_missing');
  const row=/\('([a-z0-9-]+)', '([0-9* /,-]+)', '(\/api\/cron\/[a-z-]+)', '(https:\/\/[^']+)', (null::integer|\d+), (true|false)\)/g;
  const matches=[...block.matchAll(row)];
  if(block.replace(row,'').replace(/[\s,]/g,'')||!matches.length)fail('manifest_invalid');
  const workers=matches.map(m=>({name:m[1],schedule:m[2],path:m[3],base:m[4],timeout:m[5]==='null::integer'?null:Number(m[5]),preserveTimeout:m[6]==='true'}));
  if(new Set(workers.map(w=>w.name)).size!==workers.length||new Set(workers.map(w=>w.path)).size!==workers.length)fail('duplicate_manifest');
  if(workers.some(w=>!bases.includes(w.base)||(w.timeout!==null&&(!Number.isInteger(w.timeout)||w.timeout<1||w.timeout>310000))))fail('unsafe_manifest');
  const shape=sql.match(/\$shape\$([\s\S]*?)\$shape\$/)?.[1];
  if(!shape?.startsWith('^')||!shape.endsWith('$'))fail('command_shape_unanchored');
  const template=sql.match(/\$command\$([\s\S]*?)\$command\$/)?.[1];
  if(!template||[...template.matchAll(/%[a-zA-Z]/g)].map(m=>m[0]).join()!=='%L,%s')fail('command_template_invalid');
  return {workers,shape:new RegExp(shape),template};
}

export function renderWorkerCommand(config,worker){
  return config.template.replace('%L',"'"+worker.base+worker.path+"'").replace('%s',worker.timeout===null?'':', timeout_milliseconds := '+worker.timeout);
}

/** Mirrors the file's read-only preflight; returns metadata, never changes a job. */
export function validateInventory(config,inventory){
  if(!Array.isArray(inventory.jobs)||!inventory.database||!inventory.username)fail('inventory_metadata_required');
  const results=[];
  for(const worker of config.workers){
    const named=inventory.jobs.filter(j=>j.jobname===worker.name);
    if(named.length>1)fail('duplicate_job_name');
    if(inventory.jobs.some(j=>typeof j.command==='string'&&j.command.includes(worker.path)&&j.jobname!==worker.name))fail('endpoint_alias_conflict');
    if(!named.length)fail('managed_job_missing');
    const job=named[0];
    if(job.schedule!==worker.schedule||job.active!==true||job.database!==inventory.database||job.username!==inventory.username)fail('job_metadata_drift');
    const parts=typeof job.command==='string'?config.shape.exec(job.command):null;
    if(!parts||!bases.some(b=>parts[1]===b+worker.path))fail('unsupported_or_unsafe_command');
    const timeout=parts[2]===undefined?null:Number(parts[2]);
    if(worker.preserveTimeout ? timeout!==null&&(!Number.isSafeInteger(timeout)||timeout<1||timeout>310000) : timeout!==worker.timeout)fail('timeout_drift');
    results.push({name:worker.name,schedule:job.schedule,timeoutMs:timeout,unchanged:true});
  }
  return results;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{
    const config=readWorkerSchedule(readFileSync(new URL('./schedule-workers.sql',import.meta.url),'utf8'));
    const args=process.argv.slice(2);
    if(args.length&&(args.length!==2||args[0]!=='--inventory'))fail('usage_expected_inventory_file');
    const result=args.length?validateInventory(config,JSON.parse(readFileSync(args[1],'utf8'))):null;
    process.stdout.write(JSON.stringify({status:'PASS',scope:result?'offline_inventory':'repository_only',workers:result??config.workers.length,sqlExecuted:false})+'\n');
  }catch(reason){
    const safe=reason instanceof Error&&/^[a-z_]+$/.test(reason.message)?reason.message:'validation_failed';
    process.stderr.write(JSON.stringify({status:'BLOCKED',reason:safe,sqlExecuted:false})+'\n');process.exitCode=1;
  }
}
