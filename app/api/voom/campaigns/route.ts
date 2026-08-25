import { getCurrentUser } from "@/lib/voom/server-data";
import { listCampaigns } from "@/lib/mara/internal-data";
import { createClient } from "@/utils/supabase/server";

export async function GET(request: Request) {
  const user = await getCurrentUser(); if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const kind = new URL(request.url).searchParams.get("kind") || undefined;
  if (kind && kind !== "email" && kind !== "sms") return Response.json({ error: "That campaign type is invalid." }, { status: 400 });
  try { return Response.json({ campaigns: await listCampaigns(await createClient(), user.id, kind) }); }
  catch { return Response.json({ error: "Campaigns couldn't load. Please retry." }, { status: 503 }); }
}
