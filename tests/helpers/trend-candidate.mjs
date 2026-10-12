/**
 * Builds the single integration-candidate migration for Trend Intelligence
 * from the two reviewed component files, deterministically:
 *
 *   one transaction = storage component (without its own begin/commit and
 *   without its "re-apply after governance" guard, which only protects the
 *   two-file arrangement) + governance component (without begin/commit).
 *
 * A test asserts supabase/proposed/0055_trend_intelligence.sql is exactly
 * this output, so the candidate can never drift from the reviewed components.
 * Regenerate with:  node tests/helpers/trend-candidate.mjs --write
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const PROPOSED = new URL("../../supabase/proposed/", import.meta.url);
export const CANDIDATE_NAME = "0055_trend_intelligence.sql";
export const CANDIDATE_ROLLBACK_NAME = "0055_trend_intelligence.rollback.sql";

const read = (name) => readFileSync(new URL(name, PROPOSED), "utf8");

function body(sql, name) {
  const lines = sql.split("\n");
  const begin = lines.indexOf("begin;");
  const commit = lines.lastIndexOf("commit;");
  if (begin < 0 || commit < begin || lines.filter((l) => l === "begin;").length !== 1) throw new Error(`${name}: expected one top-level begin/commit`);
  return [...lines.slice(0, begin), ...lines.slice(begin + 1, commit)].join("\n").trimEnd();
}

const REAPPLY_GUARD = /\n-- Once the governance file has extended this schema[\s\S]*?\nend\n\$\$;\n/;

export function assembleCandidate() {
  const storageSource = read("trend_intelligence_storage.sql");
  if (!REAPPLY_GUARD.test(storageSource)) throw new Error("storage component: re-apply guard not found");
  const storage = body(storageSource.replace(REAPPLY_GUARD, "\n"), "storage");
  const governance = body(read("trend_intelligence_governance.sql"), "governance");
  return `-- ${CANDIDATE_NAME} — INTEGRATION CANDIDATE for Voom Trend Intelligence.
--
-- NOT YET A MIGRATION: it stays in supabase/proposed/ until the owner approves
-- integration. Intended number 0055, i.e. AFTER the Admin Panel's 0052–0054
-- (already applied on voom-staging; not on production, last reported at 0051).
-- It depends only on 0001–0051 objects it does not touch (it creates trend_*
-- objects only) and on nothing in 0052–0054.
--
-- GENERATED — do not edit by hand. Source components (reviewed separately):
--   Part 1  supabase/proposed/trend_intelligence_storage.sql     (Stage 2A)
--   Part 2  supabase/proposed/trend_intelligence_governance.sql  (Stage 2C/2D)
-- Regenerate: node tests/helpers/trend-candidate.mjs --write
-- Rollback:   supabase/proposed/${CANDIDATE_ROLLBACK_NAME}
--
-- One transaction: it applies completely or not at all. Part 2 redefines some
-- Part 1 functions and grants; within the transaction only the final
-- definitions are ever visible. Idempotent: re-running yields the same schema.
-- No schedule, pg_cron, pg_net, worker, credential or provider call.

begin;

-- ════════════════════════════════════════════════════════════════════════
-- PART 1 — storage (from trend_intelligence_storage.sql)
-- ════════════════════════════════════════════════════════════════════════
${storage}

-- ════════════════════════════════════════════════════════════════════════
-- PART 2 — governance, RPCs, retention (from trend_intelligence_governance.sql)
-- ════════════════════════════════════════════════════════════════════════
${governance}

commit;
`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  writeFileSync(new URL(CANDIDATE_NAME, PROPOSED), assembleCandidate());
  console.log(`wrote supabase/proposed/${CANDIDATE_NAME}`);
}
