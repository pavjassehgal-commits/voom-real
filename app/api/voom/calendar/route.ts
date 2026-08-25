import { getCurrentUser } from "@/lib/voom/server-data";
import { listCalendarItems } from "@/lib/mara/internal-data";
import { createClient } from "@/utils/supabase/server";

export async function GET(request: Request) {
  const user = await getCurrentUser(); if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const url = new URL(request.url); const start = url.searchParams.get("start"); const end = url.searchParams.get("end"); const channel = url.searchParams.get("channel") || undefined;
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
  try { return Response.json({ items: await listCalendarItems(await createClient(), user.id, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), channel }) }); }
  catch { return Response.json({ error: "The calendar couldn't load. Please retry." }, { status: 503 }); }
}
