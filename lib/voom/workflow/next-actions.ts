/**
 * The one next-action engine for Marketing Plan items.
 *
 * Pure: given the shared workflow facts (the SAME facts every screen already
 * derives its status from), it returns the item's stage, the single most
 * useful next action, the supporting actions, and a compact user-facing
 * explanation of what MARA recommends, why, what will be produced, who
 * produces it, whether approval is required and when it publishes.
 *
 * No screen invents its own actions: Marketing Plan, Today, Approvals and the
 * Content Calendar all render from this engine plus the shared status, so the
 * same item always shows the same stage and the same choices everywhere.
 */

import {
  WORKFLOW_STATUS_LABELS,
  type WorkflowStatus,
} from "./state.ts";
import type { MaraProductionOption, ReelProductionMethod } from "@/lib/mara/reel-production";

export type PlanActionId =
  | "produce_with_mara"
  | "regenerate_media"
  | "film_yourself"
  | "upload_asset"
  | "approve_schedule"
  | "open_approvals"
  | "change_time"
  | "post_now"
  | "reschedule"
  | "cancel_schedule"
  | "retry_media"
  | "choose_production";

export interface PlanAction {
  id: PlanActionId;
  label: string;
  /** Compact expectation of what the action does, shown with the button. */
  hint?: string;
  tone?: "primary" | "outline" | "danger";
  disabled?: boolean;
  disabledReason?: string;
  /** For reels: the method this action selects in the production flow. */
  method?: ReelProductionMethod;
}

/** What MARA recommends and who is responsible, in one compact block. */
export interface PlanItemExplanation {
  /** What content will be produced (the concept, or MARA's adapted one). */
  what: string;
  /** Who physically produces it: Voom (MARA) or the user. */
  who: string;
  /** Why MARA recommends that production route. Null when not applicable. */
  why: string | null;
  /** Whether approval is required before anything publishes. */
  approval: string;
  /** The resolved publish moment label, once scheduled. */
  when: string | null;
  /** Whether Voom publishes automatically. */
  autoPublish: string;
}

export interface PlanItemActions {
  stage: WorkflowStatus;
  stageLabel: string;
  /** The "what happens next" sentence for this exact stage. */
  headline: string;
  /** Ordered actions; the first enabled one is the card's primary button. */
  actions: PlanAction[];
  explanation: PlanItemExplanation;
}

export type WorkflowMode = "manual" | "assisted" | "autopilot";

export interface ReelProductionFacts {
  /** MARA's recommended production method for this concept. */
  recommendedMethod: ReelProductionMethod | null;
  availableMethods: ReelProductionMethod[];
  selectedMethod: ReelProductionMethod | null;
  /** The resolved Create-with-MARA option (never silently absent). */
  maraOption: MaraProductionOption;
  /** Why filming (not MARA) is recommended, when it is. */
  recommendationReason?: string | null;
}

export interface PlanItemFacts {
  contentType: "post" | "reel" | "story";
  stage: WorkflowStatus;
  failedStage: "media" | "publishing" | "rejected" | null;
  mode: WorkflowMode;
  /** Absolute UTC publish instant (scheduled or recommended). */
  publishAt: string | null;
  /** Preformatted local labels, e.g. "Today" and "6:30 PM". */
  dayLabel?: string;
  localTime?: string;
  hasMedia: boolean;
  /** True when the stored media came from MARA (regeneratable). */
  mediaFromMara?: boolean;
  production?: ReelProductionFacts | null;
}

const APPROVAL_MODE_LINE: Record<WorkflowMode, string> = {
  autopilot: "Voom publishes safe content automatically; risky content stops here for your approval.",
  assisted: "Your approval is required before anything is scheduled or published.",
  manual: "You decide every step; Voom only prepares the work you ask for.",
};

/**
 * Resolves the complete in-place workflow for one item: stage, headline,
 * ordered actions and the compact explanation block.
 */
