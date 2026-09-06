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
  IMAGE_POLL_ATTEMPTS,
  IMAGE_POLL_INTERVAL_MS,
  hasPublishPermission,
  isContainerFatal,
  isContainerReady,
  isPublishableMime,
  REEL_POLL_ATTEMPTS,
  REEL_POLL_INTERVAL_MS,
  resolveFailure,
  retryAt,
  truncateCaption,
  type PublishFailureKey,
  type PublishMediaKind,
} from "./publishing.ts";

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
  createContainer(input: { kind: PublishMediaKind; accessToken: string; igUserId: string; mediaUrl: string; caption: string }): Promise<string>;
  containerStatus(accessToken: string, containerId: string): Promise<string>;
  publishContainer(input: { accessToken: string; igUserId: string; containerId: string }): Promise<string>;
  /** Read-only recovery for an ambiguous response. */
  findPublishedMediaId(accessToken: string, caption: string): Promise<string | null>;
  persistContainerId(item: FlowItem, containerId: string): Promise<void>;
  markPublished(item: FlowItem, instagramMediaId: string, containerId: string | null): Promise<void>;
  markFailed(item: FlowItem, input: { code: string; message: string; status: string; retryAt: string | null }): Promise<void>;
  sleep(ms: number): Promise<void>;
  now?(): number;
}

export type FlowOutcome = { outcome: "published" | "failed" | "retrying"; code?: string; mediaId?: string };

export async function runPublishFlow(item: FlowItem, ports: FlowPorts): Promise<FlowOutcome> {
  const now = ports.now ? ports.now() : Date.now();

  // 0) Already published. A rerun after success does nothing.
  if (item.instagramMediaId) return { outcome: "published", mediaId: item.instagramMediaId };

  // 1) Approval is re-checked server-side; a rejected/cancelled draft never posts.
  const draft = await ports.loadDraft(item.ownerUserId, item.draftId);
  if (!draft || draft.status !== "approved") {
    return fail(item, ports, "not_approved_custom", now);
  }

  // 2) Connection + permission.
  const connection = await ports.loadConnection(item.ownerUserId);
  if (!connection || connection.status !== "connected") return fail(item, ports, "not_connected", now);
  if (!hasPublishPermission(connection.scopes)) return fail(item, ports, "permission_required", now);
  if (connection.tokenExpiresAt && Date.parse(connection.tokenExpiresAt) <= now) {
    return fail(item, ports, "token_expired", now);
  }

  let credentials: { igUserId: string; accessToken: string };
  try {
    credentials = await ports.loadCredentials(item.ownerUserId);
  } catch {
    return fail(item, ports, "not_connected", now);
  }

  // 3) Private media → short-lived signed URL.
  const asset = await ports.loadAsset(item.ownerUserId, item.draftId);
  if (!asset || asset.status !== "uploaded") return fail(item, ports, "media_missing", now);
  if (!isPublishableMime(asset.mimeType)) return fail(item, ports, "media_unsupported", now);
  const mediaUrl = await ports.signMediaUrl(asset.storagePath);
  if (!mediaUrl) return fail(item, ports, "media_url_failed", now);

  const caption = truncateCaption(item.caption || draft.content || "");

  // 4) Container. Reused across attempts, never re-created.
  let containerId = item.containerId;
  if (!containerId) {
    try {
      containerId = await ports.createContainer({
        kind: item.mediaKind, accessToken: credentials.accessToken, igUserId: credentials.igUserId, mediaUrl, caption,
      });
    } catch {
      return fail(item, ports, "container_failed", now);
    }
    if (!containerId) return fail(item, ports, "container_failed", now);
    await ports.persistContainerId(item, containerId);
  }

  // 5) Readiness. Reels transcode asynchronously and must reach FINISHED.
  const attempts = item.mediaKind === "reel" ? REEL_POLL_ATTEMPTS : IMAGE_POLL_ATTEMPTS;
  const interval = item.mediaKind === "reel" ? REEL_POLL_INTERVAL_MS : IMAGE_POLL_INTERVAL_MS;
  let ready = false;
  for (let attempt = 0; attempt < attempts; attempt++) {
    let status: string;
    try {
      status = await ports.containerStatus(credentials.accessToken, containerId);
    } catch {
      return fail(item, ports, "container_timeout", now);
    }
    if (status === "PUBLISHED") {
      const recovered = await safeRecover(ports, credentials.accessToken, caption);
      if (recovered) {
        await ports.markPublished(item, recovered, containerId);
        return { outcome: "published", mediaId: recovered };
      }
      return fail(item, ports, "publish_failed", now);
    }
    if (isContainerFatal(status)) return fail(item, ports, "container_error", now);
    if (isContainerReady(status)) { ready = true; break; }
    await ports.sleep(interval);
  }
  if (!ready) return fail(item, ports, "container_timeout", now);

  // 6) Publish. Only a returned media id makes this Published.
  let mediaId: string | null = null;
  try {
    mediaId = await ports.publishContainer({ accessToken: credentials.accessToken, igUserId: credentials.igUserId, containerId });
  } catch {
    const recovered = await safeRecover(ports, credentials.accessToken, caption);
    if (recovered) {
      await ports.markPublished(item, recovered, containerId);
      return { outcome: "published", mediaId: recovered };
    }
    return fail(item, ports, "publish_failed", now);
  }
  if (!mediaId) return fail(item, ports, "publish_failed", now);

  await ports.markPublished(item, mediaId, containerId);
  return { outcome: "published", mediaId };
}

async function safeRecover(ports: FlowPorts, accessToken: string, caption: string) {
  try {
    return await ports.findPublishedMediaId(accessToken, caption);
  } catch {
    return null;
  }
}

async function fail(item: FlowItem, ports: FlowPorts, key: PublishFailureKey | "not_approved_custom", now: number): Promise<FlowOutcome> {
  if (key === "not_approved_custom") {
    await ports.markFailed(item, {
      code: "not_approved",
      message: "This content is no longer approved, so Voom did not publish it.",
      status: "failed",
      retryAt: null,
    });
    return { outcome: "failed", code: "not_approved" };
  }
  const failure = resolveFailure(key, item.attempts);
  await ports.markFailed(item, {
    code: failure.code,
    message: failure.message,
    status: failure.status,
    retryAt: failure.retryable ? retryAt(item.attempts, now) : null,
  });
  return { outcome: failure.retryable ? "retrying" : "failed", code: failure.code };
}
