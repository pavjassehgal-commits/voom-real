/**
 * Voom Multi-Social Core — the ONE canonical social execution lifecycle.
 *
 * One state machine describes how ANY social content item moves from an idea
 * to a provider-confirmed publication, on any channel:
 *
 *   draft → needs_approval → approved → scheduled → submitting
 *         → provider_processing → published
 *
 * plus the truthful side states:
 *   failed              the provider attempt really failed
 *   blocked             Voom-side rule prevents execution (safety, media)
 *   connection_required the channel's provider connection is missing
 *
 * Adaptation rule: this vocabulary REUSES Voom's existing state words wherever
 * they already exist (the Instagram publish queue's scheduled / publishing /
 * published / failed, the campaign actions' proposed / needs_approval /
 * approved / scheduled, the draft's draft / approved / rejected). The mapping
 * functions below are the only bridge, so no screen invents a parallel
 * lifecycle.
 *
 * CRITICAL INVARIANT: `published` is reachable ONLY from a state where an
 * authoritative provider confirmation exists. Scheduled is not published.
 * Submitted is not published. Provider acceptance/processing is not
 * published. The transition table below makes that structurally impossible:
 * the only edge into `published` comes from `provider_processing` (or from
 * `submitting` for providers — like Meta's synchronous publish — whose
 * confirmation arrives in the same call, and that confirmation IS the
 * provider's own returned media id).
 *
 * Pure and dependency-free.
 */

export const SOCIAL_PUBLISH_STATES = [
  "draft",
  "needs_approval",
  "approved",
  "scheduled",
  "submitting",
  "provider_processing",
  "published",
  "failed",
  "blocked",
  "connection_required",
] as const;

export type SocialPublishState = (typeof SOCIAL_PUBLISH_STATES)[number];

export const SOCIAL_PUBLISH_STATE_LABELS: Record<SocialPublishState, string> = {
  draft: "Draft",
  needs_approval: "Needs approval",
  approved: "Approved",
  scheduled: "Scheduled",
  submitting: "Submitting",
  provider_processing: "Processing at provider",
  published: "Published",
  failed: "Failed",
  blocked: "Blocked",
  connection_required: "Connection required",
};

/** States in which the user can still edit the content. */
export const EDITABLE_PUBLISH_STATES: ReadonlySet<SocialPublishState> = new Set([
  "draft",
  "needs_approval",
  "approved",
  "scheduled",
  "blocked",
  "connection_required",
]);

/** States that can never become `published` without going backwards first. */
export const TERMINAL_PUBLISH_STATES: ReadonlySet<SocialPublishState> = new Set([
  "published",
]);

/**
 * The legal transition table. Anything not listed here is refused, which is
 * what makes "only provider confirmation establishes published" structural
 * rather than a comment.
 *
 * - `provider_processing → published` is the asynchronous-provider edge (a
 *   processing job the provider later confirms).
 * - `submitting → published` is the synchronous-provider edge, and callers may
 *   only take it with a real provider-returned publication reference — the
 *   Instagram publisher does exactly that with Meta's media id.
 * - Recovery edges exist for honest retries: failed/blocked/connection_required
 *   can return to scheduled when the blocker is really cleared.
 */
export const PUBLISH_STATE_TRANSITIONS: Record<SocialPublishState, readonly SocialPublishState[]> = {
  draft: ["needs_approval", "approved", "blocked"],
  needs_approval: ["approved", "draft", "blocked"],
  approved: ["scheduled", "needs_approval", "blocked"],
  scheduled: ["submitting", "blocked", "connection_required", "approved"],
  submitting: ["provider_processing", "published", "failed"],
  provider_processing: ["published", "failed"],
  published: [],
  failed: ["scheduled", "submitting", "blocked"],
  blocked: ["scheduled", "draft", "needs_approval"],
  connection_required: ["scheduled", "blocked"],
};

export function isSocialPublishState(value: unknown): value is SocialPublishState {
  return typeof value === "string" && (SOCIAL_PUBLISH_STATES as readonly string[]).includes(value);
}

export function canTransitionPublishState(from: SocialPublishState, to: SocialPublishState): boolean {
  if (!isSocialPublishState(from) || !isSocialPublishState(to)) return false;
  return PUBLISH_STATE_TRANSITIONS[from].includes(to);
}

