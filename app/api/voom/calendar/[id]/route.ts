import { getCalendarItem } from "@/lib/mara/internal-data";
import { resolveCalendarContentType } from "@/lib/post/server-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That calendar item was not found." }, { status: 404 });

  try {
    const item = await getCalendarItem(await createClient(), user.id, id);
    if (!item) return Response.json({ error: "That calendar item was not found." }, { status: 404 });
    // Post Studio entries are labelled by the draft they came from, so the
    // calendar can tell an Instagram Post, a Reel and imported existing
    // content apart. Non-Post-Studio entries stay unlabelled.
    const contentType = await resolveCalendarContentType(createAdminClient(), user.id, item.source_draft_id);
    return Response.json({
      item: {
        title: item.title,
        channel: item.channel,
        content: item.content,
        publishAt: item.publish_at,
        status: item.status,
        contentType,
        source: item.source_draft_id ? "MARA recommendation · approved in Voom" : null,
        createdAt: item.created_at,
        updatedAt: item.updated_at,
      },
    });
  } catch {
    return Response.json({ error: "That calendar item couldn't load. Please retry." }, { status: 503 });
  }
}
