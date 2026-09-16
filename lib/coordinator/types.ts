/**
 * Automation Intelligence / Coordinator v1 types
 */

import type { AutomationModeValue } from "@/lib/voom/automation";
import type { PlanId } from "@/lib/billing/plans";
import type { Cadence, ContentType } from "@/lib/voom/cadence";

export type CoordinatorNeedType =
  | "instagram_calendar_gap"
  | "campaign_needs_attention"
  | "pending_approval"
  | "email_opportunity"
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
  channel: "instagram_post" | "instagram_reel" | "instagram_story" | "email";
  format: ContentType;
  title: string;
  publishAt: string;
  localDate: string;
  localTime: string;
  status: "proposed" | "needs_approval" | "approved" | "scheduled" | "publishing" | "published" | "failed" | "waiting_for_media";
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

export interface EmailMarketingState {
  eligibleContactsCount: number;
  recentCampaignCount: number;
  lastSentAt: string | null;
  scheduledEmailCount: number;
  opportunityAvailable: boolean;
  opportunityReason?: string;
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