export function planItemActions(item: PlanItemFacts): PlanItemActions {
  const when = item.publishAt
    ? `${item.dayLabel ? `${item.dayLabel} at ` : ""}${item.localTime ?? ""}`.trim()
    : null;
  const explanation: PlanItemExplanation = {
    what: explanationWhat(item),
    who: explanationWho(item),
    why: explanationWhy(item),
    approval: APPROVAL_MODE_LINE[item.mode],
    when,
    autoPublish: explanationAutoPublish(item),
  };

  switch (item.stage) {
    case "planned":
    case "needs_content":
      return { stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS[item.stage], headline: headlineProduce(item), actions: produceActions(item), explanation };
    case "generating":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.generating,
        headline: "MARA is generating the visual. Nothing is published — the item stays right here until it is ready to review.",
        actions: [], explanation,
      };
    case "ready_for_review":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.ready_for_review,
        headline: item.mode === "assisted"
          ? `Review the content, then approve to schedule it for ${when ?? "your chosen time"}.`
          : `Ready to schedule for ${when ?? "your chosen time"}.`,
        actions: reviewActions(item), explanation,
      };
    case "needs_approval":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.needs_approval,
        headline: `Approve to schedule this for ${when ?? "your chosen time"}. Nothing publishes without you.`,
        actions: reviewActions(item), explanation,
      };
    case "scheduled":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.scheduled,
        headline: `Scheduled for ${when ?? "your chosen time"}. ${item.mode === "autopilot" ? "Voom will publish this automatically." : "Voom will publish it at the scheduled time."}`,
        actions: scheduledActions(item), explanation,
      };
    case "publishing":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.publishing,
        headline: "Publishing to Instagram right now. This card updates when Instagram confirms.",
        actions: [], explanation,
      };
    case "published":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.published,
        headline: `Published${when ? ` — it went out as planned` : ""}. Nothing further is required.`,
        actions: [], explanation,
      };
    case "missed":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.missed,
        headline: "Its scheduled time passed without publishing. Voom never publishes hours late on its own — post it now, pick a new time, or cancel.",
        actions: missedActions(item), explanation,
      };
    case "failed":
      return {
        stage: item.stage, stageLabel: WORKFLOW_STATUS_LABELS.failed,
        headline: item.failedStage === "media"
          ? "Media generation stopped safely. Nothing was published and a retry cannot double-charge you."
          : item.failedStage === "rejected"
            ? "This item was rejected, so it will not publish."
            : "Publishing stopped safely. Nothing was published twice.",
        actions: failedActions(item), explanation,
      };
    default:
      return { stage: "planned", stageLabel: WORKFLOW_STATUS_LABELS.planned, headline: headlineProduce(item), actions: produceActions(item), explanation };
  }
}

function headlineProduce(item: PlanItemFacts): string {
  if (item.contentType === "reel") {
    const recommended = item.production?.recommendedMethod ?? null;
    if (recommended === "film_yourself") {
      return item.production?.maraOption.state === "adapted"
        ? "Best result: film this one yourself — or let MARA generate an adapted animated version."
        : "Best result: film this one yourself, or upload an existing clip.";
    }
    if (item.production?.maraOption.state === "unavailable") return "This concept needs real footage — film it or upload a clip.";
    return "Create it with MARA, film it yourself, or upload an existing video.";
  }
  if (item.contentType === "story") return "Create it with MARA, or upload an existing image or video.";
  return "Create the image with MARA, or upload your own.";
}

/** Production choices for a planned item — every valid route stays visible. */
function produceActions(item: PlanItemFacts): PlanAction[] {
  const actions: PlanAction[] = [];
  if (item.contentType === "reel") {
    const option = item.production?.maraOption;
    const maraState = option?.state ?? "available";
    const disabled = maraState === "unavailable";
    actions.push({
      id: "produce_with_mara",
      label: "Create with MARA",
      hint: maraState === "adapted"
        ? `Adapted concept: ${option?.concept ?? "a branded animated explainer covering the same message."}`
        : maraState === "recommended"
          ? "Best result: MARA generates this concept directly."
          : option?.note ?? "MARA generates a clean branded video for this slot.",
      tone: "primary",
      disabled,
      disabledReason: option?.disabledReason ?? undefined,
    });
    actions.push({ id: "film_yourself", label: "Film it myself", hint: item.production?.recommendedMethod === "film_yourself" ? "Recommended for this concept." : "Voom gives you a short shot list.", tone: "outline", method: "film_yourself" });
    actions.push({ id: "upload_asset", label: "Upload existing video", hint: "One vertical clip is enough.", tone: "outline", method: "upload_asset" });
    return actions;
  }
  actions.push({
    id: "produce_with_mara",
    label: item.contentType === "story" ? "Create with MARA" : "Create image with MARA",
    hint: item.contentType === "story" ? "MARA generates a 9:16 story visual." : "MARA writes and generates the image via Seedream.",
    tone: "primary",
  });
  actions.push({
    id: "upload_asset",
    label: item.contentType === "story" ? "Upload image or video" : "Upload image",
    hint: "Stored privately in Voom; nothing is published.",
    tone: "outline",
  });
  return actions;
}

