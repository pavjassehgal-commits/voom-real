import "server-only";

import { listPublishQueue, type PublishQueueRow } from "@/lib/instagram/publish-queue";
import type { PerformanceReport } from "@/lib/performance/insights";
import { listPostDrafts, type PostView } from "@/lib/post/server-data";
import { listSocialDrafts, type SocialDraftView } from "@/lib/social/server-drafts";
import { publishStateFromInstagramQueue, SOCIAL_PUBLISH_STATE_LABELS, type SocialPublishState } from "@/lib/social/publish-state";
import type { createAdminClient } from "@/utils/supabase/admin";
import { contentBucket, type ContentItem } from "./content-library-core";

type AdminClient = ReturnType<typeof createAdminClient>;

export type { ContentItem, ContentBucket } from "./content-library-core";

/**
 * The Content library: every Instagram post and TikTok/YouTube draft the
 * owner has, read through the SAME owner-scoped readers the Studio uses
 * (`listPostDrafts`, `listSocialDrafts`), with the publish state taken from
 * the durable queues through the one canonical mapping in
 * lib/social/publish-state. Published means the provider confirmed it.
 * Read-only: nothing here writes.
 */
export async function loadContentLibrary(
  admin: AdminClient,
  ownerId: string,
  performance: PerformanceReport | null,
): Promise<{ items: ContentItem[]; limited: boolean }> {
  const [posts, social, queue] = await Promise.all([
    listPostDrafts(admin, ownerId),
    listSocialDrafts(admin, ownerId),
    listPublishQueue(admin, ownerId, 200),
  ]);
  const queueByDraft = new Map<string, PublishQueueRow>(queue.map((row) => [row.draft_id, row]));
  const metricsByDraft = new Map((performance?.items ?? []).filter((item) => item.draftId).map((item) => [item.draftId as string, item.metrics]));
  const items = [
    ...posts.map((post) => fromPost(post, queueByDraft.get(post.id) ?? null, metricsByDraft.get(post.id) ?? null)),
    ...social.map((draft) => fromSocial(draft)),
  ].sort((a, b) => b.sortAt.localeCompare(a.sortAt));
  // Both readers return at most their 50 most recent rows; the screen says so.
  return { items, limited: posts.length >= 50 || social.length >= 50 };
}

export function fromPost(post: PostView, queue: PublishQueueRow | null, metrics: Partial<Record<string, number>> | null): ContentItem {
  let state: SocialPublishState | "rejected";
  let label: string;
  if (post.status === "rejected") {
    state = "rejected"; label = "Rejected";
  } else if (post.status !== "approved") {
    state = "draft"; label = "Draft";
  } else {
    const fromQueue = queue ? publishStateFromInstagramQueue(queue.status) : null;
    if (fromQueue && fromQueue !== "draft") {
      state = fromQueue;
      label = queue?.status === "waiting_for_media" ? "Waiting for media" : SOCIAL_PUBLISH_STATE_LABELS[fromQueue];
    } else if (post.scheduledAt) {
      state = "scheduled"; label = post.internalStateLabel;
    } else {
      state = "approved"; label = "Approved · no time set";
    }
  }
  return {
    id: post.id,
    kind: post.kind,
    channel: "instagram",
    typeLabel: post.typeLabel,
    title: post.concept || "Untitled post",
    excerpt: post.caption,
    hashtags: post.hashtags,
    scheduledAt: queue?.scheduled_at ?? post.scheduledAt,
    createdAt: post.createdAt,
    updatedAt: post.updatedAt,
    sortAt: queue?.scheduled_at ?? post.scheduledAt ?? post.updatedAt,
    state,
    stateLabel: label,
    bucket: contentBucket(state),
    origin: post.origin,
    previewUrl: post.visual?.previewUrl && !post.visual.mimeType.startsWith("video") ? post.visual.previewUrl : null,
    mediaName: post.visual?.displayName || null,
    mediaReady: post.visualReady,
    failureMessage: queue?.failure_message ?? null,
    metrics: metrics ? { views: metrics.views ?? metrics.plays ?? null, likes: metrics.likes ?? null, comments: metrics.comments ?? null } : null,
    editor: "post",
  };
}

export function fromSocial(draft: SocialDraftView): ContentItem {
  const rejected = draft.status === "rejected";
  const state = rejected ? "rejected" : (draft.publishState as SocialPublishState);
  return {
    id: draft.id,
    kind: draft.kind,
    channel: draft.channel,
    typeLabel: draft.typeLabel,
    title: draft.title || draft.concept || "Untitled video",
    excerpt: draft.caption || draft.description || "",
    hashtags: [],
    scheduledAt: draft.scheduledAt,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    sortAt: draft.scheduledAt ?? draft.updatedAt,
    state,
    stateLabel: rejected ? "Rejected" : draft.publishStateLabel,
    bucket: contentBucket(state),
    origin: null,
    previewUrl: null,
    mediaName: draft.asset?.displayName ?? null,
    mediaReady: Boolean(draft.asset),
    failureMessage: draft.queueFailureMessage,
    metrics: null,
    editor: "social",
  };
}
