import "server-only";

import { getPostDraft } from "@/lib/post/server-data";
import { readSocialChannelReadiness } from "@/lib/social/readiness";
import { getSocialDraft } from "@/lib/social/server-drafts";
import type { createAdminClient } from "@/utils/supabase/admin";
import { resolveContentDetail } from "./content-library-core";
import type { CreateDraft } from "./create-readiness";

type AdminClient = ReturnType<typeof createAdminClient>;

/** Loads one owner-scoped draft for the Create flow through the existing readers. */
export async function loadCreateDraft(admin: AdminClient, ownerId: string, id: string): Promise<{ draft: CreateDraft; connected: boolean | null } | null> {
  // Social drafts first: the post reader would show a TikTok/YouTube draft as an Instagram post.
  const found = await resolveContentDetail(id, {
    social: (draftId) => getSocialDraft(admin, ownerId, draftId),
    post: (draftId) => getPostDraft(admin, ownerId, draftId),
  }).catch(() => null);
  if (!found) return null;
  const { post, social } = found;
  const readiness = await readSocialChannelReadiness(admin, ownerId).catch(() => []);
  const channel = post ? "instagram" : social!.channel;
  const connection = readiness.find((entry) => entry.channel === channel);
  const draft: CreateDraft = post ? {
    id: post.id, editor: "post", kind: post.kind, channel: "instagram", typeLabel: post.typeLabel,
    title: post.concept, caption: post.caption, description: null, hashtags: post.hashtags, format: post.format,
    previewUrl: post.visual?.previewUrl ?? null, mimeType: post.visual?.mimeType ?? null, mediaName: post.visual?.displayName || null,
    mediaReady: post.visualReady, status: post.status, scheduledAt: post.scheduledAt,
    privacy: null, madeForKids: null, tiktokPrivacy: null, tiktokConsent: false,
  } : {
    id: social!.id, editor: "social", kind: social!.kind, channel: social!.channel, typeLabel: social!.typeLabel,
    title: social!.title, caption: social!.caption, description: social!.description, hashtags: [], format: social!.format,
    previewUrl: null, mimeType: social!.asset?.mimeType ?? null, mediaName: social!.asset?.displayName ?? null,
    mediaReady: Boolean(social!.asset), status: social!.status, scheduledAt: social!.scheduledAt,
    privacy: social!.privacy, madeForKids: social!.madeForKids, tiktokPrivacy: social!.tiktokPrivacy, tiktokConsent: Boolean(social!.tiktokPost),
  };
  return { draft, connected: connection ? connection.connected : null };
}
