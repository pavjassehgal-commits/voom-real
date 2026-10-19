import { z } from "zod";
import { automationModeChangeEffect, normalizeAutomationMode } from "@/lib/voom/automation";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

const schema = z.object({ mode: z.enum(["manual", "assisted", "autopilot"]) }).strict();

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  let value: unknown;
  try { value = await request.json(); } catch { return Response.json({ error: "Choose a valid automation mode." }, { status: 400 }); }
  const parsed = schema.safeParse(value);
  if (!parsed.success) return Response.json({ error: "Choose a valid automation mode." }, { status: 400 });
  const db = await createClient();
  // The previous mode is read first so the response can describe the change
  // truthfully. A mode switch governs FUTURE automation only: it never
  // withdraws approvals, cancels schedules the user already accepted, or
  // deletes media they already paid for.
  const { data: current } = await db.from("businesses").select("automation_level").eq("owner_user_id", user.id).maybeSingle();
  const previousMode = normalizeAutomationMode((current as { automation_level?: string | null } | null)?.automation_level);

  const { error } = await db.from("businesses").update({ automation_level: parsed.data.mode }).eq("owner_user_id", user.id);
  if (error) return Response.json({ error: "Voom couldn't save that mode. Please retry." }, { status: 503 });

  const effect = automationModeChangeEffect(previousMode, parsed.data.mode);
  return Response.json({
    mode: parsed.data.mode,
    previousMode,
    externalActionsRequirePermission: true,
    appliesTo: "future_automation_only",
    ...effect,
  });
}
