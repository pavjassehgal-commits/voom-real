/**
 * Test-only fixture: the FIVE redesigned Voom 2.0 core workspace surfaces,
 * rendered from realistic account state inside the REAL shell.
 *
 * Nothing here re-implements the product. Every surface is the shipped
 * component (Marketing Plan workspace, Content Calendar page, Studio page,
 * Performance view, Approvals board) and every value below is shaped exactly
 * like the authoritative read model it comes from:
 *
 *   - `planSnapshot()`      — the shared workflow snapshot
 *   - `calendarPayload()`   — the workflow payload `{ snapshot, socialItems }`
 *   - `studioPayload()`     — the studio payload `{ posts }`
 *   - `performanceReport()` — built by the REAL report builder
 *   - `approvalItems()`     — the real action feed
 *
 * The rendered measurement suites therefore measure the shipped product at a
 * real viewport, not a mock of it.
 */
import type { ReactNode } from "react";
import { Providers } from "@/app/app/Providers";
import { AppShell } from "@/components/voom/shell/AppShell";
import { PlanWorkspace, type ChannelReadiness } from "@/components/voom/operating/PlanWorkspace";
import { ApprovalsWorkspace } from "@/components/voom/operating/ApprovalsWorkspace";
import type { ApprovalItem } from "@/components/voom/operating/ApprovalsBoard";
import CalendarPage from "@/app/app/(shell)/calendar/page";
import StudioPage from "@/app/app/(shell)/studio/page";
import { PerformanceView } from "@/app/app/(shell)/performance/page";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import type { SocialCalendarItemView } from "@/lib/social/server-drafts";
import type { BusinessRecord } from "@/lib/voom/types";
import { buildPerformanceReport, type PerformanceMeasurement, type PerformanceReport } from "@/lib/performance/insights";

export const TODAY = "2026-09-24";

export function businessRecord(overrides: Partial<BusinessRecord> = {}): BusinessRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    owner_user_id: "00000000-0000-4000-8000-000000000002",
    brand_name: "Ada Analytics",
    brand_description: "Analytics for independent retailers.",
    industry: "Retail",
    target_customer: ["store owners"],
    main_goal: "more signups",
    brand_personality: ["direct"],
    preferred_channels: ["instagram", "tiktok"],
    monthly_ad_budget: "500",
    content_frequency: "3x_week",
    automation_level: "assisted",
    publishing_permission: "approve_each_post",
    plan: "max",
    onboarding_completed: true,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/* ──────────────────────────────────────────────────────────────
   Marketing Plan — the real rolling horizon
   ────────────────────────────────────────────────────────────── */

/** One real workflow row, with every field the shared read model returns. */
export function planItem(overrides: Partial<WorkflowView> & { draftId: string }): WorkflowView {
  const day = overrides.slotDate ?? TODAY;
  return {
    slotDate: day,
    channel: "instagram",
    format: "post",
    channelLabel: "Instagram",
    contentType: "post",
    contentTypeLabel: "Instagram Post",
    sourceLabel: "Marketing Plan",
    sourceId: null,
    sourceItemKey: day,
    concept: "A real planned concept",
    caption: "A real caption Voom prepared for this item.",
    description: "",
    script: [],
    publishAt: `${day}T18:30:00+04:00`,
    localDate: day,
    localTime: "6:30 PM",
    dayLabel: "Today",
    status: "scheduled",
    statusLabel: "Scheduled",
    failedStage: null,
    failureMessage: null,
    missedReason: null,
    approvalActionId: null,
    hasMedia: true,
    instagramMediaId: null,
    mediaStatus: null,
    mediaPreviewUrl: null,
    mediaMimeType: null,
    mediaFromMara: true,
    queueStatus: null,
    mediaDisplayName: null,
    production: null,
    ...overrides,
  } as WorkflowView;
}

