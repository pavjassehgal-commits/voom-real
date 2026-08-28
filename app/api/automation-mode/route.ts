import { z } from "zod";
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
  const { error } = await db.from("businesses").update({ automation_level: parsed.data.mode }).eq("owner_user_id", user.id);
  if (error) return Response.json({ error: "Voom couldn't save that mode. Please retry." }, { status: 503 });
  return Response.json({ mode: parsed.data.mode, externalActionsRequirePermission: true });
}
