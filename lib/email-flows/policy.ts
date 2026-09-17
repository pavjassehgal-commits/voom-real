/**
 * Email Automation v2 — the deterministic authority.
 *
 * This module is the ONLY place that decides what a lifecycle flow may be:
 * the supported trigger types, the step count, the minimum and maximum delay,
 * the re-entry rule, the send window, the retry ceiling and who is allowed to
 * receive anything. MARA proposes strategy and copy inside these limits; it can
 * never widen them.
 *
 * Pure: no I/O, no server-only import, so the Node suite executes it for real.
 */

import { normalizeEmail } from "@/lib/contacts/core";
import type {
  EmailFlowReentryPolicy,
  EmailFlowStatus,
  EmailFlowTriggerType,
  EmailFlowType,
} from "./types";
import { EMAIL_FLOW_TYPES } from "./types";

// ─── Structural limits ─────────────────────────────────────────────────────

/** Absolute ceiling for any flow type. The schema allows 12; the engine 6. */
export const MAX_FLOW_STEPS = 6;
/** Hard floor: a "sequence" of zero emails is not a flow. */
export const MIN_FLOW_STEPS = 1;
/** 14 days. No lifecycle wait may exceed this in v2. */
export const MAX_STEP_WAIT_MINUTES = 14 * 24 * 60;
/** Provider retries for one step. Bounded — never an infinite loop. */
export const MAX_SEND_ATTEMPTS = 3;
/** A `sending` run older than this is treated as an abandoned lease. */
export const SEND_LEASE_MINUTES = 10;
/**
 * Provider-politeness ceiling per owner per tick. Also what makes resume safe:
 * an overdue pile is spread across ticks instead of bursting out at once.
 */
export const MAX_SENDS_PER_TICK = 25;
/** Enrollment ceiling per owner per tick, so a first run cannot flood a flow. */
export const MAX_ENROLLMENTS_PER_TICK = 50;
/** How far ahead the engine may schedule (keeps `no past schedule` honest). */
export const MIN_SCHEDULE_LEAD_MINUTES = 2;

// ─── Deterministic business-local send window ──────────────────────────────
//
// Resolved in the BUSINESS timezone through lib/voom/timezone — never the
// browser's timezone and never a hardcoded UTC offset. A wait that lands
// outside this window is moved to the next window start.

export const SEND_WINDOW_START_MINUTES = 9 * 60; // 09:00 business-local
export const SEND_WINDOW_END_MINUTES = 18 * 60; // 18:00 business-local (exclusive)

export interface EmailFlowTypePolicy {
  type: EmailFlowType;
  triggerType: EmailFlowTriggerType;
  /** What the user picks in the builder. */
  label: string;
  /** The plain-language objective shown on the flow. */
  objective: string;
  triggerLabel: string;
  triggerDescription: string;
  /** Why a contact receives this, in one sentence. */
  eligibilityNote: string;
  minSteps: number;
  maxSteps: number;
  /** Default sequence length when the user changes nothing. */
  defaultSteps: number;
  /** Default wait before each step, in minutes. Index = position. */
  defaultWaitMinutes: number[];
  minWaitMinutes: number;
  maxWaitMinutes: number;
  reentryPolicy: EmailFlowReentryPolicy;
  /** Re-engagement only: days a contact must be inactive to become eligible. */
  defaultInactivityDays: number | null;
  minInactivityDays: number | null;
  maxInactivityDays: number | null;
  /** Re-engagement only: days before a contact may re-enter the flow. */
  defaultCooldownDays: number | null;
}

const DAY = 24 * 60;