/** Seven executable items across all five social formats — the densest plan. */
export function planItems(): WorkflowView[] {
  return [
    planItem({ draftId: "d-1", slotDate: "2026-09-24", localDate: "2026-09-24", dayLabel: "Today", channel: "instagram", format: "reel", contentType: "reel", contentTypeLabel: "Instagram Reel", concept: "Why speed beats price for retailers", status: "needs_approval", statusLabel: "Needs approval", hasMedia: true }),
    planItem({ draftId: "d-2", slotDate: "2026-09-25", localDate: "2026-09-25", dayLabel: "Tomorrow", channel: "tiktok", format: "video", contentType: "video", contentTypeLabel: "TikTok Video", concept: "Three checkout mistakes costing you sales", status: "waiting_for_media", statusLabel: "Waiting for media", hasMedia: false, mediaFromMara: false }),
    planItem({ draftId: "d-3", slotDate: "2026-09-26", localDate: "2026-09-26", dayLabel: "Sat", channel: "youtube", format: "short", contentType: "short", contentTypeLabel: "YouTube Short", concept: "The 30-second stocktake", status: "generating", statusLabel: "Generating", hasMedia: false, mediaStatus: "generating" }),
    planItem({ draftId: "d-4", slotDate: "2026-09-27", localDate: "2026-09-27", dayLabel: "Sun", channel: "instagram", format: "story", contentType: "story", contentTypeLabel: "Instagram Story", concept: "Behind the counter on a Saturday", status: "scheduled", statusLabel: "Scheduled" }),
    planItem({ draftId: "d-5", slotDate: "2026-09-28", localDate: "2026-09-28", dayLabel: "Mon", channel: "youtube", format: "video", contentType: "video", contentTypeLabel: "YouTube Video", concept: "A full walkthrough of the week's numbers", status: "missed", statusLabel: "Missed", missedReason: "Its scheduled time passed while the provider was unreachable." }),
    planItem({ draftId: "d-6", slotDate: "2026-09-29", localDate: "2026-09-29", dayLabel: "Tue", channel: "instagram", format: "post", contentType: "post", contentTypeLabel: "Instagram Post", concept: "One number every retailer should watch", status: "published", statusLabel: "Published", instagramMediaId: "ig-media-1", queueStatus: "published" }),
    planItem({ draftId: "d-7", slotDate: "2026-09-30", localDate: "2026-09-30", dayLabel: "Wed", channel: "tiktok", format: "video", contentType: "video", contentTypeLabel: "TikTok Video", concept: "What we learned from 200 basket sizes", status: "failed", statusLabel: "Failed", failedStage: "publishing", failureMessage: "The provider rejected the upload. Nothing was published twice." }),
  ];
}

export function planSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    timeZone: "Asia/Dubai",
    today: TODAY,
    cadence: "daily",
    cadenceLabel: "Daily",
    mode: "assisted",
    selectedChannels: ["instagram", "tiktok", "youtube"],
    planId: "plan-1",
    planGoal: "more signups",
    planValidFrom: TODAY,
    planValidUntil: "2026-09-30",
    planDraftIds: planItems().map((item) => item.draftId),
    items: planItems(),
    ...overrides,
  };
}

/** The real per-channel connection truth, as the plan page reads it. */
export function channelReadiness(overrides: ChannelReadiness[] = []): ChannelReadiness[] {
  if (overrides.length) return overrides;
  return [
    { channel: "instagram", connected: true, configured: true },
    { channel: "tiktok", connected: false, configured: true },
    { channel: "youtube", connected: false, configured: false },
  ];
}

export function planSurface(): ReactNode {
  return (
    <PlanWorkspace
      initial={planSnapshot()}
      uncoveredDates={["2026-09-27"]}
      channelReadiness={channelReadiness()}
    />
  );
}

/* ──────────────────────────────────────────────────────────────
   Content Calendar — the payload `GET /api/voom/workflow` returns
   ────────────────────────────────────────────────────────────── */

export function socialItems(): SocialCalendarItemView[] {
  return [
    {
      draftId: "s-1", calendarItemId: "c-1", kind: "tiktok_video", channel: "tiktok", format: "video",
      contentTypeLabel: "TikTok Video", sourceLabel: "Studio",
      media: { displayName: "counter-tour.mp4", mimeType: "video/mp4" },
      queueStatus: "scheduled", queueFailureMessage: null,
      concept: "A 12-second counter tour", caption: "Come behind the counter with us.",
      scheduledAt: "2026-09-25T19:15:00+04:00", localDate: "2026-09-25", localTime: "7:15 PM", dayLabel: "Tomorrow",
      statusLabel: "Scheduled with TikTok",
    },
    {
      draftId: "s-2", calendarItemId: "c-2", kind: "youtube_short", channel: "youtube", format: "short",
      contentTypeLabel: "YouTube Short", sourceLabel: "Marketing Plan",
      media: null,
      queueStatus: "waiting_for_media", queueFailureMessage: null,
      concept: "The 30-second stocktake", caption: "",
      scheduledAt: "2026-09-28T18:00:00+04:00", localDate: "2026-09-28", localTime: "6:00 PM", dayLabel: "Mon",
      statusLabel: "Waiting for media",
    },
  ];
}

/**
 * The payload `GET /api/instagram/publishing-queue` returns: one item past its
 * scheduled time (so the truthful "never dropped or published twice" note is
 * exercised) and one Meta-confirmed published item.
 */
