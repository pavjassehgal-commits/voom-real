import assert from 'node:assert/strict';
import test from 'node:test';
import {randomUUID,createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {createSupabaseLite,migrationSql} from './helpers/pglite-supabase.mjs';

const FIX='0067_youtube_upload_cleanup_fairness.sql';
async function fixture(t,{old=false}={}) {
  const local=await createSupabaseLite(old?{stopBefore:'0067'}:{});
  t.after(()=>local.db.close());
  const q=async(sql,args=[])=>(await local.db.query(sql,args)).rows;
  const owner=randomUUID();await q('insert into auth.users(id) values($1)',[owner]);
  const [conversation]=await q('insert into mara_conversations(owner_user_id) values($1) returning id',[owner]);
  async function session({protect,age=4,status='cancelled',lease}={}) {
    const id=randomUUID(),path=`${owner}/youtube-uploads/${id}.mp4`;
    let draft=null;
    if(protect){
      [draft]=await q("insert into mara_drafts(owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content) values($1,$2,'youtube_video','youtube','youtube','video','Keep title','Keep caption') returning id",[owner,conversation.id]);
    }
    await q("insert into youtube_upload_sessions(id,owner_user_id,draft_id,request_key,content_version,storage_path,display_name,byte_size,fingerprint,status,created_at,expires_at,cleanup_after,claimed_until,claim) values($1,$2,$3,$4,1,$5,'0067 local synthetic.mp4',100,$6,$7,now()-make_interval(days=>$8),now()-make_interval(days=>$8)+interval '24 hours',now()-make_interval(days=>$8)+interval '51 hours',case when $9::text is null then null else now()+$9::interval end,case when $9::text is null then null else gen_random_uuid() end)",[id,owner,draft?.id??null,randomUUID(),path,'a'.repeat(64),protect?'attached':status,age,lease??null]);
    if(protect==='post')await q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'keep.mp4','video/mp4',100,'uploaded_existing','uploaded')",[owner,draft.id,path]);
    if(protect==='reel')await q("insert into reel_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size) values($1,$2,$3,'keep.mp4','video/mp4',100)",[owner,draft.id,path]);
    if(protect==='instagram')await q("insert into instagram_media_assets(owner_user_id,draft_id,storage_path,media_type,mime_type,byte_size) values($1,$2,$3,'REELS','video/mp4',100)",[owner,draft.id,path]);
    if(protect==='generation')await q("insert into mara_media_generations(owner_user_id,conversation_id,draft_id,storage_path,media_type,prompt,aspect_ratio,status,idempotency_key) values($1,$2,$3,$4,'video','Keep original','16:9','completed',$5)",[owner,conversation.id,draft.id,path,randomUUID()]);
    return id;
  }
  const claim=async(limit=10)=>q('select * from public.claim_youtube_upload_cleanup($1)',[limit]);
  return {...local,q,owner,session,claim};
}

test('exact starvation reproduction: 0066 returns no work; forward 0067 reaches the later orphan',async t=>{
  const c=await fixture(t,{old:true});
  const protectedIds=[];for(let i=0;i<40;i++)protectedIds.push(await c.session({protect:['post','reel','instagram','generation'][i%4],age:5}));
  const orphan=await c.session({age:4});
  for(let i=0;i<3;i++)assert.deepEqual(await c.claim(),[],'old function is stuck behind protected candidates');
  const before=await c.q('select to_jsonb(s) row from youtube_upload_sessions s where id=any($1) order by id',[protectedIds]);
  await c.applyPending();
  assert.deepEqual((await c.claim()).map(r=>r.id),[orphan]);
  assert.deepEqual(await c.q('select to_jsonb(s) row from youtube_upload_sessions s where id=any($1) order by id',[protectedIds]),before,'all four protected registries remain untouched');
});

test('many protected records cannot consume batches; every eligible orphan is eventually claimed once',async t=>{
  const c=await fixture(t),orphans=[];
  for(let i=0;i<35;i++)await c.session({protect:'post',age:5});
  for(let i=0;i<31;i++)orphans.push(await c.session({age:4}));
  const seen=[];
  for(let batch=0;batch<4;batch++){
    const rows=await c.claim();assert.ok(rows.length<=10);seen.push(...rows.map(r=>r.id));
    for(const row of rows){
      assert.equal((await c.q('select finish_youtube_upload_cleanup($1,$2,true) ok',[row.id,row.claim]))[0].ok,true);
      assert.equal((await c.q('select finish_youtube_upload_cleanup($1,$2,true) ok',[row.id,row.claim]))[0].ok,false,'duplicate acknowledgement is not a second deletion');
    }
  }
  assert.deepEqual(seen.sort(),orphans.sort());assert.equal(new Set(seen).size,31);
  assert.deepEqual(await c.claim(),[]);
  assert.equal((await c.q("select count(*)::int n from youtube_upload_sessions where status='attached'"))[0].n,35);
});

