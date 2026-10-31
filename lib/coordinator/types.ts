/**
 * Automation Intelligence / Coordinator v1 types
 */

import type { AutomationModeValue } from "@/lib/voom/automation";
import type { PlanId } from "@/lib/billing/plans";
import type { Cadence, ContentType } from "@/lib/voom/cadence";

export type CoordinatorNeedType =
  /**
   * The gap need covers the ONE marketing calendar across supported social
   * channels. Gap filling passes actual uncovered dates to the shared planner;
   * email remains separate from social cadence.
   */
  | "content_calendar_gap"
  | "campaign_needs_attention"
  | "pending_approval"
  | "email_opportunity"
  | "email_flow_needs_attention"
  | "email_flow_opportunity"
  | "performance_learning_available"
  | "nothing_needed";

export interface MarketingStateBusinessProfile {
  id: string;
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string[];
  mainGoal: string;
  brandPersonality: string[];
  preferredChannels: string[];
  contentFrequency: string;
  automationLevel: AutomationModeValue;
  timezone: string;
  plan: PlanId;
  allowAutomaticPaidMedia: boolean;
}

export interface CreditAvailability {
  planId: PlanId;
  monthlyAllowance: number;
  usedThisMonth: number;
  remainingCredits: number;
  canGenerateMedia: boolean;
  canUseAutopilot: boolean;
}

export interface CalendarCommitment {
  id: string;
  source: "campaign" | "workflow_plan" | "direct_calendar" | "draft";
  sourceId: string;
  /**
   * Multi-Social Core: the coordinator reads the ONE marketing calendar, so
   * commitments carry their real channel — Instagram, TikTok, YouTube or
   * email. Understanding a channel never grants execution over it.
   */
  channel: "instagram_post" | "instagram_reel" | "instagram_story" | "tiktok_video" | "youtube_short" | "youtube_video" | "linkedin_text" | "email";
  /** Instagram keeps post/reel/story; social video commitments use video/short. */
  format: ContentType | "video" | "short" | "text";
  title: string;
  publishAt: string;
  localDate: string;
  localTime: string;
  status: "proposed" | "needs_approval" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "waiting_for_media";
  /**
   * The provider publish itself failed (as opposed to a rejected idea). Such a
   * date is neither cadence coverage nor an automatic gap: it needs the owner.
   */
  publishFailed?: boolean;
}

export interface ActiveCampaignState {
  id: string;
  name: string;
  goal: string;
  lifecycle: string;
  startAt: string;
  endAt: string;
  actions: {
    id: string;
    channel: string;
    stage: string;
    title: string;
    scheduledFor: string;
    status: string;
    needsAttention: boolean;
    attentionReason?: string;
  }[];
}

export interface PendingApprovalState {
  id: string;
  source: "workflow" | "campaign" | "other";
  title: string;
  summary: string;
  createdAt: string;
  scheduledFor?: string;
  sourceId?: string;
}

/**
 * One lifecycle email flow, as the Coordinator sees it.
 *
 * Flows are authoritative marketing state: an existing Welcome or
 * Re-engagement flow suppresses the equivalent opportunity, so a daily cron can
 * never propose the same flow twice.
 */
export interface EmailFlowState {
  id: string;
  flowType: "welcome" | "re_engagement";
  name: string;
  status: "draft" | "active" | "paused" | "archived";
  createdBy: "user" | "coordinator";
  enrolled: number;
  activeEnrollments: number;
  nextScheduledAt: string | null;
  needsAttention: boolean;
  attentionReason?: string | null;
}

/** A lifecycle flow MARA could prepare. Always a proposal, never an action. */
export interface EmailFlowOpportunity {
  flowType: "welcome" | "re_engagement";
  reason: string;
  /** The existing flow that already covers this need, when there is one. */
  suppressedBy?: { flowId: string; name: string; status: string } | null;
}

export interface EmailMarketingState {
  eligibleContactsCount: number;
  recentCampaignCount: number;
  /** Last real send of any kind: campaign or lifecycle. */
  lastSentAt: string | null;
  scheduledEmailCount: number;
  opportunityAvailable: boolean;
  opportunityReason?: string;
  /** Live lifecycle flows (never archived). */
  flows: EmailFlowState[];
  /** Lifecycle emails currently scheduled to go out. */
  scheduledLifecycleEmailCount: number;
  /** Contacts currently inside a lifecycle flow. */
  activeLifecycleEnrollments: number;
  welcomeCovered: boolean;
  reEngagementCovered: boolean;
  /** Uncovered flow types MARA may prepare. Empty when everything is covered. */
  flowOpportunities: EmailFlowOpportunity[];
}

export interface PerformanceIntelligenceState {
  hasSufficientData: boolean;
  confidence: "low" | "moderate" | "none";
  sampleSize: number;
  bestContentTypeLabel?: string | null;
  strongestTopicLabel?: string | null;
  winnerLabels?: string[];
  underperformerLabels?: string[];
  timingAdvice?: {
    recommendedHours?: number[];
  };
}

export interface AuthoritativeMarketingState {
  ownerId: string;
  businessId: string;
  business: MarketingStateBusinessProfile;
  timezone: string;
  now: string;
  todayLocalDate: string;
  /**
   * Local date the cadence pattern is pinned to (the active plan's start, or
   * today when there is no plan). Optional for states rebuilt from older runs.
   */
  cadenceAnchorDate?: string;
  /**
   * Social commitments in the wider cadence window (today - 6 .. today + 12),
   * so every rolling 7-day window that touches the horizon is checked against
   * the cadence, including already-published and later-scheduled work.
   * Optional for states rebuilt from older runs (falls back to `commitments`).
   */
  cadenceCommitments?: CalendarCommitment[];
  horizonStart: string; // YYYY-MM-DD
  horizonEnd: string;   // YYYY-MM-DD
  cadence: Cadence;
  mode: AutomationModeValue;
  credits: CreditAvailability;
  commitments: CalendarCommitment[];
  activeCampaigns: ActiveCampaignState[];
  pendingApprovals: PendingApprovalState[];
  emailState: EmailMarketingState;
  performance: PerformanceIntelligenceState;
  currentPlanId: string | null;
}

export interface GapIdentification {
  date: string;
  recommendedFormat: ContentType;
  recommendedPublishAt: string;
  reason: string;
}

export interface CoordinatorDecision {
  type: CoordinatorNeedType;
  priority: number; // lower number = higher priority
  title: string;
  description: string;
  meta?: Record<string, unknown>;
}

export interface CoordinatorEvaluation {
  ownerId: string;
  businessId: string;
  state: AuthoritativeMarketingState;
  needs: CoordinatorDecision[];
  gaps: GapIdentification[];
  summaryMessage: string;
  canExecuteAutonomousWork: boolean;
}

export interface CoordinatorRunResult {
  evaluation: CoordinatorEvaluation;
  actionsTaken: {
    type: string;
    details: Record<string, unknown>;
  }[];
  idempotencyKey: string;
}