export const EMAIL_FLOW_TYPE_POLICIES: Record<EmailFlowType, EmailFlowTypePolicy> = {
  welcome: {
    type: "welcome",
    triggerType: "newly_eligible_contact",
    label: "Welcome new customers",
    objective:
      "Introduce your business to customers who have just become eligible for email, then follow up while the introduction is still fresh.",
    triggerLabel: "A contact becomes newly eligible",
    triggerDescription:
      "Runs when a contact you own is subscribed to marketing email and has not been through this flow before.",
    eligibilityNote:
      "Every contact with a verified marketing-email subscription who has not been through this flow. Consent is re-checked before each send, so an unsubscribe mid-flow stops the sequence.",
    minSteps: 2,
    maxSteps: 5,
    defaultSteps: 3,
    defaultWaitMinutes: [0, 2 * DAY, 3 * DAY],
    minWaitMinutes: 0,
    maxWaitMinutes: 7 * DAY,
    reentryPolicy: "once_per_contact",
    defaultInactivityDays: null,
    minInactivityDays: null,
    maxInactivityDays: null,
    defaultCooldownDays: null,
  },
  re_engagement: {
    type: "re_engagement",
    triggerType: "inactive_contact",
    label: "Re-engage inactive customers",
    objective:
      "Reconnect with subscribed customers Voom has not emailed for a while, without repeating the approach on anyone who does not respond.",
    triggerLabel: "An eligible contact has been inactive",
    triggerDescription:
      "Runs when a subscribed contact has not been meaningfully emailed for the inactivity period you choose, and is not inside the re-entry cooldown.",
    eligibilityNote:
      "Subscribed contacts Voom has not emailed within the inactivity period. Consent is re-checked before each send, and a contact who finishes the flow cannot re-enter until the cooldown has passed.",
    minSteps: 1,
    maxSteps: 3,
    defaultSteps: 2,
    defaultWaitMinutes: [0, 4 * DAY],
    minWaitMinutes: 1 * DAY,
    maxWaitMinutes: 14 * DAY,
    reentryPolicy: "cooldown",
    defaultInactivityDays: 45,
    minInactivityDays: 14,
    maxInactivityDays: 365,
    defaultCooldownDays: 90,
  },
};

export function isSupportedFlowType(value: unknown): value is EmailFlowType {
  return typeof value === "string" && (EMAIL_FLOW_TYPES as readonly string[]).includes(value);
}

export function normalizeFlowType(value: unknown): EmailFlowType | null {
  return isSupportedFlowType(value) ? value : null;
}

/**
 * The trigger a flow type is allowed to run on. This is the single mapping the
 * database check constraint mirrors, so an unsupported trigger cannot be
 * proposed by a client, by MARA, or by the Coordinator.
 */
export function triggerForFlowType(type: EmailFlowType): EmailFlowTriggerType {
  return EMAIL_FLOW_TYPE_POLICIES[type].triggerType;
}

export function flowTypeForTrigger(trigger: EmailFlowTriggerType): EmailFlowType | null {
  const match = EMAIL_FLOW_TYPES.find((type) => triggerForFlowType(type) === trigger);
  return match ?? null;
}

export function flowTypePolicy(type: EmailFlowType): EmailFlowTypePolicy {
  return EMAIL_FLOW_TYPE_POLICIES[type];
}

/**
 * Clamps a proposed wait into the deterministic range for this flow type.
 * MARA may suggest a delay; it can never push one outside these bounds.
 *
 * Position 0 is exempt from the minimum: the first email of a flow goes out in
 * the next safe window after enrollment, it never waits a day first.
 */
export function clampWaitMinutes(
  type: EmailFlowType,
  proposed: number | null | undefined,
  position = 1,
): number {
  const policy = flowTypePolicy(type);
  const value = Number.isFinite(proposed as number) ? Math.round(Number(proposed)) : NaN;
  if (!Number.isFinite(value)) {
    // No usable suggestion: use this position's default. A position beyond the
    // published sequence falls back to the LAST default wait, never position 0's
    // zero — an extra step must not send immediately after the previous one.
    const defaults = policy.defaultWaitMinutes;
    return defaults[position] ?? defaults[defaults.length - 1] ?? 0;
  }
  const floor = position === 0 ? 0 : policy.minWaitMinutes;
  return Math.min(policy.maxWaitMinutes, Math.max(floor, value));
}

export function clampStepCount(type: EmailFlowType, proposed: number): number {
  const policy = flowTypePolicy(type);
  if (!Number.isFinite(proposed)) return policy.defaultSteps;
  return Math.min(policy.maxSteps, Math.max(policy.minSteps, Math.round(proposed)));
}