/**
 * The one structural guarantee of the lifecycle: which states may legally
 * establish `published`. A provider confirmation arrives while the item is
 * submitting (synchronous publish) or processing (asynchronous confirmation);
 * nowhere else.
 */
export function mayEstablishPublished(from: SocialPublishState): boolean {
  return from === "submitting" || from === "provider_processing";
}

// ─── Bridges from the existing production vocabularies ─────────────────────

/**
 * Maps the durable Instagram publish queue state (migration 0022 vocabulary)
 * onto the canonical lifecycle. The queue only exists once an item is approved
 * and scheduled, so its states live in the execution half of the machine.
 * `published` here already means "Meta returned a real media id" — the
 * truthfulness guarantee the existing publisher enforces is preserved.
 */
export function publishStateFromInstagramQueue(
  queueStatus:
    | "scheduled"
    | "waiting_for_media"
    | "permission_required"
    | "publishing"
    | "published"
    | "failed"
    | "cancelled"
    | null,
): SocialPublishState | null {
  switch (queueStatus) {
    case "scheduled": return "scheduled";
    case "waiting_for_media": return "blocked";
    case "permission_required": return "connection_required";
    case "publishing": return "submitting";
    case "published": return "published";
    case "failed": return "failed";
    case "cancelled": return "draft";
    case null: return null;
    default: return null;
  }
}

/**
 * Maps the draft approval state onto the pre-execution half of the machine.
 * A rejected draft is truthfully `blocked`: Voom will not execute it.
 */
export function publishStateFromDraftStatus(status: "draft" | "approved" | "rejected" | null): SocialPublishState {
  if (status === "approved") return "approved";
  if (status === "rejected") return "blocked";
  return "draft";
}

/**
 * Maps the email delivery vocabulary (0018 campaign_sends.internal_status)
 * onto the canonical lifecycle. `delivered` requires the verified webhook and
 * stays the only email state that reads as a confirmed publication.
 */
export function publishStateFromEmailSend(
  sendStatus: "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped" | null,
): SocialPublishState | null {
  switch (sendStatus) {
    case "queued": return "scheduled";
    case "sending": return "submitting";
    // Resend acceptance is provider processing, NOT a confirmed delivery.
    case "accepted": return "provider_processing";
    case "delivered": return "published";
    case "failed": return "failed";
    case "skipped": return "blocked";
    case null: return null;
    default: return null;
  }
}

/**
 * Maps the durable YouTube publish queue state (migration 0047 vocabulary)
 * onto the canonical lifecycle. The queue only exists once an item is
 * approved and scheduled, so its states live in the execution half of the
 * machine. `published` here already means "YouTube returned a real video id
 * AND its own processingDetails.uploadStatus='processed'" — the truthfulness
 * guarantee the YouTube publisher enforces is preserved:
 *
 *   uploading           → submitting          (bytes in flight; NOT accepted)
 *   provider_processing → provider_processing (accepted; NOT published)
 *   needs_declaration   → blocked             (owner must declare audience/privacy)
 */
export function publishStateFromYouTubeQueue(
  queueStatus:
    | "scheduled"
    | "waiting_for_media"
    | "needs_declaration"
    | "permission_required"
    | "uploading"
    | "provider_processing"
    | "published"
    | "failed"
    | "cancelled"
    | string
    | null,
): SocialPublishState | null {
  switch (queueStatus) {
    case "scheduled": return "scheduled";
    case "waiting_for_media": return "blocked";
    case "needs_declaration": return "blocked";
    case "permission_required": return "connection_required";
    case "uploading": return "submitting";
    case "provider_processing": return "provider_processing";
    case "published": return "published";
    case "failed": return "failed";
    case "cancelled": return "draft";
    case null: return null;
    default: return null;
  }
}

/**
 * The truthful canonical state for content on a channel whose provider
 * integration does not exist yet (TikTok today). Planning and
 * approval are real; execution is honestly `connection_required` — never
 * `published`, never `scheduled` pretending it will run.
 */
export function publishStateForUnconnectedProvider(
  draftStatus: "draft" | "approved" | "rejected" | null,
): SocialPublishState {
  const pre = publishStateFromDraftStatus(draftStatus);
  // An approved/scheduled item on an unconnected channel is exactly what
  // `connection_required` means: everything on Voom's side is done.
  return pre === "approved" ? "connection_required" : pre;
}
