/**
 * ONE-OFF Wikidata event collection into voom-staging (qcdpegwjofrqnfudyrqq).
 *
 *   node --env-file=.env.staging.local scripts/trends/collect-wikidata-staging.mjs \
 *     --project=qcdpegwjofrqnfudyrqq --approved-live-run
 *
 * .env.staging.local (git-ignored by `.env*`) must hold ONLY staging values:
 *   NEXT_PUBLIC_SUPABASE_URL=https://qcdpegwjofrqnfudyrqq.supabase.co
 *   SUPABASE_SECRET_KEY=<staging service-role key>
 *
 * Refuses unless: both flags are present, the URL is exactly the staging
 * project, a key is present, and the database currently permits
 * wikidata_events for web/AE. Makes at most ONE Wikidata GET (no retries),
 * stores only through the governed RPC, approves nothing, creates no MARA
 * context. Writes a JSON report (counts, statuses, safe codes; no credentials)
 * to docs/trend-intelligence/staging/runs/.
 */
import "../../tests/helpers/server-only-shim.mjs";

import { mkdirSync, writeFileSync } from "node:fs";

import { STAGING_PROJECT_ID, verifyStagingTarget } from "./staging-target.mjs";

const { runStagingWikidataCollection } = await import("../../lib/trends/collection-runner.ts");

const args = new Set(process.argv.slice(2));
const refuse = (code, message) => {
  console.error(`REFUSED (${code}): ${message}`);
  process.exit(2);
};

if (!args.has(`--project=${STAGING_PROJECT_ID}`)) refuse("project_flag_missing", `pass --project=${STAGING_PROJECT_ID}`);
if (!args.has("--approved-live-run")) refuse("not_approved", "a live run makes one Wikidata request and writes to staging; pass --approved-live-run after approval");

const target = verifyStagingTarget(process.env);
if (!target.ok) refuse(target.code, "the environment does not point at voom-staging with a service key");

let report;
try {
  const { createTrendAdminRpcClient } = await import("../../lib/trends/supabase-rpc.ts");
  report = await runStagingWikidataCollection({ client: createTrendAdminRpcClient(), now: new Date(), fetch: (url, init) => globalThis.fetch(url, init) });
} catch {
  // Never print the underlying error: it may contain connection details.
  refuse("collection_failed", "the run failed before completing; nothing was approved");
}

const dir = new URL("../../docs/trend-intelligence/staging/runs/", import.meta.url);
mkdirSync(dir, { recursive: true });
const file = new URL(`wikidata-${report.runAt.replace(/[:.]/g, "-")}.json`, dir);
writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);

console.log(`status: ${report.status}${report.code ? ` (${report.code})` : ""}`);
console.log(`project: ${report.projectId} · Wikidata requests: ${report.wikidataRequests}`);
console.log(`discovered: ${report.discovered} · rejected by connector: ${report.rejectedByConnector} ${JSON.stringify(report.rejectedReasons)}`);
console.log(`storage: ${JSON.stringify(report.storage)}`);
for (const c of report.candidates) {
  console.log(`- ${c.label} (${c.entity}) · dates ${c.dateStatus}${c.dateIssues.length ? ` [${c.dateIssues.join(", ")}]` : ""}${c.eventWindow ? ` ${c.eventWindow.start}..${c.eventWindow.end}` : ""} · ${c.storage} · ${c.reviewStatus}`);
}
console.log(`approvals created: ${report.approvalsCreated} · MARA contexts created: ${report.contextsCreated}`);
console.log(`report: ${file.pathname}`);
process.exit(report.status === "completed" ? 0 : 1);