test('51-hour grace, active validation/deletion leases, batch cap and stale-claim protection remain enforced',async t=>{
  const c=await fixture(t),fresh=await c.session({age:0}),validating=await c.session({status:'validating',lease:'1 hour'}),deleting=await c.session({status:'deleting',lease:'1 hour'});
  const expired=await c.session({status:'deleting',lease:'-1 second'});
  const oldClaim=(await c.q('select claim from youtube_upload_sessions where id=$1',[expired]))[0].claim;
  const rows=await c.claim(1000);assert.deepEqual(rows.map(r=>r.id),[expired]);assert.notEqual(rows[0].claim,oldClaim);
  assert.equal((await c.q('select finish_youtube_upload_cleanup($1,$2,true) ok',[expired,oldClaim]))[0].ok,false);
  for(const id of [fresh,validating,deleting])assert.notEqual((await c.q('select status from youtube_upload_sessions where id=$1',[id]))[0].status,'deleted');
  for(let i=0;i<30;i++)await c.session();
  assert.equal((await c.claim(1000)).length,25);assert.equal((await c.claim(0)).length,1);
  const [window]=await c.q('select extract(epoch from cleanup_after-created_at)::int seconds from youtube_upload_sessions where id=$1',[fresh]);
  assert.equal(window.seconds,51*3600);
});

test('reference lookup uncertainty aborts all claims instead of permitting deletion',async t=>{
  const c=await fixture(t),id=await c.session();
  await c.q('alter table public.reel_draft_assets rename to temporarily_unavailable_assets');
  await assert.rejects(c.claim(),/reel_draft_assets/);
  assert.equal((await c.q('select status from youtube_upload_sessions where id=$1',[id]))[0].status,'cancelled');
});

test('forward migration is data-preserving, repeatable, server-only and leaves installed 0066 immutable',async t=>{
  const c=await fixture(t,{old:true});await c.session({protect:'post'});await c.session();
  const snapshot=()=>c.q('select to_jsonb(s) row from youtube_upload_sessions s order by id');const before=await snapshot();
  await c.applyPending();await c.db.exec(migrationSql(FIX));assert.deepEqual(await snapshot(),before);
  const [access]=await c.q("select prosecdef,proconfig,has_function_privilege('anon',oid,'execute') anon,has_function_privilege('authenticated',oid,'execute') authenticated,has_function_privilege('service_role',oid,'execute') service from pg_proc where oid='public.claim_youtube_upload_cleanup(integer)'::regprocedure");
  assert.equal(access.prosecdef,true);assert.deepEqual(access.proconfig,['search_path=""']);assert.equal(access.anon,false);assert.equal(access.authenticated,false);assert.equal(access.service,true);
  assert.equal(createHash('sha256').update(await readFile(new URL('../supabase/migrations/0066_youtube_resumable_uploads.sql',import.meta.url))).digest('hex'),'ce70685585713b55a1084b346c4fc8007ebcb25666e3c003a5519f1b705c731b');
});

test('0067 fails transactionally before 0066 or when the installed function has unexpected drift',async()=>{
  const c=await createSupabaseLite({stopBefore:'0066'});
  try{
    await assert.rejects(c.db.exec(migrationSql(FIX)),/youtube_upload_cleanup_unexpected_prerequisite/);await c.db.exec('rollback');
    assert.equal((await c.db.query("select to_regclass('public.youtube_upload_sessions') t")).rows[0].t,null);
    await c.db.exec(migrationSql('0066_youtube_resumable_uploads.sql'));
    await c.db.exec("create or replace function public.claim_youtube_upload_cleanup(p_limit integer default 10) returns setof public.youtube_upload_sessions language plpgsql security definer set search_path='' as $$begin return;end$$");
    await assert.rejects(c.db.exec(migrationSql(FIX)),/youtube_upload_cleanup_unexpected_prerequisite/);await c.db.exec('rollback');
    assert.equal((await c.db.query("select prosrc from pg_proc where oid='public.claim_youtube_upload_cleanup(integer)'::regprocedure")).rows[0].prosrc,'begin return;end');
  }finally{await c.db.close();}
});