function reviewActions(item: PlanItemFacts): PlanAction[] {
  const actions: PlanAction[] = [
    { id: "approve_schedule", label: "Approve & schedule", hint: item.publishAt ? `Schedules for ${item.dayLabel ?? ""} ${item.localTime ?? ""}`.trim() : undefined, tone: "primary" },
  ];
  if (item.contentType === "reel" && !item.hasMedia) {
    actions.push({ id: "choose_production", label: "Production options", hint: "Create with MARA, film it yourself, or upload a clip.", tone: "outline" });
  }
  actions.push({ id: "change_time", label: "Change time", tone: "outline" });
  if (item.hasMedia) actions.push({ id: "regenerate_media", label: item.mediaFromMara === false ? "Replace media" : "Regenerate", tone: "outline" });
  actions.push({ id: "cancel_schedule", label: "Discard", tone: "danger" });
  return actions;
}

function scheduledActions(item: PlanItemFacts): PlanAction[] {
  const auto = item.mode === "autopilot" ? "Voom publishes it automatically at that time. " : "";
  return [
    { id: "change_time", label: "Change time", hint: `${auto}Moves the SAME item — no duplicate is created.` },
    { id: "cancel_schedule", label: "Cancel schedule", tone: "danger", hint: "Also removes it from the publishing queue. Published items are never cancelled." },
  ];
}

function missedActions(item: PlanItemFacts): PlanAction[] {
  return [
    { id: "post_now", label: "Post now", hint: "Publishes through the normal queue within minutes — never a second copy.", tone: "primary" },
    { id: "reschedule", label: "Reschedule", hint: item.localTime ? `Pick a new time instead of ${item.localTime}.` : "Pick a new time." },
    { id: "cancel_schedule", label: "Cancel", tone: "danger" },
  ];
}

function failedActions(item: PlanItemFacts): PlanAction[] {
  if (item.failedStage === "media") {
    return [
      { id: "retry_media", label: "Retry generation", hint: "Reuses the same protected identity, so a retry cannot double-bill.", tone: "primary" },
      { id: "upload_asset", label: item.contentType === "reel" ? "Upload existing video" : "Upload image", tone: "outline" },
    ];
  }
  if (item.failedStage === "rejected") return [];
  return [
    { id: "post_now", label: "Post now", hint: "Retries publishing through the queue. Idempotent: one publish identity per item.", tone: "primary" },
    { id: "reschedule", label: "Reschedule", tone: "outline" },
    { id: "cancel_schedule", label: "Cancel", tone: "danger" },
  ];
}

function explanationWhat(item: PlanItemFacts): string {
  if (item.contentType === "reel") {
    const option = item.production?.maraOption;
    if (option?.state === "adapted" && option.concept) return option.concept;
    return `A 9:16 Reel${option?.state === "unavailable" ? " filmed by you" : " generated from this concept"}.`;
  }
  if (item.contentType === "story") return "A 9:16 Instagram Story visual.";
  return "A 1:1 Instagram feed image with caption and CTA.";
}

function explanationWho(item: PlanItemFacts): string {
  if (item.contentType === "reel") {
    if (item.stage === "planned" || item.stage === "needs_content") {
      if (item.production?.maraOption.state === "unavailable") return "You (film or upload) — MARA cannot fabricate this one.";
      if (item.production?.recommendedMethod === "film_yourself") return "You for the authentic version; MARA for the adapted animated version.";
    }
    if (item.hasMedia && item.mediaFromMara === false) return "You (uploaded media).";
    return "Voom (MARA), unless you film or upload.";
  }
  if (item.hasMedia && item.mediaFromMara === false) return "You (uploaded media).";
  if (item.stage === "planned" || item.stage === "needs_content") return "Voom (MARA), or upload your own.";
  return "Voom (MARA).";
}

function explanationWhy(item: PlanItemFacts): string | null {
  if (item.contentType !== "reel") return null;
  const production = item.production;
  if (!production) return null;
  if (production.maraOption.state === "unavailable") return production.maraOption.disabledReason;
  if (production.recommendedMethod === "film_yourself") {
    return production.recommendationReason ?? "Authentic real-world footage performs best for this concept.";
  }
  if (production.recommendedMethod === "create_with_mara") return "MARA can produce this concept directly and consistently.";
  return null;
}

function explanationAutoPublish(item: PlanItemFacts): string {
  if (item.stage === "missed") return "No. Voom never publishes hours late on its own — you choose Post now or a new time.";
  if (item.stage === "scheduled" || item.stage === "publishing") return "Yes — after approval, the existing publishing queue posts it at the scheduled time.";
  return item.mode === "autopilot" ? "Safe content publishes automatically; anything risky stops for your approval." : "No — your approval is the trigger.";
}
