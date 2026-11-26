import { readAutomationPauseState } from "@/lib/voom/automation-pause-state";
import { z } from "zod";
import { resumeAllAutomation } from "@/lib/voom/automation-safety";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

const schema = z.object({ idempotencyKey: z.string().min(16).max(200), confirm: z.literal(true) }).strict();

/**
 * Explicit owner resume after an emergency pause. The body must carry
 * `confirm: true`, so nothing resumes as a side effect of another request.
 * Cancelled Autopilot jobs and paused lifecycle flows are not restored.
 */
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid resume request." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid resume request." }, { status: 400 });
  try {
    const admin = createAdminClient();
    const result = await resumeAllAutomation(admin, user.id, parsed.data.idempotencyKey);
    const pauseState = await readAutomationPauseState(admin, user.id);
    return Response.json({
      resumed: true,
      pauseState,
      ...result,
      message: result.modeAllowedByPlan
        ? "Automation resumed for new work. Cancelled posts need a fresh explicit owner approval; paused email flows must be restarted individually."
        : "The pause is lifted, but your current plan doesn't include this automation mode, so MARA won't act automatically until you change mode or plan.",
    });
  } catch {
    return Response.json({ error: "Voom couldn't confirm the resume. Please retry — repeating this request is safe." }, { status: 503 });
  }
}
