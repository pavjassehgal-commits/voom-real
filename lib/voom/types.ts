import type { AudienceEligibilityPreview } from "@/lib/contacts/types";

export type { AudienceEligibilityPreview } from "@/lib/contacts/types";

export interface OnboardingAnswers {
  displayName: string;
  desc: string;
  name: string;
  site: string;
  industry: string;
  customer: string[];
  goal: string;
  tone: string[];
  channels: string[];
  budget: string;
  freq: string;
  auto: string;
  permission: string;
  color: string;
}

export interface Toast {
  id: number;
  msg: string;
  kind: "ok" | "err" | "info";
}

export interface ProfileRecord {
  user_id: string;
  display_name: string | null;
  created_at: string;
  updated_at: string;
}

export interface BusinessRecord {
  id: string;
  owner_user_id: string;
  brand_name: string | null;
  brand_description: string | null;
  industry: string | null;
  target_customer: string[];
  main_goal: string | null;
  brand_personality: string[];
  preferred_channels: string[];
  monthly_ad_budget: string | null;
  content_frequency: string | null;
  automation_level: string | null;
  publishing_permission: string | null;
  /** AI Media Spending (migration 0031). Absent = shipped default. */
  allow_automatic_paid_media?: boolean | null;
  monthly_media_budget_usd?: number | string | null;
  /** Plan (migration 0035). free | pro | max */
  plan?: string | null;
  onboarding_completed: boolean;
  created_at: string;
  updated_at: string;
}

export interface BusinessProfileInput {
  displayName: string;
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string[];
  mainGoal: string;
  brandPersonality: string[];
  preferredChannels: string[];
  monthlyAdBudget: string;
  contentFrequency: string;
  automationLevel: string;
  publishingPermission: string;
}

export type CampaignStatus = "draft" | "approved" | "rejected";

/**
 * 'multi' is the Automated Campaigns container (migration 0033); 'sms' remains
 * readable for historical campaigns but can no longer be created.
 */
export type CampaignKind = "email" | "sms" | "multi";

export interface CampaignRecord {
  id: string;
  /** Present on owner-scoped rows; the delivery route is the authoritative source. */
  owner_user_id?: string;
  kind: CampaignKind;
  name: string;
  objective: string;
  /** Free-text audience description; display-only, never a recipient source. */
  audience: string;
  /** Linked audience id (migration 0020). When set, sends target the audience
   *  resolved server-side at send time — never a client-supplied list. */
  audience_id: string | null;
  subject: string | null;
  preview_text: string | null;
  content: string;
  /** Explicit campaign destination for the CTA button (migration 0041). */
  cta_url?: string | null;
  proposed_send_at: string | null;
  status: CampaignStatus;
  approved_at?: string | null;
  // Automated Campaigns (migration 0033) — null/absent for legacy campaigns.
  is_automated?: boolean | null;
  goal?: import("@/lib/campaign/types").CampaignGoal | null;
  start_at?: string | null;
  end_at?: string | null;
  offer_details?: string | null;
  campaign_notes?: string | null;
  generated_summary?: string | null;
  parent_campaign_id?: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignRecipientRecord {
  id: string;
  /** Present on the RPC `returning *` rows the delivery route consumes. */
  owner_user_id?: string;
  contact: string;
  contact_name: string | null;
  consent_at: string;
  consent_source: string;
  opt_out_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface CampaignSendRecord {
  id: string;
  recipient_id: string;
  channel: "email" | "sms";
  /**
   * Provider literal as persisted by migration 0018 (`claim_campaign_send`
   * writes 'twilio' for SMS sends). The runtime SMS provider is ClickSend; the
   * stored literal is a known architecture limitation and is not changed here.
   */
  provider: "resend" | "twilio";
  provider_message_id: string | null;
  provider_status: string | null;
  internal_status: "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped";
  attempts: number;
  last_error_code: string | null;
  last_error_message: string | null;
  claimed_at: string | null;
  accepted_at: string | null;
  delivered_at: string | null;
  created_at: string;
  updated_at: string;
}

export type CampaignDeliveryState = "ready" | "sending" | "accepted" | "delivered" | "failed";

export interface CampaignProviderAvailability {
  provider: "resend" | "retired";
  label: string;
  configured: boolean;
  deliveryTrackingConfigured: boolean;
  missingEnv: string[];
}

/** Aggregate of campaign_sends rows by internal status — truthful counts only. */
export interface CampaignSendSummary {
  total: number;
  queued: number;
  sending: number;
  accepted: number;
  delivered: number;
  failed: number;
  skipped: number;
}

/** Truthful outcome for one audience send attempt. Destination is masked. */
export interface AudienceSendResultEntry {
  destination: string;
  status: "accepted" | "failed" | "skipped";
  detail?: string;
}

/** Summary of an explicit audience send. Counts are always truthful: accepted
 *  means the provider accepted the message, never that it was delivered. */
export interface AudienceSendResults {
  attempted: number;
  accepted: number;
  failed: number;
  /** Already sent/in flight (never resent), opted out, or not claimable. */
  skipped: number;
  /** Eligible destinations beyond the per-send cap — left unsent. */
  overLimit: number;
  cap: number;
  recipients: AudienceSendResultEntry[];
}

export interface CampaignDeliveryView {
  recipient: CampaignRecipientRecord | null;
  send: CampaignSendRecord | null;
  /** Present when the campaign targets an audience (eligibility re-resolved
   *  on the server; destinations masked). */
  audience: AudienceEligibilityPreview | null;
  /** All recorded sends for this campaign, by internal status. */
  sendsSummary: CampaignSendSummary;
  state: CampaignDeliveryState | null;
  provider: CampaignProviderAvailability;
  canSend: boolean;
  note: string;
  schemaReady: boolean;
}
