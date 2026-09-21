/**
 * Voom Multi-Social Core — the internal provider publishing boundary.
 *
 * Conceptually:
 *
 *   SocialPublisher ──► InstagramPublisher   (the existing, proven flow)
 *                   ──► YouTubePublisher     (real: the 0047 durable queue)
 *                   ──► TikTokPublisher      (truthfully unavailable)
 *
 * The rest of Voom never touches provider upload mechanics; it hands content
 * to this boundary and receives ONE truthful outcome shape.
 *
 * Truthfulness contract (enforced by the test suite):
 *   - An adapter may ONLY report `published` together with a real provider
 *     publication reference that the provider itself returned.
 *   - TikTok has no real integration yet. Its adapter returns
 *     `connection_required` / `provider_not_supported` — never a fake
 *     success, never a fabricated provider id, never invented API behavior.
 *     No endpoint, scope, token or webhook is imagined anywhere in this file.
 *   - The Instagram adapter does NOT re-implement the sensitive token and
 *     publish code. It delegates to the existing durable architecture:
 *     `instagram_publish_queue` + the port-based publish flow
 *     (lib/instagram/publish-flow.ts) whose `published` state already means
 *     "Meta returned a real media id".
 *   - The YouTube adapter follows the same shape: it delegates to the durable
 *     `youtube_publish_queue` (migration 0047) + the port-based resumable
 *     upload flow (lib/youtube/publish-flow.ts) whose `published` state
 *     already means "YouTube returned a real video id AND its own
 *     processingDetails.uploadStatus='processed'". Enqueued is never
 *     published; approval is never publication.
 *
 * This module imports no network client. The Instagram enqueue dependency is
 * injected, so the whole boundary is executable offline by the Node suite.
 */

import "server-only";

import {
  CHANNEL_PUBLISHING_AVAILABILITY,
  isSocialMediaChannel,
  SOCIAL_CHANNEL_LABELS,
  type SocialMediaChannel,
} from "./channels";
import { mayEstablishPublished, type SocialPublishState } from "./publish-state";

/** One content item handed to the boundary. */
export interface SocialPublishRequest {
  ownerId: string;
  channel: SocialMediaChannel;
  /** Canonical format for the channel (validated by the caller's schema). */
  format: string;
  /** The Voom-side content identity (mara_drafts.id). */
  draftId: string;
  caption: string;
  /** ISO instant the item is scheduled for. */
  scheduledAt: string;
  /** Content Calendar row this execution mirrors, when one exists. */
  calendarItemId?: string | null;
  /**
   * YouTube's required videos.insert metadata, supplied by the caller from
   * the draft's own structured content (never invented here). Policy-sensitive
   * values (privacy, made-for-kids) may be null: the YouTube queue then parks
   * the item in `needs_declaration` instead of guessing.
   */
  youtube?: {
    title?: string;
    description?: string;
    privacyStatus?: string | null;
    madeForKids?: boolean | null;
    categoryId?: string | null;
    waitingForMedia?: boolean;
  };
}

/**
 * The ONE truthful outcome shape. Exactly one of:
 *  - `enqueued`             execution is now owned by a durable provider queue
 *                           (Instagram). This is NOT published.
 *  - `published`            the provider itself confirmed publication and
 *                           returned `providerRef`.
 *  - `failed`               a real attempt failed.
 *  - `connection_required`  the account has no usable provider connection.
 *  - `provider_not_supported` Voom has no real integration for the channel.
 */
export type SocialPublishOutcome =
  | { status: "enqueued"; channel: SocialMediaChannel; queueRef: string | null; message: string }
  | { status: "published"; channel: SocialMediaChannel; providerRef: string }
  | { status: "failed"; channel: SocialMediaChannel; code: string; message: string }
  | { status: "connection_required"; channel: SocialMediaChannel; message: string }
  | { status: "provider_not_supported"; channel: SocialMediaChannel; message: string };

/** The contract every channel adapter implements. */
export interface SocialPublisher {
  readonly channel: SocialMediaChannel;
  /**
   * Truthful availability. `false` guarantees `publish` will not report
   * success. An adapter whose provider integration does not exist returns
   * false unconditionally.
   */
  isAvailable(): boolean;
  publish(request: SocialPublishRequest): Promise<SocialPublishOutcome>;
}

/** The dependency the Instagram adapter needs: the EXISTING durable queue. */
export interface InstagramEnqueuePort {
  enqueuePublishItem(input: {
    ownerId: string;
    draftId: string;
    calendarItemId: string | null;
    mediaKind: "image" | "reel" | "story";
    caption: string;
    scheduledAt: string;
    waitingForMedia?: boolean;
  }): Promise<{ id: string } | null>;
}

/** Canonical format → the existing queue's media kind (0022 vocabulary). */
export function instagramMediaKindForFormat(format: string): "image" | "reel" | "story" | null {
  if (format === "post") return "image";
  if (format === "reel") return "reel";
  if (format === "story") return "story";
  return null;
}