// ─── Creation validation ───────────────────────────────────────────────────

export interface FlowCreationDraft {
  flowType: unknown;
  triggerType?: unknown;
  name?: unknown;
  audienceId?: unknown;
  steps?: unknown;
  inactivityDays?: unknown;
  cooldownDays?: unknown;
}

export type FlowValidationResult =
  | { ok: true }
  | { ok: false; code: string; message: string };

/**
 * Refuses anything the deterministic model does not support BEFORE a provider
 * is called or a row is written.
 */
export function validateFlowCreation(input: FlowCreationDraft): FlowValidationResult {
  const type = normalizeFlowType(input.flowType);
  if (!type) {
    return {
      ok: false,
      code: "unsupported_flow_type",
      message: `Voom automates ${EMAIL_FLOW_TYPES.map((t) => EMAIL_FLOW_TYPE_POLICIES[t].label.toLowerCase()).join(" and ")} in this release. Choose one of those.`,
    };
  }

  if (input.triggerType !== undefined && input.triggerType !== triggerForFlowType(type)) {
    return {
      ok: false,
      code: "unsupported_trigger_type",
      message: "That trigger is not supported for this flow type.",
    };
  }

  const policy = flowTypePolicy(type);

  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length > 160) {
    return { ok: false, code: "invalid_name", message: "Keep the flow name under 160 characters." };
  }

  if (input.audienceId !== undefined && input.audienceId !== null && typeof input.audienceId !== "string") {
    return { ok: false, code: "invalid_audience", message: "That audience is not valid." };
  }

  const stepCount = Array.isArray(input.steps) ? input.steps.length : policy.defaultSteps;
  if (stepCount < policy.minSteps || stepCount > policy.maxSteps) {
    return {
      ok: false,
      code: "invalid_step_count",
      message: `A ${type === "welcome" ? "Welcome" : "Re-engagement"} flow has between ${policy.minSteps} and ${policy.maxSteps} emails.`,
    };
  }

  if (type === "re_engagement") {
    if (input.inactivityDays !== undefined && input.inactivityDays !== null) {
      const days = Number(input.inactivityDays);
      if (!Number.isFinite(days)
        || days < (policy.minInactivityDays ?? 14)
        || days > (policy.maxInactivityDays ?? 365)) {
        return {
          ok: false,
          code: "invalid_inactivity_days",
          message: `Choose an inactivity period between ${policy.minInactivityDays} and ${policy.maxInactivityDays} days.`,
        };
      }
    }
    if (input.cooldownDays !== undefined && input.cooldownDays !== null) {
      const days = Number(input.cooldownDays);
      if (!Number.isFinite(days) || days < 1 || days > 365) {
        return {
          ok: false,
          code: "invalid_cooldown_days",
          message: "Choose a re-entry cooldown between 1 and 365 days.",
        };
      }
    }
  }

  return { ok: true };
}

// ─── Recipient consent (authoritative, fail closed) ────────────────────────