export function publishingQueuePayload() {
  return {
    items: [
      {
        id: "q-1", draftId: "d-1", title: "Why speed beats price", type: "Reel", account: "@ada.analytics",
        scheduledAt: "2026-09-20T14:30:00.000Z", status: "scheduled", statusLabel: "Scheduled", tone: "blue",
        autoPublish: true, attempts: 0, publishedAt: null, failureReason: null, thumbnailUrl: null,
      },
      {
        id: "q-2", draftId: "d-6", title: "One number every retailer should watch", type: "Instagram Post",
        account: "@ada.analytics", scheduledAt: "2026-09-18T14:30:00.000Z", status: "published",
        statusLabel: "Published", tone: "green", autoPublish: false, attempts: 1,
        publishedAt: "2026-09-18T14:31:00.000Z", failureReason: null, thumbnailUrl: null,
      },
    ],
    account: "@ada.analytics",
    connected: true,
    configured: true,
    canPublish: true,
    missingPermission: null,
  };
}

export function calendarPayload(): { snapshot: WorkflowSnapshot; socialItems: SocialCalendarItemView[] } {
  return { snapshot: planSnapshot(), socialItems: socialItems() };
}

/* ──────────────────────────────────────────────────────────────
   Create/Studio — the payload `GET /api/posts` returns
   ────────────────────────────────────────────────────────────── */

export function studioPayload() {
  const post = (overrides: Record<string, unknown>) => ({
    id: "p-1", kind: "instagram_post", typeLabel: "Instagram Post", concept: "A real draft concept",
    format: "post", originLabel: "Studio", internalState: "draft", internalStateLabel: "Draft",
    scheduledAt: null, visualReady: true,
    visual: { previewUrl: null, mimeType: "image/jpeg", displayName: "visual.jpg" },
    updatedAt: "2026-09-24T09:00:00.000Z", ...overrides,
  });
  return {
    posts: [
      post({ id: "p-1" }),
      post({ id: "p-2", kind: "reel", typeLabel: "Instagram Reel", concept: "Speed beats price", format: "reel", internalState: "ready_to_publish", internalStateLabel: "Ready to publish", scheduledAt: "2026-09-25T18:30:00+04:00" }),
      post({ id: "p-3", kind: "story", typeLabel: "Instagram Story", concept: "Saturday behind the counter", format: "story", internalState: "scheduled_internal", internalStateLabel: "Scheduled in Voom", scheduledAt: "2026-09-27T12:00:00+04:00" }),
      post({ id: "p-4", kind: "tiktok_video", typeLabel: "TikTok Video", concept: "Three checkout mistakes", format: "video", internalState: "approved", internalStateLabel: "Approved", visualReady: false, visual: null }),
      post({ id: "p-5", kind: "youtube_short", typeLabel: "YouTube Short", concept: "The 30-second stocktake", format: "short", internalState: "draft", visualReady: false, visual: null }),
      post({ id: "p-6", kind: "youtube_video", typeLabel: "YouTube Video", concept: "Weekly numbers walkthrough", format: "video", internalState: "draft", visualReady: false, visual: null }),
    ],
  };
}

/* ──────────────────────────────────────────────────────────────
   Performance — the real report builder over real measurements
   ────────────────────────────────────────────────────────────── */

export function performanceReport(): PerformanceReport {
  const published = (day: number) => `2026-09-${String(day).padStart(2, "0")}T15:00:00.000Z`;
  const measurements: PerformanceMeasurement[] = [
    { instagramMediaId: "m-1", draftId: "d-1", contentType: "reel", title: "Why speed beats price", caption: "payment speed", publishedAt: published(20), collectedAt: published(21), metrics: { reach: 1840, likes: 96, comments: 12, saves: 31, shares: 14, total_interactions: 153 }, sources: {} },
    { instagramMediaId: "m-2", draftId: "d-2", contentType: "reel", title: "Three checkout mistakes", caption: "checkout speed", publishedAt: published(18), collectedAt: published(19), metrics: { reach: 1520, likes: 71, comments: 9, saves: 22, shares: 11, total_interactions: 113 }, sources: {} },
    { instagramMediaId: "m-3", draftId: "d-3", contentType: "post", title: "One number to watch", caption: "weekly reporting", publishedAt: published(15), collectedAt: published(16), metrics: { reach: 640, likes: 18, comments: 3, saves: 6, shares: 2, total_interactions: 29 }, sources: {} },
    { instagramMediaId: "m-4", draftId: "d-4", contentType: "post", title: "Weekend trading hours", caption: "trading hours", publishedAt: published(13), collectedAt: published(14), metrics: { reach: 520, likes: 12, comments: 1, saves: 4, shares: 1, total_interactions: 18 }, sources: {} },
    { instagramMediaId: "m-5", draftId: "d-5", contentType: "story", title: "Behind the counter", caption: "behind the scenes", publishedAt: published(11), collectedAt: published(12), metrics: { reach: 410, likes: 9, comments: 0, saves: 1, shares: 2, total_interactions: 12 }, sources: {} },
    { instagramMediaId: "m-6", draftId: "d-6", contentType: "reel", title: "Stocktake in 30 seconds", caption: "stocktake", publishedAt: published(9), collectedAt: published(10), metrics: { reach: 1310, likes: 64, comments: 7, saves: 19, shares: 8, total_interactions: 98 }, sources: {} },
  ];
  return buildPerformanceReport({ measurements, publishedWithoutMetrics: 2, now: new Date("2026-09-24T06:00:00.000Z"), windowDays: 30 });
}

