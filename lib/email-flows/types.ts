/**
 * Email Automation v2 — shared types.
 *
 * Three distinct marketing concepts live in Voom and must stay separate:
 *
 *   Campaign           a finite marketing mission      (voom_campaigns)
 *   Standalone email   one intentional send            (voom_campaigns, kind = 'email')
 *   Email flow         a persistent lifecycle rule     (voom_email_flows, this module)
 *
 * A flow is never a campaign: it has no start/end date, no Instagram siblings
 * and no campaign_recipients rows. It has a trigger, an eligibility rule, an
 * ordered sequence of email steps, and durable enrollments that move through
 * that sequence over time.
 */

export const EMAIL_FLOW_TYPES = ["welcome", "re_engagement"] as const;
export type EmailFlowType = (typeof EMAIL_FLOW_TYPES)[number];

export const EMAIL_FLOW_TRIGGER_TYPES = [
  "newly_eligible_contact",
  "inactive_contact",
] as const;
export type EmailFlowTriggerType = (typeof EMAIL_FLOW_TRIGGER_TYPES)[number];

export const EMAIL_FLOW_STATUSES = ["draft", "active", "paused", "archived"] as const;
export type EmailFlowStatus = (typeof EMAIL_FLOW_STATUSES)[number];

export const EMAIL_FLOW_ENROLLMENT_STATUSES = ["active", "completed", "stopped"] as const;
export type EmailFlowEnrollmentStatus = (typeof EMAIL_FLOW_ENROLLMENT_STATUSES)[number];

/**
 * Truthful send lifecycle. `accepted` means the provider accepted the message;
 * `delivered` is only ever reached through a verified provider delivery event.
 */
export const EMAIL_FLOW_RUN_STATUSES = [
  "scheduled",
  "sending",
  "accepted",
  "delivered",
  "failed",
  "skipped",
] as const;
export type EmailFlowRunStatus = (typeof EMAIL_FLOW_RUN_STATUSES)[number];

export type EmailFlowReentryPolicy = "once_per_contact" | "cooldown";
export type EmailFlowGenerationSource = "deterministic" | "mara";
export type EmailFlowContentSource = "deterministic" | "mara" | "edited";

export interface EmailFlowStepDefinition {
  position: number;
  title: string;
  purpose: string;
  /** Deterministic wait BEFORE this step, measured from the previous step. */
  waitMinutes: number;
  subject: string;
  previewText: string;
  body: string;
  cta: string;
  ctaUrl: string | null;
  contentSource: EmailFlowContentSource;
}

export interface EmailFlowRecord {
  id: string;
  owner_user_id: string;
  business_id: string | null;
  flow_type: EmailFlowType;
  trigger_type: EmailFlowTriggerType;
  trigger_config: Record<string, unknown>;
  name: string;
  objective: string;
  audience_id: string | null;
  status: EmailFlowStatus;
  reentry_policy: EmailFlowReentryPolicy;
  cooldown_days: number | null;
  current_revision: number;
  generation_source: EmailFlowGenerationSource;
  strategy: Record<string, unknown> | null;
  strategy_summary: string | null;
  created_by: "user" | "coordinator";
  activated_at: string | null;
  activated_by: "user" | null;
  paused_at: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface EmailFlowStepRecord {
  id: string;
  owner_user_id: string;
  flow_id: string;
  revision: number;
  position: number;
  step_type: "email";
  title: string;
  purpose: string;
  wait_minutes: number;
  subject: string;
  preview_text: string;
  body: string;
  cta: string;
  cta_url: string | null;
  content_source: EmailFlowContentSource;
}

export interface EmailFlowEnrollmentRecord {
  id: string;
  owner_user_id: string;
  flow_id: string;
  contact_id: string;
  revision: number;
  status: EmailFlowEnrollmentStatus;
  stop_reason: string | null;
  enrolled_at: string;
  current_position: number;
  next_eligible_at: string | null;
  last_step_at: string | null;
  completed_at: string | null;
  stopped_at: string | null;
}

export interface EmailFlowStepRunRecord {
  id: string;
  owner_user_id: string;
  flow_id: string;
  enrollment_id: string;
  step_id: string | null;
  revision: number;
  position: number;
  status: EmailFlowRunStatus;
  provider: "resend";
  provider_message_id: string | null;
  provider_status: string | null;
  idempotency_key: string;
  claim_token: string | null;
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  scheduled_for: string;
  claimed_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  content_snapshot: Record<string, unknown>;
}

/**
 * The browser-safe flow view. Never carries a raw recipient address: the
 * contact's identity stays server-side, exactly like campaign recipients.
 */
export interface EmailFlowView {
  id: string;
  flowType: EmailFlowType;
  triggerType: EmailFlowTriggerType;
  trigger: { label: string; description: string };
  name: string;
  objective: string;
  status: EmailFlowStatus;
  statusLabel: string;
  audience: { id: string; name: string } | null;
  eligibilityNote: string;
  reentry: { policy: EmailFlowReentryPolicy; label: string };
  revision: number;
  generationSource: EmailFlowGenerationSource;
  strategySummary: string | null;
  createdBy: "user" | "coordinator";
  needsAttention: boolean;
  attentionReason: string | null;
  steps: EmailFlowStepView[];
  counts: EmailFlowCounts;
  nextScheduledAt: string | null;
  recentActivity: EmailFlowActivityView[];
  createdAt: string;
  activatedAt: string | null;
  pausedAt: string | null;
}

export interface EmailFlowStepView {
  position: number;
  title: string;
  purpose: string;
  /** Human label for the wait before this step, e.g. "After 2 days". */
  waitLabel: string;
  waitMinutes: number;
  subject: string;
  previewText: string;
  body: string;
  cta: string;
  ctaUrl: string | null;
  contentSource: EmailFlowContentSource;
}

export interface EmailFlowCounts {
  enrolled: number;
  active: number;
  completed: number;
  stopped: number;
  /** Runs the provider accepted (not a delivery claim). */
  accepted: number;
  /** Only webhook-confirmed deliveries. */
  delivered: number;
  failed: number;
  skipped: number;
  scheduled: number;
}

export interface EmailFlowActivityView {
  id: string;
  kind: string;
  label: string;
  at: string;
}

/**
 * Lifecycle snapshot for Today / Automations / the Coordinator. Every number
 * comes from real rows; nothing is estimated or invented.
 */
export interface EmailFlowSummary {
  total: number;
  active: number;
  paused: number;
  draft: number;
  archived: number;
  enrolledContacts: number;
  activeEnrollments: number;
  scheduledRuns: number;
  needsAttention: number;
  hasWelcome: boolean;
  hasReEngagement: boolean;
  flows: Array<{
    id: string;
    name: string;
    flowType: EmailFlowType;
    status: EmailFlowStatus;
    enrolled: number;
    activeEnrollments: number;
    nextScheduledAt: string | null;
    needsAttention: boolean;
    attentionReason: string | null;
    createdBy: "user" | "coordinator";
  }>;
}

export type EmailFlowEligibilityReason =
  | "eligible"
  | "consent_not_subscribed"
  | "consent_unknown"
  | "destination_missing"
  | "destination_invalid"
  | "suppressed"
  | "contact_not_found";
