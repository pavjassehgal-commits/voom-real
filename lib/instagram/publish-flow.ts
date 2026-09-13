/**
 * The Instagram publish sequence, expressed against small injected ports.
 *
 * This module performs no I/O of its own and imports nothing server-only, so
 * the real publishing behaviour — container creation, readiness polling,
 * media_publish, duplicate protection, retries — is exercised directly by the
 * test suite with fake ports instead of touching Meta.
 *
 * lib/instagram/publish-worker.ts wires the real Supabase + Instagram
 * implementations into these ports.
 */

import {
  hasPublishPermission,
  isContainerFatal,
  isContainerReady,
  isPublishableMime,
  isVideoPublishMime,
  PUBLISH_POLL_CALL_ALLOWANCE_MS,
  pollingPlanFor,
  resolveFailure,
  retryAt,
  truncateCaption,
  type PublishFailureKey,
  type PublishMediaKind,
} from "./publishing.ts";
import type { PublishTimelineEvent, PublishTimelineInput } from "./publish-timeline.ts";

export interface FlowItem {
  id: string;
  ownerUserId: string;
  draftId: string;
  mediaKind: PublishMediaKind;
  caption: string;
  attempts: number;
  containerId: string | null;
  instagramMediaId: string | null;
}

export interface FlowPorts {
  /** Server-side re-resolution of the draft. */
  loadDraft(ownerId: string, draftId: string): Promise<{ status: string; content: string } | null>;
  /** Server-side re-resolution of the Instagram connection. */
  loadConnection(ownerId: string): Promise<{ status: string; scopes: string[]; tokenExpiresAt: string | null } | null>;
  /** Decrypted credentials. Throwing is treated as "not connected". */
  loadCredentials(ownerId: string): Promise<{ igUserId: string; accessToken: string }>;
  /** The private stored asset for this draft. */
  loadAsset(ownerId: string, draftId: string): Promise<{ storagePath: string; mimeType: string; status: string } | null>;
  /** Short-lived signed URL scoped to exactly that object. */
  signMediaUrl(storagePath: string): Promise<string | null>;
  createContainer(input: { kind: PublishMediaKind; accessToken: string; igUserId: string; mediaUrl: string; caption: string; video: boolean }): Promise<string>;
  containerStatus(accessToken: string, containerId: string): Promise<string>;
  publishContainer(input: { accessToken: string; igUserId: string; containerId: string }): Promise<string>;
  /** Read-only recovery for an ambiguous response. */
  findPublishedMediaId(accessToken: string, caption: string): Promise<string | null>;
  persistContainerId(item: FlowItem, containerId: string): Promise<void>;
  markPublished(item: FlowItem, instagramMediaId: string, containerId: string | null): Promise<void>;
  markFailed(item: FlowItem, input: { code: string; message: string; status: string; retryAt: string | null }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now?(): number;
  /**
   * Remaining wall-clock milliseconds this invocation may still spend inside
   * readiness polling. The worker derives it from a deadline computed against
   * the cron route's `maxDuration`; without it, the attempt's own poll budget
   * is the only bound. Polling stops rather than starting work that cannot
   * finish — being killed mid-`media_publish` is worse than a parked retry.
   */
  remainingBudgetMs?(): number;
  /**
   * Structured timeline diagnostics sink. Optional so the flow stays I/O-free;
   * the worker wires it to `logPublishTimeline`.
   */
  timeline?(event: PublishTimelineEvent, input: PublishTimelineInput): void;
}

export type FlowOutcome = { outcome: "published" | "failed" | "retrying"; code?: string; mediaId?: string };

export async function runPublishFlow(item: FlowItem, ports: FlowPorts): Promise<FlowOutcome> {
  const now = ports.now ? ports.now() : Date.now();
  const timeline = timelineFor(item, ports);
  // Read fresh, not from the snapshot above: the retry boundary must be
  // computed from when this attempt actually ENDED, so a long attempt cannot
  // park a retry on a boundary that has already passed.
  const endedAt = () => (ports.now ? ports.now() : Date.now());
  const remainingBudgetMs = () =>
    ports.remainingBudgetMs ? ports.remainingBudgetMs() : Number.POSITIVE_INFINITY;

  // 0) Already published. A rerun after success does nothing.
  if (item.instagramMediaId) return { outcome: "published", mediaId: item.instagramMediaId };

  // 1) Approval is re-checked server-side; a rejected/cancelled draft never posts.
  //
  // A draft Voom cannot READ is a different fact from a draft the user did not
  // approve. Only the latter is terminal: an unreadable draft is retried, so
  // one transient database blip can never permanently kill an approved
  // schedule by branding it "not approved".
  let draft: { status: string; content: string } | null;
  try {
    draft = await ports.loadDraft(item.ownerUserId, item.draftId);
  } catch {
    return fail(item, ports, timeline, endedAt, "draft_unavailable");
  }
  if (!draft) return fail(item, ports, timeline, endedAt, "draft_unavailable");
  if (draft.status !== "approved") {
    return fail(item, ports, timeline, endedAt, "not_approved_custom");
  }

  // 2) Connection + permission.
  const connection = await ports.loadConnection(item.ownerUserId);
  if (!connection || connection.status !== "connected") return fail(item, ports, timeline, endedAt, "not_connected");
  if (!hasPublishPermission(connection.scopes)) return fail(item, ports, timeline, endedAt, "permission_required");
  if (connection.tokenExpiresAt && Date.parse(connection.tokenExpiresAt) <= now) {
    return fail(item, ports, timeline, endedAt, "token_expired");
  }

  let credentials: { igUserId: string; accessToken: string };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    return fail(item, ports, timeline, endedAt, "not_connected");
  }

