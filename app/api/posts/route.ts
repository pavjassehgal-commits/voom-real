import { getCurrentUser } from "@/lib/voom/server-data";
import { isPostDraftKind, isPostOrigin, isSocialVideoDraftKind, normalizePostFormat, normalizeSchedule, POST_ORIGINS, type PostDraftKind, type PostOrigin, type SocialVideoDraftKind } from "@/lib/post/core";
import { createPostDraft, listPostDrafts } from "@/lib/post/server-data";
import { createSocialDraft, listSocialDrafts } from "@/lib/social/server-drafts";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

export const runtime = "nodejs";

const createPost = z.object({
  kind: z.enum(["instagram_post", "reel", "story", "tiktok_video", "youtube_short", "youtube_video"]),
  origin: z.enum(POST_ORIGINS),
  concept: z.string().trim().min(1).max(160),
  caption: z.string().trim().max(4000).optional(),
  cta: z.string().trim().max(160).optional(),
  hashtags: z.array(z.string().trim().max(40)).max(20).optional(),
  format: z.enum(["1:1", "4:5", "9:16"]).optional(),
  // Multi-Social Core: the structured TikTok/YouTube deliverable.
  description: z.string().trim().max(5000).optional(),
  script: z.array(z.string().trim().max(400)).max(40).optional(),
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  try {
    // One Studio: the Instagram drafts and the TikTok/YouTube planning drafts
    // are listed together, newest first, each with its truthful state.
    const admin = createAdminClient();
    const [posts, social] = await Promise.all([
      listPostDrafts(admin, user.id),
      listSocialDrafts(admin, user.id),
    ]);
    const merged = [
      ...posts,
      ...social.map((draft) => ({
        id: draft.id,
        kind: draft.kind,
        typeLabel: draft.typeLabel,
        concept: draft.concept ?? draft.title,
        format: draft.format === "short" ? "9:16" : draft.channel === "tiktok" ? "9:16" : "16:9",
        originLabel: "Create myself",
        internalState: draft.status === "approved" ? "approved" : "draft",
        internalStateLabel: draft.publishStateLabel,
        scheduledAt: draft.scheduledAt,
        visualReady: Boolean(draft.asset),
        visual: null,
        updatedAt: draft.updatedAt,
      })),
    ].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return Response.json({ posts: merged }, { headers: { "Cache-Control": "no-store" } });
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

  const scheduledAt = normalizeSchedule(parsed.data.scheduledAt ?? null);
  if (scheduledAt && Date.parse(scheduledAt) < Date.now() - 5 * 60_000) {
    return Response.json({ error: "Choose a date in the future to schedule this." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    // Multi-Social Core: TikTok/YouTube planning drafts. Creating one spends
    // no credit, generates no media and connects no provider.
    if (isSocialVideoDraftKind(parsed.data.kind)) {
      const id = await createSocialDraft(admin, user.id, {
        kind: parsed.data.kind as SocialVideoDraftKind,
        title: parsed.data.concept,
        caption: parsed.data.caption,
        description: parsed.data.description,
        script: parsed.data.script,
        scheduledAt,
      });
      return Response.json({ id, message: "Draft created inside Voom. Nothing was published." }, { status: 201 });
    }

    const kind = parsed.data.kind as PostDraftKind;
    const origin = parsed.data.origin as PostOrigin;
    if (!isPostDraftKind(kind) || !isPostOrigin(origin)) return Response.json({ error: "That content type is not available." }, { status: 400 });

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
