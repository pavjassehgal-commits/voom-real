import { getCurrentUser } from "@/lib/voom/server-data";
import { isPostDraftKind, isPostOrigin, normalizePostFormat, normalizeSchedule, POST_ORIGINS, type PostDraftKind, type PostOrigin } from "@/lib/post/core";
import { createPostDraft, listPostDrafts } from "@/lib/post/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const createPost = z.object({
  kind: z.enum(["instagram_post", "reel", "story"]),
  origin: z.enum(POST_ORIGINS),
  concept: z.string().trim().min(1).max(160),
  caption: z.string().trim().max(2200).optional(),
  cta: z.string().trim().max(160).optional(),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
  format: z.enum(["1:1", "4:5", "9:16"]).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    return Response.json({ posts: await listPostDrafts(createAdminClient(), user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Voom couldn't load your content. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That request was not valid." }, { status: 400 }); }
  const parsed = createPost.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the content type, source and title before creating." }, { status: 400 });

  const kind = parsed.data.kind as PostDraftKind;
  const origin = parsed.data.origin as PostOrigin;
  if (!isPostDraftKind(kind) || !isPostOrigin(origin)) return Response.json({ error: "That content type is not available." }, { status: 400 });

  const scheduledAt = normalizeSchedule(parsed.data.scheduledAt ?? null);
  if (scheduledAt && Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
    return Response.json({ error: "Choose a date in the future to schedule this." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();
    const id = await createPostDraft(admin, user.id, {
      kind,
      origin,
      concept: parsed.data.concept,
      caption: parsed.data.caption,
      cta: parsed.data.cta,
      hashtags: parsed.data.hashtags,
      format: normalizePostFormat(parsed.data.format),
      scheduledAt,
    });
    return Response.json({ id, message: "Draft created inside Voom. Nothing was published." }, { status: 201 });
  } catch {
    return Response.json({ error: "Voom couldn't create that draft. Please retry." }, { status: 503 });
  }
}