/** YouTube's real stored provider rows, or `null` when the read is unavailable. */
export function youTubeRows() {
  return [
    { videoId: "yt-1", contentType: "video", publishedAt: "2026-09-18T12:00:00.000Z", collectedAt: "2026-09-24T03:00:00.000Z", metrics: { views: 4120, likes: 210, comments: 18 } },
    { videoId: "yt-2", contentType: "short", publishedAt: "2026-09-20T12:00:00.000Z", collectedAt: "2026-09-24T03:00:00.000Z", metrics: { views: 2380, likes: 143 } },
  ];
}

export function performanceSurface({ youTube = youTubeRows() as unknown as never[] | null } = {}): ReactNode {
  return <PerformanceView report={performanceReport()} youTube={youTube as never} />;
}

/* ──────────────────────────────────────────────────────────────
   Approvals — the real owner-scoped action feed
   ────────────────────────────────────────────────────────────── */

export function approvalItems(): ApprovalItem[] {
  return [
    {
      id: "a-1", tool_name: "propose_calendar_item",
      summary: "Voom proposes publishing “Why speed beats price” to Instagram",
      old_value: { publishAt: "2026-09-25T14:30:00.000Z" },
      new_value: {
        content: "Speed is the feature your customers actually feel. Here is what a two-second faster checkout did for three retailers on our street — and the one number to watch this week.",
        publishAt: "2026-09-25T14:30:00.000Z", sourceDraftId: "d-1", channel: "Instagram Reel",
        topic: "Checkout speed", reason: "This keeps the proposed content timing aligned with your current plan.",
      },
      status: "pending", result_summary: null, error_summary: null, created_at: "2026-09-24T05:00:00.000Z",
    },
    {
      id: "a-2", tool_name: "approve_content",
      summary: "MARA needs your approval before scheduling this week's Story",
      old_value: null,
      new_value: { title: "Behind the counter on a Saturday", reason: "Stories keep the account active between Reels." },
      status: "pending", result_summary: null, error_summary: null, created_at: "2026-09-24T04:00:00.000Z",
    },
    {
      id: "a-3", tool_name: "publish_calendar_item",
      summary: "Retry publishing the TikTok video Voom could not upload",
      old_value: null,
      new_value: { content: "Three checkout mistakes costing you sales.", publishAt: "2026-09-26T15:15:00.000Z", channel: "TikTok Video" },
      status: "failed", result_summary: null,
      error_summary: "The provider rejected the upload. Nothing was published and nothing was charged.",
      created_at: "2026-09-24T03:00:00.000Z",
    },
    {
      id: "a-4", tool_name: "propose_campaign",
      summary: "Voom prepared the October win-back campaign for review",
      old_value: null, new_value: { title: "October win-back", reason: "This prepares campaign work for review without sending it." },
      status: "confirmed", result_summary: "Approved by you on 22 September.", error_summary: null, created_at: "2026-09-22T06:00:00.000Z",
    },
  ];
}

export function approvalsSurface(): ReactNode {
  return <ApprovalsWorkspace initial={approvalItems()} reelTaskCount={1} />;
}

/* ──────────────────────────────────────────────────────────────
   The whole page: real Providers + real shell + the surface
   ────────────────────────────────────────────────────────────── */

export function ShellSurface({ children }: { children: ReactNode }) {
  return (
    <Providers initialDisplayName="Ada Lovelace" initialEmail="ada@example.com" initialBusiness={businessRecord()}>
      <AppShell>{children}</AppShell>
    </Providers>
  );
}

export function calendarSurface(): ReactNode {
  return <CalendarPage />;
}

export function studioSurface(): ReactNode {
  return <StudioPage />;
}

export type SurfaceName = "plan" | "calendar" | "studio" | "performance" | "approvals";

/** Component form, for rendering a chosen surface inside a wrapper. */
export function Surface({ name }: { name: SurfaceName }) {
  return <>{surface(name)}</>;
}

/** Plain-function form, for the client bundle entry (which picks per document). */
export function surface(name: SurfaceName): ReactNode {
  if (name === "plan") return planSurface();
  if (name === "calendar") return calendarSurface();
  if (name === "studio") return studioSurface();
  if (name === "performance") return performanceSurface();
  return approvalsSurface();
}

/** Every document the browser scenarios serve, keyed by the surface name. */
export const SURFACES: SurfaceName[] = ["plan", "calendar", "studio", "performance", "approvals"];
