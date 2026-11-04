/**
 * Compares a hosted post-apply fingerprint with the reviewed migrations.
 *
 *   node scripts/youtube-register/verify-fingerprint.mjs 0065 pasted.json
 *   node scripts/youtube-register/verify-fingerprint.mjs 0069 pasted.json
 *
 * pasted.json is the SQL editor result of supabase/ops/youtube-compliance-fingerprint.sql
 * (the raw JSON or the editor's [{ "youtube_compliance_fingerprint": "..." }] export).
 * Expected values are computed locally by applying the repository's migrations to
 * embedded Postgres; nothing remote is contacted. Exit 1 on any unexpected difference.
 */
import { readFileSync } from "node:fs";
import { createSupabaseLite } from "../../tests/helpers/pglite-supabase.mjs";

const [stage, file] = process.argv.slice(2);
if (!["0065", "0069"].includes(stage) || !file) { console.error("usage: verify-fingerprint.mjs 0065|0069 <pasted.json>"); process.exit(2); }
const unwrap = (value) => {
  if (Array.isArray(value)) value = Object.values(value[0])[0];
  if (typeof value === "string") value = JSON.parse(value);
  return value.fingerprint ?? value;
};
const actual = unwrap(JSON.parse(readFileSync(file, "utf8")));
const sql = readFileSync(new URL("../../supabase/ops/youtube-compliance-fingerprint.sql", import.meta.url), "utf8");
const lite = await createSupabaseLite(stage === "0065" ? { stopBefore: "0069" } : {});
const expected = unwrap((await lite.db.query(sql)).rows[0].youtube_compliance_fingerprint);
await lite.db.close();

// Supabase's default privileges (not the migrations) grant service_role these; harmless:
// trigger functions cannot be called directly, and 0047's table predates this work.
const ENVIRONMENT = [
  ["functions", "youtube_erasure_write_guard()", "exec"], ["functions", "youtube_publish_queue_guard()", "exec"],
  ["functions", "youtube_before_account_delete()", "exec"], ["tables", "youtube_connections", "privs"],
];
const known = (section, key, field) => ENVIRONMENT.some(([s, k, f]) => s === section && k === key && f === field);
let unexpected = 0, environment = 0;
for (const section of ["functions", "tables", "indexes", "triggers"]) {
  const keys = new Set([...Object.keys(expected[section] ?? {}), ...Object.keys(actual[section] ?? {})]);
  for (const key of keys) {
    const e = expected[section]?.[key], a = actual[section]?.[key];
    if (e === undefined || a === undefined) { unexpected++; console.log(`UNEXPECTED ${section} ${key}: ${a === undefined ? "missing" : "extra"}`); continue; }
    if (typeof e !== "object") { if (e !== a) { unexpected++; console.log(`UNEXPECTED ${section} ${key}`); } continue; }
    for (const field of Object.keys(e)) {
      if (JSON.stringify(e[field]) === JSON.stringify(a[field])) continue;
      if (known(section, key, field)) { environment++; continue; }
      unexpected++; console.log(`UNEXPECTED ${section} ${key}.${field}: hosted ${JSON.stringify(a[field])} expected ${JSON.stringify(e[field])}`);
    }
  }
}
console.log(`${stage}: ${Object.keys(expected.functions).length} functions, ${Object.keys(expected.tables).length} tables, `
  + `${Object.keys(expected.indexes).length} indexes, ${Object.keys(expected.triggers).length} triggers checked; `
  + `${unexpected} unexpected, ${environment} known Supabase default-privilege differences.`);
process.exit(unexpected ? 1 : 0);
