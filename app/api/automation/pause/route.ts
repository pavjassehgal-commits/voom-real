import { z } from "zod";
import { pauseAllAutomation } from "@/lib/voom/automation-safety";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

const schema = z.object({ idempotencyKey: z.string().min(16).max(200) }).strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "Invalid pause request." }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Invalid pause request." }, { status: 400 });
  try {
    const result = await pauseAllAutomation(createAdminClient(), user.id, parsed.data.idempotencyKey);
    return Response.json({ paused: true, ...result });
  } catch {
    return Response.json({ error: "Voom couldn't pause automation safely. Nothing was reported as stopped." }, { status: 503 });
  }
}
