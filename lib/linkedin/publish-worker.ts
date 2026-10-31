import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { LinkedInClient } from "./client.ts";
import { readLinkedInConfig, type LinkedInConfig } from "./config.ts";
import { linkedInCredentials } from "./data.ts";
import { runLinkedInPublishFlow, type LinkedInJob } from "./publish-flow.ts";

export async function publishClaimedLinkedInJob(db: SupabaseClient, config: LinkedInConfig,
  client: Pick<LinkedInClient,"publishText">, job: LinkedInJob) {
  return runLinkedInPublishFlow(job, {
    credentials: (row) => linkedInCredentials(db, row.owner_user_id, row.connection_id, row.member_sub, config.encryptionKey),
    async start(row) {
      const { data: allowed, error } = await db.rpc("start_linkedin_submission", {
        p_id: row.id, p_owner: row.owner_user_id, p_claim: row.claim_token,
      });
      if (error) throw new Error("linkedin_gate_failed");
      return allowed === true;
    },
    publish: (token, member, caption) => client.publishText(token, member, caption),
    async finish(row, result, ref) {
      const { data: recorded, error } = await db.rpc("finish_linkedin_job", {
        p_id: row.id, p_owner: row.owner_user_id, p_claim: row.claim_token, p_outcome: result, p_ref: ref ?? null,
      });
      if (error || recorded !== true) throw new Error("linkedin_result_not_recorded");
    },
  });
}

export async function runLinkedInPublishing(deps: {
  db: SupabaseClient; config?: LinkedInConfig | null; client?: Pick<LinkedInClient,"publishText">;
}) {
  const config = deps.config === undefined ? readLinkedInConfig() : deps.config;
  if (!config) return { configured: false, results: [] };
  const { data, error } = await deps.db.rpc("claim_linkedin_jobs", { p_limit: 5 });
  if (error) throw new Error("linkedin_claim_failed");
  const client = deps.client ?? new LinkedInClient(config);
  const results: { id: string; outcome: string }[] = [];
  for (const job of (data ?? []) as LinkedInJob[]) {
    const outcome = await publishClaimedLinkedInJob(deps.db, config, client, job);
    results.push({ id: job.id, outcome });
  }
  return { configured: true, results };
}