  // 3) Private media → short-lived signed URL.
  const asset = await ports.loadAsset(item.ownerUserId, item.draftId);
  if (!asset || asset.status !== "uploaded") return fail(item, ports, timeline, endedAt, "media_missing");
  if (!isPublishableMime(asset.mimeType)) return fail(item, ports, timeline, endedAt, "media_unsupported");
  const mediaUrl = await ports.signMediaUrl(asset.storagePath);
  if (!mediaUrl) return fail(item, ports, timeline, endedAt, "media_url_failed");

  // Meta's Story containers have no caption parameter — Instagram does not
  // support captions on Stories — so a Story never carries caption text into a
  // container or into the caption-based recovery read below.
  const caption = item.mediaKind === "story" ? "" : truncateCaption(item.caption || draft.content || "");
  // Video Stories transcode asynchronously exactly like Reels; image Stories
  // settle like feed images.
  const video = isVideoPublishMime(asset.mimeType);

  // 4) Container. Reused across attempts, never re-created.
  let containerId = item.containerId;
  if (!containerId) {
    try {
      containerId = await ports.createContainer({
        kind: item.mediaKind, accessToken: credentials.accessToken, igUserId: credentials.igUserId, mediaUrl, caption, video,
      });
    } catch {
      return fail(item, ports, timeline, endedAt, "container_failed");
    }
    if (!containerId) return fail(item, ports, timeline, endedAt, "container_failed");
    await ports.persistContainerId(item, containerId);
    timeline("container_created", { containerId });
  } else {
    // The whole point of persisting the container before publishing: a retry
    // resumes Meta's existing container instead of creating a second post.
    timeline("container_reused", { containerId });
  }

  // 5) Readiness. Video (Reels and video Stories) must reach FINISHED.
  //
  // The loop is bounded twice over: by the attempt's own poll plan, and by the
  // wall-clock budget this invocation still has. Neither bound can be reached
  // by looping forever.
  const plan = pollingPlanFor(video);
  const pollingStartedAt = endedAt();
  let ready = false;
  let polls = 0;
  for (let poll = 0; poll < plan.attempts; poll++) {
    // Never start a call that cannot finish inside the shared budget.
    if (remainingBudgetMs() < PUBLISH_POLL_CALL_ALLOWANCE_MS) break;
    let status: string;
    try {
      status = await ports.containerStatus(credentials.accessToken, containerId);
    } catch {
      timeline("poll", { containerId, poll: polls + 1, polls: polls + 1, elapsedMs: endedAt() - pollingStartedAt, budgetMs: remainingBudgetMs(), code: "container_timeout" });
      return fail(item, ports, timeline, endedAt, "container_timeout");
    }
    polls += 1;
    timeline("poll", { containerId, containerStatus: status, poll: polls, elapsedMs: endedAt() - pollingStartedAt, budgetMs: remainingBudgetMs() });
    if (status === "PUBLISHED") {
      // Meta says this container is already live: recover its media id rather
      // than ever calling media_publish on it a second time.
      const recovered = await safeRecover(ports, credentials.accessToken, caption);
      if (recovered) return publish(item, ports, timeline, recovered, containerId);
      return fail(item, ports, timeline, endedAt, "publish_failed");
    }
    if (isContainerFatal(status)) return fail(item, ports, timeline, endedAt, "container_error");
    if (isContainerReady(status)) {
      ready = true;
      break;
    }
    // The final poll gets no trailing sleep — it would only delay the retry.
    if (poll + 1 >= plan.attempts) break;
    // Not enough budget left for another wait: stop now and park a retry that
    // the next cron tick can claim, instead of overrunning the function.
    if (remainingBudgetMs() < plan.intervalMs) break;
    await ports.sleep(plan.intervalMs);
  }
  if (!ready) {
    timeline("polling_exhausted", {
      containerId,
      polls,
      elapsedMs: endedAt() - pollingStartedAt,
      budgetMs: remainingBudgetMs(),
    });
    return fail(item, ports, timeline, endedAt, "container_timeout");
  }
  timeline("container_ready", { containerId, polls, elapsedMs: endedAt() - pollingStartedAt });

