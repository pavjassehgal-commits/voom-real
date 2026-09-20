import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

const { isAuthorizedEmailFlowCron } = await import("../app/api/cron/email-flows/route.ts");
const { isInsideSendWindow, nextSafeSendInstant } = await import("../lib/email-flows/timing.ts");

test("cron authorization accepts only the exact configured bearer secret", () => {
  const valid = new Request("https://voom.example/api/cron/email-flows", {
    headers: { authorization: "Bearer cron-test-secret" },
  });
  const wrong = new Request("https://voom.example/api/cron/email-flows", {
    headers: { authorization: "Bearer wrong" },
  });
  const missing = new Request("https://voom.example/api/cron/email-flows");
  assert.equal(isAuthorizedEmailFlowCron(valid, "cron-test-secret"), true);
  assert.equal(isAuthorizedEmailFlowCron(wrong, "cron-test-secret"), false);
  assert.equal(isAuthorizedEmailFlowCron(missing, "cron-test-secret"), false);
  assert.equal(isAuthorizedEmailFlowCron(valid, ""), false, "a missing server secret fails closed");
});

test("the execution window is start-inclusive and end-exclusive in business local time", () => {
  assert.equal(isInsideSendWindow(new Date("2026-09-20T05:00:00.000Z"), "Asia/Dubai"), true); // 09:00
  assert.equal(isInsideSendWindow(new Date("2026-09-20T13:59:59.000Z"), "Asia/Dubai"), true); // 17:59
  assert.equal(isInsideSendWindow(new Date("2026-09-20T14:00:00.000Z"), "Asia/Dubai"), false); // 18:00
});

test("DST boundaries use the IANA timezone rather than a fixed offset", () => {
  const beforeDst = nextSafeSendInstant({
    after: "2026-03-07T02:00:00.000Z",
    now: new Date("2026-03-07T02:00:00.000Z"),
    timeZone: "America/New_York",
    leadMinutes: 0,
  });
  const afterDst = nextSafeSendInstant({
    after: "2026-03-09T02:00:00.000Z",
    now: new Date("2026-03-09T02:00:00.000Z"),
    timeZone: "America/New_York",
    leadMinutes: 0,
  });
  assert.equal(beforeDst, "2026-03-07T14:00:00.000Z");
  assert.equal(afterDst, "2026-03-09T13:00:00.000Z");
});

test("0044 is additive, service-role only, and preserves historical migrations", () => {
  const sql = fs.readFileSync("supabase/migrations/0044_email_flow_durable_claims.sql", "utf8").toLowerCase();
  assert.match(sql, /add column if not exists claim_token/);
  assert.match(sql, /claim_email_flow_step_run_v2/);
  assert.match(sql, /abandon_stale_email_flow_step_run/);
  assert.match(sql, /provider_outcome_ambiguous/);
  assert.match(sql, /revoke all on function public\.claim_email_flow_step_run_v2[\s\S]*from public, anon, authenticated/);
  assert.match(sql, /grant execute on function public\.claim_email_flow_step_run_v2[\s\S]*to service_role/);
  assert.doesNotMatch(sql, /drop table|drop column|truncate/);
  for (const number of ["0040", "0041", "0042", "0043"]) {
    assert.equal(fs.readdirSync("supabase/migrations").some((name) => name.startsWith(number)), true);
  }
});