/**
 * InstagramPublisher — a thin adapter over the proven production flow.
 *
 * It performs no Meta call itself: enqueuing puts the item on the same
 * `instagram_publish_queue` the existing cron worker claims, and only that
 * worker can ever move the row to `published`, with a real Meta media id.
 * This preserves the existing token handling, retry, idempotency and
 * duplicate-publish guarantees untouched.
 */
export function createInstagramPublisher(port: InstagramEnqueuePort): SocialPublisher {
  return {
    channel: "instagram",
    isAvailable: () => true,
    async publish(request) {
      const mediaKind = instagramMediaKindForFormat(request.format);
      if (!mediaKind) {
        return {
          status: "failed",
          channel: "instagram",
          code: "unsupported_format",
          message: `Instagram cannot publish the format "${request.format}".`,
        };
      }
      const row = await port.enqueuePublishItem({
        ownerId: request.ownerId,
        draftId: request.draftId,
        calendarItemId: request.calendarItemId ?? null,
        mediaKind,
        caption: request.caption,
        scheduledAt: request.scheduledAt,
      });
      if (!row) {
        return {
          status: "failed",
          channel: "instagram",
          code: "enqueue_failed",
          message: "Voom could not place this item on the Instagram publish queue.",
        };
      }
      // Truthful: enqueued is NOT published. The queue's own state machine
      // (and Meta's confirmation inside the worker) decide what happens next.
      return {
        status: "enqueued",
        channel: "instagram",
        queueRef: row.id,
        message: "On the Instagram publish queue. Publishing happens at the scheduled time; Published appears only after Instagram confirms.",
      };
    },
  };
}

/**
 * The truthful adapter for a channel whose real provider integration does not
 * exist yet. It makes no network call, stores no token, invents no API, and
 * can never report success. When the real TikTok / YouTube integrations are
 * built (in their own focused tasks, against the authoritative provider
 * documentation), each gets a real adapter implementing the same contract —
 * nothing else in Voom changes.
 */
export function createUnavailablePublisher(channel: SocialMediaChannel, opts?: { notConfigured?: boolean }): SocialPublisher {
  const availability = CHANNEL_PUBLISHING_AVAILABILITY[channel];
  return {
    channel,
    isAvailable: () => false,
    async publish(): Promise<SocialPublishOutcome> {
      return {
        status: opts?.notConfigured ? "provider_not_supported" : "connection_required",
        channel,
        message: availability.reason,
      };
    },
  };
}

/** TikTok adapter — truthful until the real integration ships. */
export function createTikTokPublisher(): SocialPublisher {
  return createUnavailablePublisher("tiktok");
}

/**
 * The dependency the YouTube adapter needs: the durable YouTube publish
 * queue (migration 0047). Like the Instagram port, this adapter performs NO
 * Google call itself — enqueuing puts the item on the queue the cron worker
 * claims, and only that worker (with YouTube's own video id and 'processed'
 * upload status) can ever move the row to `published`.
 */
export interface YouTubeEnqueuePort {
  enqueueYouTubePublishItem(input: {
    ownerId: string;
    draftId: string;
    calendarItemId: string | null;
    youtubeFormat: "short" | "video";
    title: string;
    description: string;
    privacyStatus: string | null;
    madeForKids: boolean | null;
    categoryId?: string | null;
    scheduledAt: string;
    waitingForMedia?: boolean;
  }): Promise<{ id: string } | null>;
}

/** Canonical format → the YouTube queue's format vocabulary. */
export function youTubeFormatForFormat(format: string): "short" | "video" | null {
  if (format === "short") return "short";
  if (format === "video") return "video";
  return null;
}

/**
 * YouTubePublisher — the real adapter (YouTube Provider Integration v1).
 *
 * Truthfulness is structural, mirroring the Instagram adapter:
 *   - a YouTube Short and a full YouTube Video are BOTH real videos.insert
 *     uploads — Google has no separate Shorts endpoint and none is invented;
 *   - enqueued is NOT published: the durable queue's own state machine, and
 *     YouTube's confirmation inside the worker, decide what happens next;
 *   - policy-sensitive metadata is passed through exactly as declared (or
 *     null): a missing audience declaration parks the item visibly instead
 *     of being guessed.
 *
 * Called with `null` (no queue port configured), it degrades to the truthful
 * unavailable adapter — the boundary can never fake a success either way.
 */
