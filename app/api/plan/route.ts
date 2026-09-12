import { getCurrentUser } from "@/lib/voom/server-data";
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

/** Builds or replenishes the rolling plan on demand. */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const admin = createAdminClient();

  let cadence: ReturnType<typeof normalizeCadence> | undefined;
  // Planning-only execution: the owner runs the real cadence-aware rolling
  // planner and persists the upcoming drafts, but the run stops before paid
  // media generation, approval, scheduling and Instagram queueing. Only the
  // exact "planning_only" value narrows the run; anything else keeps the
  // existing full behaviour. No owner identity is ever read from the body —
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
    // Manual accounts explicitly asking for a plan get an assisted-style run:
    // drafts are created, and nothing leaves Voom without their approval.
    const { data: business } = await admin.from("businesses").select("automation_level")
      .eq("owner_user_id", user.id).maybeSingle();
    const mode = business?.automation_level === "autopilot" ? "autopilot" as const : "assisted" as const;
    const run = await runOwnerWorkflow(admin, { ownerId: user.id, cadence, mode, stage });
    const snapshot = await loadWorkflowSnapshot(admin, user.id);
    return Response.json({ run, snapshot });
  } catch {
    return Response.json({ error: "Voom couldn't build your plan right now. Your existing work is safe—please retry." }, { status: 503 });
  }
}
