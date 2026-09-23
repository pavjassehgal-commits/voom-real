import { getCurrentUser } from "@/lib/voom/server-data";
import { mediaSpendRunNotice } from "@/lib/mara/media-spend";
import { loadWorkflowSnapshot } from "@/lib/voom/workflow/read";
import { runOwnerWorkflow } from "@/lib/voom/workflow/service";
import { normalizeCadence, CADENCES } from "@/lib/voom/cadence";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * The Marketing Plan is a view over the ONE executable content workflow: the
 * rolling, cadence-aware horizon of real workflow items starting on the
 * account's real current local date. There is no separate plan state machine
 * and no stale demo content.
 */
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const snapshot = await loadWorkflowSnapshot(createAdminClient(), user.id);
  return Response.json({ snapshot }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * Builds or replenishes the rolling plan on demand ("Build plan" /
 * "Replenish plan" / a posting-frequency change).
 *
 * The run executes under the account's SAVED automation mode — the route never
 * chooses a mode, so a Manual account is never coerced into an Assisted-style
 * run. The central policy (`mayAutomaticallyGeneratePaidMedia`) then decides
 * what an explicit Replenish may do:
 *   Manual    → planning-only: drafts + copy, NO paid media, approval,
 *               scheduling or queueing. Media starts only from Create with MARA.
 *   Assisted  → drafts + copy, then waits for the owner to produce media
 *               before approval; no automatic paid media.
 *   Autopilot → may generate media within the existing budget/permission
 *               guards, then safety-checks before approval and scheduling.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const admin = createAdminClient();

  let cadence: ReturnType<typeof normalizeCadence> | undefined;
  // Planning-only execution: the owner runs the real cadence-aware rolling
  // planner and persists the upcoming drafts, but the run stops before paid
  // media generation, approval, scheduling and Instagram queueing. Only the
  // exact "planning_only" value narrows the run; anything else keeps the
  // existing full behaviour for Assisted/Autopilot (a Manual account is
  // planning-only either way — the body can only narrow a run, never widen
  // it past the mode's policy). No owner identity is ever read from the body —
  // the run always operates on the authenticated owner below.
  let stage: "planning_only" | undefined;
  try {
    const body = await request.json() as { cadence?: unknown; stage?: unknown };
    if (typeof body.cadence === "string" && (CADENCES as readonly string[]).includes(body.cadence)) {
      cadence = normalizeCadence(body.cadence);
    }
    if (body.stage === "planning_only") stage = "planning_only";
  } catch { /* an empty body is fine */ }

  // Modest rate limit: plan building calls MARA and media providers.
  const since = new Date(Date.now() - 10 * 60_000).toISOString();
  const { count } = await admin.from("mara_media_generations")
    .select("id", { count: "exact", head: true }).eq("owner_user_id", user.id).gte("created_at", since);
  if ((count ?? 0) >= 30) {
    return Response.json({ error: "Voom is already building your content. Give it a few minutes." }, { status: 429 });
  }

  try {
    // An explicit owner request is the "replenish" trigger. The service reads
    // the account's saved mode itself; Manual stays Manual throughout.
    const run = await runOwnerWorkflow(admin, { ownerId: user.id, cadence, stage, trigger: "replenish" });
    const snapshot = await loadWorkflowSnapshot(admin, user.id);
    // AI Media Spend Control: a refused automatic generation is NOT a failed
    // run — the plan, copy and drafts were created and only the media waits.
    // The owner is told the truthful reason (disabled / budget reached).
    const mediaSpendNotice = mediaSpendRunNotice(run.failures);
    return Response.json({ run, snapshot, mediaSpendNotice });
  } catch {
    return Response.json({ error: "Voom couldn't build your plan right now. Your existing work is safe—please retry." }, { status: 503 });
  }
}
