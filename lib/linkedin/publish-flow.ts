import "server-only";
import { LinkedInError, isPostUrn, type LinkedInFailure } from "./client.ts";

export interface LinkedInJob {
  id: string; owner_user_id: string; draft_id: string; connection_id: string; member_sub: string;
  caption: string; claim_token: string;
}
export interface LinkedInPublishPorts {
  credentials(job: LinkedInJob): Promise<string>;
  start(job: LinkedInJob): Promise<boolean>;
  publish(token: string, member: string, caption: string): Promise<string>;
  finish(job: LinkedInJob, outcome: "published" | LinkedInFailure, ref?: string): Promise<void>;
}
export async function runLinkedInPublishFlow(job: LinkedInJob, ports: LinkedInPublishPorts): Promise<string> {
  let started = false;
  let ref: string;
  try {
    const token = await ports.credentials(job);
    if (!await ports.start(job)) return "blocked";
    started = true;
    ref = await ports.publish(token, job.member_sub, job.caption);
    if (!isPostUrn(ref)) throw new LinkedInError("uncertain");
  } catch (error) {
    const outcome = error instanceof LinkedInError ? error.category : started ? "uncertain" : "unavailable";
    await ports.finish(job, outcome);
    return outcome;
  }
  // Never turn a failed DB completion into a retry of an accepted provider POST.
  // Stale 'submitting' jobs become 'uncertain', never automatically resubmitted.
  await ports.finish(job, "published", ref);
  return "published";
}