  // 6) Publish, immediately — never deferred to another cron run. Only a
  //    returned media id makes this Published.
  timeline("publish_requested", { containerId });
  let mediaId: string | null = null;
  try {
    mediaId = await ports.publishContainer({ accessToken: credentials.accessToken, igUserId: credentials.igUserId, containerId });
  } catch {
    const recovered = await safeRecover(ports, credentials.accessToken, caption);
    if (recovered) return publish(item, ports, timeline, recovered, containerId);
    return fail(item, ports, timeline, endedAt, "publish_failed");
  }
  if (!mediaId) return fail(item, ports, timeline, endedAt, "publish_failed");

  return publish(item, ports, timeline, mediaId, containerId);
}

/** The only path that may write `published`: a media id Meta actually returned. */
async function publish(
  item: FlowItem,
  ports: FlowPorts,
  timeline: TimelineSink,
  mediaId: string,
  containerId: string,
): Promise<FlowOutcome> {
  timeline("media_id_received", { containerId, instagramMediaId: mediaId });
  await ports.markPublished(item, mediaId, containerId);
  timeline("marked_published", { containerId, instagramMediaId: mediaId });
  return { outcome: "published", mediaId };
}

async function safeRecover(ports: FlowPorts, accessToken: string, caption: string) {
  try {
    return await ports.findPublishedMediaId(accessToken, caption);
  } catch {
    return null;
  }
}

type TimelineSink = (event: PublishTimelineEvent, input?: PublishTimelineInput) => void;

/**
 * Binds the item's identity onto every event, so a log line never has to
 * repeat it and a caller can never log a different item's ids by accident.
 */
function timelineFor(item: FlowItem, ports: FlowPorts): TimelineSink {
  const base: PublishTimelineInput = {
    itemId: item.id,
    ownerUserId: item.ownerUserId,
    draftId: item.draftId,
    mediaKind: item.mediaKind,
    attempt: item.attempts,
  };
  if (!ports.timeline) return () => undefined;
  const sink = ports.timeline;
  return (event, input) => sink(event, { ...base, ...input });
}

async function fail(
  item: FlowItem,
  ports: FlowPorts,
  timeline: TimelineSink,
  endedAt: () => number,
  key: PublishFailureKey | "not_approved_custom",
): Promise<FlowOutcome> {
  if (key === "not_approved_custom") {
    await ports.markFailed(item, {
      code: "not_approved",
      message: "This content is no longer approved, so Voom did not publish it.",
      status: "failed",
      retryAt: null,
    });
    timeline("failed", { code: "not_approved" });
    return { outcome: "failed", code: "not_approved" };
  }
  const failure = resolveFailure(key, item.attempts);
  // Cron-aligned, never `now + N minutes`: see retryAt in ./publishing.ts.
  const nextRetryAt = failure.retryable ? retryAt(endedAt()) : null;
  await ports.markFailed(item, {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    retryAt: nextRetryAt,
  });
  timeline(failure.retryable ? "retry_scheduled" : "failed", { code: failure.code, retryAt: nextRetryAt });
  return { outcome: failure.retryable ? "retrying" : "failed", code: failure.code };
}