export function createYouTubePublisher(port: YouTubeEnqueuePort | null): SocialPublisher {
  if (!port) return createUnavailablePublisher("youtube");
  return {
    channel: "youtube",
    isAvailable: () => true,
    async publish(request) {
      const youtubeFormat = youTubeFormatForFormat(request.format);
      if (!youtubeFormat) {
        return {
          status: "failed",
          channel: "youtube",
          code: "unsupported_format",
          message: `YouTube cannot publish the format "${request.format}".`,
        };
      }
      const yt = request.youtube ?? {};
      const title = (typeof yt.title === "string" ? yt.title.trim() : "")
        || request.caption.trim().split("\n")[0]?.trim().slice(0, 100)
        || "";
      if (!title) {
        return {
          status: "failed",
          channel: "youtube",
          code: "title_required",
          message: "YouTube requires a title (up to 100 characters) before this item can publish.",
        };
      }
      const privacy = yt.privacyStatus === "public" || yt.privacyStatus === "private" || yt.privacyStatus === "unlisted"
        ? yt.privacyStatus
        : null;
      const madeForKids = typeof yt.madeForKids === "boolean" ? yt.madeForKids : null;
      const row = await port.enqueueYouTubePublishItem({
        ownerId: request.ownerId,
        draftId: request.draftId,
        calendarItemId: request.calendarItemId ?? null,
        youtubeFormat,
        title: title.slice(0, 100),
        description: typeof yt.description === "string" ? yt.description.slice(0, 5000) : "",
        privacyStatus: privacy,
        madeForKids,
        categoryId: typeof yt.categoryId === "string" && yt.categoryId ? yt.categoryId : null,
        scheduledAt: request.scheduledAt,
        waitingForMedia: yt.waitingForMedia === true,
      });
      if (!row) {
        return {
          status: "failed",
          channel: "youtube",
          code: "enqueue_failed",
          message: "Voom could not place this item on the YouTube publish queue.",
        };
      }
      // Truthful: enqueued is NOT published. Only YouTube's own confirmation
      // inside the worker ever establishes Published.
      return {
        status: "enqueued",
        channel: "youtube",
        queueRef: row.id,
        message: madeForKids === null || privacy === null
          ? "On the YouTube publish queue, but it needs its made-for-kids declaration and privacy before YouTube allows the upload."
          : "On the YouTube publish queue. Publishing happens at the scheduled time; Published appears only after YouTube confirms the video is processed.",
      };
    },
  };
}

export interface SocialPublisherRegistry {
  instagram: SocialPublisher;
  tiktok: SocialPublisher;
  youtube: SocialPublisher;
}

/**
 * Builds the registry: Instagram and YouTube real (each delegating to its
 * own durable publish queue), TikTok the truthful placeholder until its real
 * integration ships. A null/absent YouTube port keeps the truthful
 * unavailable adapter, so an unconfigured deployment never fakes ability.
 */
export function createSocialPublisherRegistry(
  instagramPort: InstagramEnqueuePort,
  youtubePort?: YouTubeEnqueuePort | null,
): SocialPublisherRegistry {
  return {
    instagram: createInstagramPublisher(instagramPort),
    tiktok: createTikTokPublisher(),
    youtube: createYouTubePublisher(youtubePort ?? null),
  };
}

/**
 * The router the rest of Voom calls. It validates the channel, hands the
 * request to that channel's adapter, and structurally refuses any adapter
 * result that claims `published` without a provider reference — so a buggy or
 * future adapter can never fake a success through this boundary.
 */
export async function publishSocialContent(
  registry: SocialPublisherRegistry,
  request: SocialPublishRequest,
): Promise<SocialPublishOutcome> {
  if (!isSocialMediaChannel(request.channel)) {
    return {
      status: "failed",
      channel: request.channel,
      code: "unknown_channel",
      message: "That channel cannot carry published social content.",
    };
  }
  const publisher = registry[request.channel];
  if (!publisher.isAvailable()) {
    // Never even calls publish(): an unavailable adapter has nothing to try.
    return {
      status: "connection_required",
      channel: request.channel,
      message: CHANNEL_PUBLISHING_AVAILABILITY[request.channel].reason,
    };
  }
  const outcome = await publisher.publish(request);
  if (outcome.status === "published" && !outcome.providerRef) {
    // Structural guard: published REQUIRES the provider's own reference.
    return {
      status: "failed",
      channel: request.channel,
      code: "missing_provider_confirmation",
      message: "The provider did not confirm publication, so Voom will not claim it published.",
    };
  }
  return outcome;
}

/**
 * The canonical state an outcome establishes on the item, for callers that
 * persist lifecycle state. `published` is only ever produced from an outcome
 * that carries a real provider reference, mirroring the state machine's
 * `mayEstablishPublished` invariant.
 */
export function publishStateForOutcome(
  outcome: SocialPublishOutcome,
  from: SocialPublishState,
): SocialPublishState {
  switch (outcome.status) {
    case "published":
      return mayEstablishPublished(from) || from === "scheduled" ? "published" : from;
    case "enqueued":
      return "scheduled";
    case "failed":
      return "failed";
    case "connection_required":
      return "connection_required";
    case "provider_not_supported":
      return "connection_required";
    default:
      return from;
  }
}

/** Human label for an outcome, for UI surfaces. */
export function outcomeLabel(outcome: SocialPublishOutcome): string {
  switch (outcome.status) {
    case "enqueued": return "On the publish queue";
    case "published": return `Published on ${SOCIAL_CHANNEL_LABELS[outcome.channel]}`;
    case "failed": return "Publishing failed";
    case "connection_required": return "Connection required";
    case "provider_not_supported": return "Not available yet";
    default: return "Unknown";
  }
}
