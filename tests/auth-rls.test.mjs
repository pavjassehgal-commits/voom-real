import assert from "node:assert/strict";
import test from "node:test";
import {createSupabaseLite} from "./helpers/pglite-supabase.mjs";

test("0050 enforces authoritative verification across direct Supabase DB access without rewriting existing users",async t => {
  const {db,applyPending}=await createSupabaseLite({stopBefore:"0050"});
  const verified="11111111-1111-4111-8111-111111111111",unverified="22222222-2222-4222-8222-222222222222";
  try {
    await db.exec(`insert into auth.users(id,email,email_confirmed_at) values ('${verified}','confirmed@example.test','2020-01-01'),('${unverified}','unconfirmed@example.test',null);
      insert into public.profiles(user_id,display_name) values ('${verified}','Confirmed'),('${unverified}','Unconfirmed');
      insert into public.businesses(owner_user_id,brand_name) values ('${verified}','Confirmed brand'),('${unverified}','Unconfirmed brand');`);
    const before=(await db.query("select * from auth.users order by id")).rows;
    await applyPending();
    assert.deepEqual((await db.query("select * from auth.users order by id")).rows,before);
    async function asUser(id,fn) {
      await db.exec(`set role authenticated; set request.jwt.claim.sub='${id}';`);
      try {await fn();} finally {await db.exec("reset role; reset request.jwt.claim.sub;");}
    }
    await t.test("unconfirmed legacy account can neither read nor create/update product rows",async () => {
      await asUser(unverified,async () => {
        assert.equal((await db.query("select public.voom_has_verified_email() as ok")).rows[0].ok,false);
        for(const table of ["profiles","businesses","voom_campaigns","mara_drafts","content_calendar_items"])assert.deepEqual((await db.query(`select * from public.${table}`)).rows,[]);
        await assert.rejects(db.query(`insert into public.profiles(user_id) values ('${unverified}')`),/row-level security/);
        assert.equal((await db.query("update public.businesses set brand_name='forged' returning id")).rows.length,0);
      });
    });
    await t.test("confirmed legacy account keeps owner-only read/write; no age/password migration needed",async () => {
      await asUser(verified,async () => {
        assert.equal((await db.query("select public.voom_has_verified_email() as ok")).rows[0].ok,true);
        assert.equal((await db.query("select * from public.profiles")).rows.length,1);
        assert.equal((await db.query("update public.profiles set display_name='Updated' returning user_id")).rows[0].user_id,verified);
        await assert.rejects(db.query(`insert into public.profiles(user_id) values ('${unverified}')`),/row-level security/);
      });
    });
    await t.test("confirmation change takes effect immediately even with same subject/session",async () => {
      await db.exec(`update auth.users set email_confirmed_at=now() where id='${unverified}'`);
      await asUser(unverified,async () => assert.equal((await db.query("select * from public.businesses")).rows.length,1));
      await db.exec(`update auth.users set email_confirmed_at=null where id='${unverified}'`);
      await asUser(unverified,async () => assert.equal((await db.query("select * from public.businesses")).rows.length,0));
    });
    await t.test("every existing public RLS table has restrictive verification, including future inventory gate",async () => {
      const missing=await db.query(`select c.relname from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p') and c.relrowsecurity and not exists(select 1 from pg_policy p where p.polrelid=c.oid and p.polname='voom_verified_email' and not p.polpermissive)`);
      assert.deepEqual(missing.rows,[]);
      const bypasses=await db.query(`select p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prosecdef and p.prorettype <> 'trigger'::regtype and p.proname <> 'voom_has_verified_email' and has_function_privilege('authenticated',p.oid,'execute')`);
      assert.deepEqual(bypasses.rows,[]);
    });
    await t.test("service-role cron/provider work bypasses user verification and preserves RPC grants",async () => {
      await db.exec("set role service_role;");
      try {
        assert.equal((await db.query("select * from public.businesses")).rows.length,2);
        assert.equal((await db.query("select has_function_privilege('service_role','public.voom_plan_allowance(uuid)','execute') as ok")).rows[0].ok,true);
        assert.equal((await db.query("select has_function_privilege('authenticated','public.voom_plan_allowance(uuid)','execute') as ok")).rows[0].ok,false);
      } finally {await db.exec("reset role;");}
    });
  } finally {await db.close();}
});
