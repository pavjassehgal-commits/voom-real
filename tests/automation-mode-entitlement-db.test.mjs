/**
 * Migration 0071: a browser-role client cannot store an automation mode its
 * plan does not include, or any non-canonical value, by writing its own
 * businesses row directly (the owner-update RLS policy allows the write).
 * Real SQL on PGlite, executed as the `authenticated` API role.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createSupabaseLite } from "./helpers/pglite-supabase.mjs";

const OWNER = "7b1d2c3e-0000-4000-8000-000000000071";

async function db() {
  const { db: pg } = await createSupabaseLite();
  await pg.query("insert into auth.users(id) values ($1)", [OWNER]);
  return pg;
}

async function asOwner(pg, fn) {
  // As PostgREST does: the API role plus the request's JWT claims.
  await pg.exec(`set role authenticated; select set_config('request.jwt.claim.sub', '${OWNER}', false);
    select set_config('request.jwt.claims', '{"role":"authenticated","sub":"${OWNER}"}', false);`);
  try { return await fn(); } finally { await pg.exec("reset role; select set_config('request.jwt.claims', '', false);"); }
}

const setMode = (pg, value) => pg.query("update public.businesses set automation_level = $2 where owner_user_id = $1", [OWNER, value]);
const mode = async (pg) => (await pg.query("select automation_level from public.businesses where owner_user_id = $1", [OWNER])).rows[0].automation_level;

for (const [plan, allowed, refused] of [
  ["free", ["manual"], ["assisted", "autopilot"]],
  ["pro", ["manual", "assisted"], ["autopilot"]],
  ["max", ["manual", "assisted", "autopilot"], []],
]) {
  test(`${plan}: a client may store only ${allowed.join("/")}; never a non-canonical value`, async () => {
    const pg = await db();
    await pg.query("insert into public.businesses(owner_user_id, brand_name, plan, automation_level) values ($1, 'Owner', $2, null)", [OWNER, plan]);
    await asOwner(pg, async () => {
      for (const value of refused) await assert.rejects(setMode(pg, value), /automation_mode_not_entitled/, `${plan} refuses ${value}`);
      for (const value of ["MARA runs it end-to-end", "Autopilot", "auto"]) {
        await assert.rejects(setMode(pg, value), /automation_mode_not_entitled/, `${plan} refuses "${value}"`);
      }
      for (const value of allowed) {
        await setMode(pg, value);
        assert.equal(await mode(pg), value);
      }
      await setMode(pg, null);
      assert.equal(await mode(pg), null, "clearing to unset (Manual) is always allowed");
    });
  });
}

test("a new client-created business can only start Manual or unset", async () => {
  const pg = await db();
  await asOwner(pg, async () => {
    await assert.rejects(pg.query("insert into public.businesses(owner_user_id, brand_name, automation_level) values ($1, 'x', 'assisted')", [OWNER]), /automation_mode_not_entitled/);
    await pg.query("insert into public.businesses(owner_user_id, brand_name, automation_level) values ($1, 'x', 'manual')", [OWNER]);
    assert.equal(await mode(pg), "manual");
  });
});

test("existing onboarding answers are never rewritten: unrelated edits succeed and keep the stored value", async () => {
  const pg = await db();
  await pg.query("insert into public.businesses(owner_user_id, brand_name, plan, automation_level) values ($1, 'Owner', 'free', 'MARA drafts, I approve')", [OWNER]);
  await asOwner(pg, async () => {
    await pg.query("update public.businesses set industry = 'Salon' where owner_user_id = $1", [OWNER]);
    assert.equal(await mode(pg), "MARA drafts, I approve");
    await assert.rejects(setMode(pg, "assisted"), /automation_mode_not_entitled/, "Free cannot confirm Assisted");
    await setMode(pg, "manual");
    assert.equal(await mode(pg), "manual", "but can confirm a mode its plan includes");
  });
});

test("server-side (service role) writes are not affected; plan and pause guards still hold", async () => {
  const pg = await db();
  await pg.query("insert into public.businesses(owner_user_id, brand_name, plan, automation_level) values ($1, 'Owner', 'free', 'autopilot')", [OWNER]);
  assert.equal(await mode(pg), "autopilot", "server-side code is unaffected by the browser-role guard");
  await asOwner(pg, async () => {
    await assert.rejects(pg.query("update public.businesses set plan = 'max' where owner_user_id = $1", [OWNER]), /Cannot modify plan/);
    await pg.query("update public.businesses set industry = 'Retail' where owner_user_id = $1", [OWNER]);
    assert.equal(await mode(pg), "autopilot", "an unchanged value passes, so no existing row breaks");
  });
});