const EMAIL_DESTINATION_RE = /^[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i;

export interface FlowEligibilityContact {
  email: string | null;
  email_status: "subscribed" | "unsubscribed" | "unknown" | string | null;
}

/**
 * Voom NEVER infers marketing consent. A contact may only be enrolled or sent
 * to when the authoritative contacts record says `subscribed` AND the address
 * is valid AND the address is not suppressed by real provider evidence.
 *
 * Unknown consent is not consent: it fails closed.
 */
export function flowContactEligibility(
  contact: FlowEligibilityContact | null | undefined,
  suppressedEmails: ReadonlySet<string> = new Set(),
): { eligible: boolean; reason: import("./types").EmailFlowEligibilityReason; destination: string | null } {
  if (!contact) return { eligible: false, reason: "contact_not_found", destination: null };
  if (contact.email_status !== "subscribed") {
    return {
      eligible: false,
      reason: contact.email_status === "unknown" || !contact.email_status
        ? "consent_unknown"
        : "consent_not_subscribed",
      destination: null,
    };
  }
  const email = normalizeEmail(contact.email);
  if (!email) return { eligible: false, reason: "destination_missing", destination: null };
  if (!EMAIL_DESTINATION_RE.test(email)) {
    return { eligible: false, reason: "destination_invalid", destination: null };
  }
  if (suppressedEmails.has(email)) return { eligible: false, reason: "suppressed", destination: null };
  return { eligible: true, reason: "eligible", destination: email };
}

/** The plain-language reason a contact was refused. Never leaks an address. */
export function eligibilityReasonLabel(reason: import("./types").EmailFlowEligibilityReason): string {
  switch (reason) {
    case "eligible":
      return "Eligible for marketing email.";
    case "consent_unknown":
      return "Consent is unknown, so Voom does not send.";
    case "consent_not_subscribed":
      return "Not subscribed to marketing email.";
    case "destination_missing":
      return "No email address on file.";
    case "destination_invalid":
      return "The email address on file is not valid.";
    case "suppressed":
      return "Suppressed after a bounce or complaint.";
    case "contact_not_found":
      return "The contact no longer exists.";
    default:
      return "Not eligible.";
  }
}

// ─── Re-entry (deterministic, per flow type) ───────────────────────────────

export interface ReEntryDecision {
  allow: boolean;
  outcome: "new" | "already_enrolled" | "cooldown";
  reason: string;
}

/**
 * Welcome: one enrollment per contact per flow, ever.
 * Re-engagement: a completed or stopped enrollment may re-enter, but only after
 * the cooldown — so a flow can never become a harassment loop.
 */
export function decideReEntry(input: {
  policy: EmailFlowReentryPolicy;
  cooldownDays: number | null;
  hasActiveEnrollment: boolean;
  /** The most recent completed_at / stopped_at for this contact + flow. */
  lastEndedAt: string | null;
  now: Date;
}): ReEntryDecision {
  if (input.hasActiveEnrollment) {
    return { allow: false, outcome: "already_enrolled", reason: "already_enrolled" };
  }
  if (!input.lastEndedAt) return { allow: true, outcome: "new", reason: "first_enrollment" };
  if (input.policy === "once_per_contact") {
    return { allow: false, outcome: "already_enrolled", reason: "once_per_contact" };
  }
  const ended = Date.parse(input.lastEndedAt);
  if (!Number.isFinite(ended)) return { allow: true, outcome: "new", reason: "unreadable_history" };
  const cooldownMs = (input.cooldownDays ?? 90) * 24 * 60 * 60 * 1000;
  if (ended + cooldownMs > input.now.getTime()) {
    return { allow: false, outcome: "cooldown", reason: "reengagement_cooldown" };
  }
  return { allow: true, outcome: "new", reason: "cooldown_elapsed" };
}

/**
 * Re-engagement eligibility from REAL Voom data only: the last time Voom
 * emailed this contact for this owner. Voom never invents customer behaviour
 * it cannot observe — no purchase, cart or browse events exist here, so
 * "inactive" means "Voom has not emailed them", nothing more.
 */
export function isInactiveContact(input: {
  lastEmailedAt: string | null;
  contactCreatedAt: string | null;
  inactivityDays: number;
  now: Date;
}): boolean {
  const threshold = input.now.getTime() - input.inactivityDays * 24 * 60 * 60 * 1000;
  const reference = Date.parse(input.lastEmailedAt ?? input.contactCreatedAt ?? "");
  if (!Number.isFinite(reference)) return false;
  return reference <= threshold;
}

// ─── Lifecycle gates ───────────────────────────────────────────────────────

/** Only an owner-activated flow may enroll contacts or send anything. */
export function flowMayExecute(flow: {
  status: EmailFlowStatus;
  activated_by: "user" | null;
  activated_at: string | null;
}): boolean {
  return flow.status === "active" && flow.activated_by === "user" && Boolean(flow.activated_at);
}

/**
 * Automation-mode gate for AUTONOMOUS flow creation.
 *
 * Manual    → the Coordinator never creates or activates a flow. The owner can
 *             still create one explicitly; that is the user acting, not Voom.
 * Assisted  → the Coordinator may PREPARE a draft flow. Activation is always an
 *             explicit owner action.
 * Autopilot → same as Assisted in v2. No existing Voom policy authorises the
 *             automatic activation of a lifecycle flow that sends email, so
 *             Autopilot fails closed and leaves the flow proposed rather than
 *             inventing permission.
 */
export function mayCoordinatorProposeFlow(mode: "manual" | "assisted" | "autopilot"): boolean {
  return mode === "assisted" || mode === "autopilot";
}

/**
 * Autopilot does NOT get automatic activation in v2: fail closed.
 * Documented deliberately — do not widen this to make Autopilot look busier.
 */
export function mayCoordinatorActivateFlow(mode: "manual" | "assisted" | "autopilot"): boolean {
  // The mode is deliberately ignored: no mode authorises it in v2.
  void mode;
  return false;
}

// ─── Presentation labels ───────────────────────────────────────────────────

export const EMAIL_FLOW_STATUS_LABELS: Record<EmailFlowStatus, string> = {
  draft: "Draft",
  active: "Active",
  paused: "Paused",
  archived: "Archived",
};

export function flowStatusLabel(status: EmailFlowStatus): string {
  return EMAIL_FLOW_STATUS_LABELS[status] ?? status;
}

export function reentryPolicyLabel(policy: EmailFlowReentryPolicy): string {
  return policy === "once_per_contact"
    ? "Each contact goes through this flow once."
    : "A contact can re-enter after the cooldown.";
}

/** "Send now" / "After 2 days" / "After 3 days". */
export function waitLabel(minutes: number, position: number): string {
  if (position === 0 && minutes === 0) return "Sends in the next business-hours window";
  if (minutes === 0) return "Sends with the previous step";
  if (minutes < 60) return `After ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = minutes / 60;
  if (hours < 24) {
    const whole = Math.round(hours);
    return `After ${whole} hour${whole === 1 ? "" : "s"}`;
  }
  const days = Math.round(hours / 24);
  return `After ${days} day${days === 1 ? "" : "s"}`;
}

export const EMAIL_FLOW_ACTIVITY_LABELS: Record<string, string> = {
  flow_created: "Flow created",
  flow_activated: "Flow activated",
  flow_paused: "Flow paused",
  flow_resumed: "Flow resumed",
  flow_archived: "Flow archived",
  flow_revised: "Flow content updated (new revision)",
  contact_enrolled: "Contact enrolled",
  enrollment_completed: "Contact finished the flow",
  enrollment_stopped: "Contact stopped",
  step_scheduled: "Next email scheduled",
  provider_accepted: "Resend accepted the email",
  delivered: "Delivery confirmed by Resend",
  send_failed: "Send failed",
  send_skipped: "Send skipped",
};

export function activityLabel(kind: string): string {
  return EMAIL_FLOW_ACTIVITY_LABELS[kind] ?? kind;
}

/** Why a flow needs the owner's attention, or null when it does not. */
export function flowAttention(input: {
  status: EmailFlowStatus;
  createdBy: "user" | "coordinator";
  failedRuns: number;
  providerConfigured: boolean;
}): { needsAttention: boolean; reason: string | null } {
  if (input.status === "draft") {
    return {
      needsAttention: true,
      reason: input.createdBy === "coordinator"
        ? "MARA proposed this flow. Review and activate it before anyone is enrolled."
        : "This flow is a draft. Activate it before anyone is enrolled.",
    };
  }
  if (input.status === "active" && !input.providerConfigured) {
    return {
      needsAttention: true,
      reason: "Resend is not configured on the server, so scheduled emails cannot go out.",
    };
  }
  if (input.status === "active" && input.failedRuns > 0) {
    return {
      needsAttention: true,
      reason: `${input.failedRuns} lifecycle email${input.failedRuns === 1 ? "" : "s"} failed and need${input.failedRuns === 1 ? "s" : ""} a look.`,
    };
  }
  return { needsAttention: false, reason: null };
}
