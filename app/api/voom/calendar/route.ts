import { getCurrentUser } from "@/lib/voom/server-data";
import { createCalendarItem, listCalendarItems } from "@/lib/mara/internal-data";
import { resolveCalendarContentTypes } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { z } from "zod";

const createItem = z.object({
  title: z.string().trim().min(1).max(160),
  channel: z.enum(["Instagram", "Reel", "Feed", "Email", "SMS"]),
  content: z.string().trim().max(12000).default(""),
  topic: z.string().trim().max(500).default(""),
  publishAt: z.string().datetime({ offset: true }),
  status: z.enum(["draft", "scheduled"]),
}).strict();

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const url = new URL(request.url);
  const start = url.searchParams.get("start");
  const end = url.searchParams.get("end");
  const channel = url.searchParams.get("channel") || undefined;
  if (!start || !end || Number.isNaN(Date.parse(start)) || Number.isNaN(Date.parse(end))) return Response.json({ error: "Choose a valid date range." }, { status: 400 });
  try {
    const items = await listCalendarItems(await createClient(), user.id, { start: new Date(start).toISOString(), end: new Date(end).toISOString(), channel });
    // Post Studio entries carry a content type (Instagram Post / Reel /
    // Existing content) so the calendar can tell them apart.
    const labels = await resolveCalendarContentTypes(
      createAdminClient(), user.id, items.map((item) => item.source_draft_id as string | null),
    );
    return Response.json({
      items: items.map((item) => ({
        id: item.id, title: item.title, channel: item.channel, publish_at: item.publish_at, status: item.status,
        contentType: labels.get(String(item.source_draft_id)) ?? null,
      })),
    });
  } catch {
    return Response.json({ error: "The calendar couldn't load. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That content is not valid." }, { status: 400 }); }
  const parsed = createItem.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the title, caption, channel and date before saving." }, { status: 400 });

  const publishAt = new Date(parsed.data.publishAt).toISOString();
  if (parsed.data.status === "scheduled" && new Date(publishAt).getTime() < Date.now() - 5 * 60_000) {
    return Response.json({ error: "Choose a date in the future to schedule this post." }, { status: 400 });
  }

  try {
    const item = await createCalendarItem(await createClient(), user.id, {
      title: parsed.data.title,
      channel: parsed.data.channel,
      content: parsed.data.content,
      topic: parsed.data.topic,
      publish_at: publishAt,
      status: parsed.data.status,
    });
    return Response.json({ item }, { status: 201 });
  } catch {
    return Response.json({ error: "Voom couldn't save that calendar item. Please retry." }, { status: 503 });
  }
}
