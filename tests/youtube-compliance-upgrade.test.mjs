import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID, createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createSupabaseLite, migrationSql } from './helpers/pglite-supabase.mjs';

const RETENTION='0065_youtube_data_retention.sql';
const CURRENT=['0066_youtube_resumable_uploads.sql','0067_youtube_upload_cleanup_fairness.sql','0068_instagram_token_renewal.sql'];
const HASH='2f612e4070dc2ed95d0fcbc463fe56dfe9d0618c806259f00a8002964de0a1f5';

test('0065 installs after the current Production migration order without replacing uploader/renewal objects',async t=>{
  const local=await createSupabaseLite({stopBefore:'0065'});
  t.after(()=>local.db.close());
  for(const file of CURRENT)await local.db.exec(migrationSql(file));
  const q=async(sql,args=[])=>(await local.db.query(sql,args)).rows;
  const owner=randomUUID(),draft=randomUUID(),conversation=randomUUID(),path=`${owner}/youtube-uploads/${randomUUID()}.mp4`;
  await q('insert into auth.users(id) values($1)',[owner]);
  await q('insert into mara_conversations(id,owner_user_id) values($1,$2)',[conversation,owner]);
  await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content) values($1,$2,$3,'youtube_video','youtube','youtube','video','Keep original','Keep caption')",[draft,owner,conversation]);
  await q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'Original.mp4','video/mp4',5242880,'uploaded_existing','uploaded')",[owner,draft,path]);
  await q("insert into youtube_connections(owner_user_id,channel_id,channel_title,status,connected_at) values($1,'synthetic-channel','Keep identity','connected',now())",[owner]);
  await q("insert into youtube_connection_secrets(connection_id,owner_user_id,encrypted_refresh_token,refresh_iv,refresh_auth_tag,refresh_key_version) select id,owner_user_id,'synthetic-ciphertext','iv','tag',1 from youtube_connections where owner_user_id=$1",[owner]);
  const assetBefore=await q('select to_jsonb(a) row from post_draft_assets a');
  const creditBefore=await q('select to_jsonb(l) row from voom_credit_ledger l');
  const bucketsBefore=await q('select to_jsonb(b) row from storage.buckets b order by id');
  const definitions=()=>q(`select oid::regprocedure::text identity,pg_get_functiondef(oid) definition,proacl::text acl from pg_proc where pronamespace='public'::regnamespace and (proname like '%youtube_upload%' or proname like '%instagram_token%') order by identity`);
  const functionsBefore=await definitions();
  assert.equal(createHash('sha256').update(await readFile(new URL('../supabase/migrations/'+RETENTION,import.meta.url))).digest('hex'),HASH);
  await local.db.exec(migrationSql(RETENTION));
  assert.deepEqual(await definitions(),functionsBefore);
  assert.deepEqual(await q('select to_jsonb(a) row from post_draft_assets a'),assetBefore);
  assert.deepEqual(await q('select to_jsonb(l) row from voom_credit_ledger l'),creditBefore);
  assert.deepEqual(await q('select to_jsonb(b) row from storage.buckets b order by id'),bucketsBefore);
  assert.equal((await q('select channel_title from youtube_connections'))[0].channel_title,'Keep identity');
  assert.equal((await q('select count(*)::int n from youtube_privacy_controls'))[0].n,0,'installation does not perform erasure');
  await q('select erase_youtube_data($1,true)',[owner]);
  assert.equal((await q('select count(*)::int n from youtube_connection_secrets'))[0].n,0);
  assert.deepEqual(await q('select to_jsonb(a) row from post_draft_assets a'),assetBefore,'YouTube erasure preserves private originals');
  assert.deepEqual(await q('select * from claim_youtube_upload_cleanup(10)'),[],'an attached original is never cleanup work');
  await assert.rejects(local.db.exec(migrationSql(RETENTION)),/already exists/,'one-time installation is not silently retried');
  await local.db.exec('rollback');
});

test('0065 erasure preserves current direct uploads while 0067 still selects only abandoned, unprotected sessions',async t=>{
  const local=await createSupabaseLite();t.after(()=>local.db.close());
  const q=async(sql,args=[])=>(await local.db.query(sql,args)).rows;
  const owner=randomUUID(),other=randomUUID(),conversation=randomUUID();
  await q('insert into auth.users(id) values($1),($2)',[owner,other]);
  await q('insert into mara_conversations(id,owner_user_id) values($1,$2)',[conversation,owner]);
  async function session({attached=false,fresh=false,validating=false}={}){
    const id=randomUUID(),draft=randomUUID(),path=`${owner}/youtube-uploads/${id}.mp4`;
    await q("insert into mara_drafts(id,owner_user_id,conversation_id,kind,channel,social_channel,social_format,title,content) values($1,$2,$3,'youtube_video','youtube','youtube','video','Original','Original')",[draft,owner,conversation]);
    await q("insert into youtube_upload_sessions(id,owner_user_id,draft_id,request_key,content_version,storage_path,display_name,byte_size,fingerprint,status,created_at,expires_at,cleanup_after,claim,claimed_until) values($1,$2,$3,$4,1,$5,'original.mp4',100,$6,$7,now()-make_interval(days=>$8),now()-make_interval(days=>$8)+interval '2 hours',now()-make_interval(days=>$8)+interval '51 hours',case when $9 then gen_random_uuid() end,case when $9 then now()+interval '1 hour' end)",[id,owner,draft,randomUUID(),path,'a'.repeat(64),attached?'attached':validating?'validating':'cancelled',fresh?0:4,validating]);
    if(attached)await q("insert into post_draft_assets(owner_user_id,draft_id,storage_path,display_name,mime_type,byte_size,origin,status) values($1,$2,$3,'original.mp4','video/mp4',100,'uploaded_existing','uploaded')",[owner,draft,path]);
    return id;
  }
  const attached=await session({attached:true}),fresh=await session({fresh:true}),active=await session({validating:true}),orphan=await session();
  const before=await q('select to_jsonb(a) row from post_draft_assets a');
  await q('select erase_youtube_data($1,false)',[owner]);
  const rows=await q('select * from claim_youtube_upload_cleanup(10)');
  assert.deepEqual(rows.map(row=>row.id),[orphan]);
  for(const id of [attached,fresh,active])assert.notEqual(id,rows[0].id);
  assert.deepEqual(await q('select to_jsonb(a) row from post_draft_assets a'),before);
  assert.equal((await q('select count(*)::int n from youtube_upload_sessions where status=\'deleted\''))[0].n,0,'claims are not Storage deletion');
  assert.equal((await q('select finish_youtube_upload_cleanup($1,$2,false) ok',[orphan,rows[0].claim]))[0].ok,true);
  assert.equal((await q('select status from youtube_upload_sessions where id=$1',[orphan]))[0].status,'cancelled','failed deletion remains retryable');
  assert.equal((await q('select count(*)::int n from auth.users'))[0].n,2);
});
