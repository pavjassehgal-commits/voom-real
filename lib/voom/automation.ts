/**
 * Automation mode: the saved value AND how the product presents it.
 *
 * Authoritative definitions (v1 Plans + Credits + Clean Automation Modes):
 *
 * Manual:
 *   Meaning: The user controls execution.
 *   Allowed: explicit plan generation, explicit campaign generation, text/copy drafting,
 *            upload own assets, explicitly click Create with MARA
 *   Not allowed automatically: paid image generation, paid video generation,
 *            Instagram publishing, email sending, approvals, paid-media retries/new jobs
 *   Manual must never silently act like Assisted.
 *
 * Assisted:
 *   Meaning: MARA prepares everything; the user approves execution.
 *   Allowed automatically: planning, recommendations, captions, email drafts,
 *            campaign structure, proposed schedules
 *   NOT allowed automatically: Seedream submission, Seedance submission,
 *            any paid media generation, Instagram publishing, email sending
 *   Paid media must require an explicit user generation action.
 *
 * Autopilot:
 *   Meaning: MARA can run marketing end-to-end within hard limits.
 *   May: plan, draft, schedule, internally approve safe actions, publish/send
 *        according to existing safety rules, automatically generate paid media
 *   BUT automatic paid media allowed ONLY if ALL true:
 *     1. account plan supports Autopilot
 *     2. account plan supports automatic paid media
 *     3. allow_automatic_paid_media = true
 *     4. enough Voom credits are available
 *     5. generation fits within account credit limits
 *     6. existing safety rules allow the content
 *   Missing any condition = do not call provider. Planning continues even when blocked.
 *
 * The presentation data lives here so the active-card rule is pure and testable.
 */

export type AutomationModeValue = "manual" | "assisted" | "autopilot";

export function normalizeAutomationMode(value: string | null | undefined): AutomationModeValue {
  return value === "manual" || value === "autopilot" ? value : "assisted";
}

/** The one display order, shared by the segmented control and the cards. */
export const AUTOMATION_MODES: readonly AutomationModeValue[] = ["manual", "assisted", "autopilot"];

export const AUTOMATION_MODE_LABELS: Record<AutomationModeValue, string> = {
  manual: "Manual",
  assisted: "Assisted",
  autopilot: "Autopilot",
};

export const RECOMMENDED_AUTOMATION_MODE: AutomationModeValue = "assisted";

/**
 * Exact UI descriptions required by product spec.
 */
export const AUTOMATION_MODE_DESCRIPTIONS: Record<AutomationModeValue, string> = {
  manual: "You control execution. MARA helps when you ask.",
  assisted: "MARA prepares your marketing. You approve execution.",
  autopilot: "MARA runs your marketing within your limits.",
};

export const AUTOPILOT_CREDITS_WARNING =
  "Autopilot may use your Voom media credits to generate images and videos automatically within your limits.";

export interface AutomationModeCopy {
  value: AutomationModeValue;
  label: string;
  /** Exact product definition. */
  summary: string;
  /** Truthful paid-media statement for this mode. */
  media: string;
  warning?: string;
}

export const AUTOMATION_MODE_COPY: Record<AutomationModeValue, AutomationModeCopy> = {
  manual: {
    value: "manual",
    label: AUTOMATION_MODE_LABELS.manual,
    summary: AUTOMATION_MODE_DESCRIPTIONS.manual,
    media: "No automatic media generation. Voom plans and drafts only when you ask. Paid images and videos are created only from an explicit Create with MARA click, and only if your plan includes AI media credits.",
  },
  assisted: {
    value: "assisted",
    label: AUTOMATION_MODE_LABELS.assisted,
    summary: AUTOMATION_MODE_DESCRIPTIONS.assisted,
    media: "MARA prepares plans, captions, email drafts and proposed schedules automatically, then waits for your approval. Paid media generation (Seedream images, Seedance videos) requires an explicit user action — it never happens automatically in Assisted.",
  },
  autopilot: {
    value: "autopilot",
    label: AUTOMATION_MODE_LABELS.autopilot,
    summary: AUTOMATION_MODE_DESCRIPTIONS.autopilot,
    media: "MARA plans, drafts, schedules and auto-approves safe work, and may generate paid media automatically — but only if your plan supports Autopilot, automatic paid media is enabled, you have enough Voom credits, and safety rules allow the content. Planning continues even when media is blocked.",
    warning: AUTOPILOT_CREDITS_WARNING,
  },
};

export interface AutomationModeCard extends AutomationModeCopy {
  active: boolean;
  recommended: boolean;
}

export function automationModeCards(savedMode: AutomationModeValue): AutomationModeCard[] {
  return AUTOMATION_MODES.map((value) => ({
    ...AUTOMATION_MODE_COPY[value],
    active: value === savedMode,
    recommended: value === RECOMMENDED_AUTOMATION_MODE,
  }));
}

export function activeAutomationModeCard(savedMode: AutomationModeValue): AutomationModeCard {
  const card = automationModeCards(savedMode).find((c) => c.active);
  if (!card) throw new Error(`no_active_automation_mode_card:${savedMode}`);
  return card;
}

export function automationRunsAutomatically(mode: AutomationModeValue): boolean {
  // Assisted still runs scheduled planning (captions, drafts, schedules) — just not paid media.
  // Manual never runs on schedule.
  return mode === "assisted" || mode === "autopilot";
}

export const WORKFLOW_TRIGGERS = ["scheduled", "replenish"] as const;
export type WorkflowTrigger = (typeof WORKFLOW_TRIGGERS)[number];

/**
 * The ONE paid-media policy for a workflow run.
 * Answers: may this run submit a paid provider media generation WITHOUT explicit user request?
 *
 * Manual    → never
 * Assisted  → never (deliberate product change v1 — paid media requires explicit action)
 * Autopilot → yes, but final guard also checks plan, toggle, credits, safety
 */
export function mayAutomaticallyGeneratePaidMedia(mode: AutomationModeValue, trigger: WorkflowTrigger): boolean {
  if (mode !== "autopilot") return false;
  return trigger === "scheduled" || trigger === "replenish";
}

export function replenishPlanDescription(mode: AutomationModeValue): string {
  if (mode === "manual") {
    return "Replenish plan creates your upcoming content plan. Media is generated only when you ask MARA to create it.";
  }
  if (mode === "autopilot") {
    return "Replenish plan tops up your upcoming content plan. MARA may generate media automatically within your credit limits, and safe items are approved and scheduled for you.";
  }
  return "Replenish plan tops up your upcoming content plan. MARA prepares drafts and waits for your approval. Media is generated only when you ask MARA to create it.";
}

export interface AutomationModeChangeEffect {
  futureAutomationEnabled: boolean;
  futureAutoApproval: boolean;
  cancelsExistingSchedules: boolean;
  revokesExistingApprovals: boolean;
  deletesExistingMedia: boolean;
  message: string;
}

export function automationModeChangeEffect(
  previousMode: AutomationModeValue,
  nextMode: AutomationModeValue,
): AutomationModeChangeEffect {
  const futureAutomationEnabled = automationRunsAutomatically(nextMode);
  const stoppingAutomation = automationRunsAutomatically(previousMode) && !futureAutomationEnabled;
  const losingAutoApproval = previousMode === "autopilot" && nextMode !== "autopilot";

  const message = stoppingAutomation
    ? `Switched to ${AUTOMATION_MODE_LABELS[nextMode]}. Scheduled runs stop from now on — nothing new is planned, generated, approved or scheduled automatically. Items you already approved keep their schedules and will still publish, and media you already generated is kept.`
    : losingAutoApproval
      ? `Switched to ${AUTOMATION_MODE_LABELS[nextMode]}. Voom will no longer approve or schedule items by itself; new items wait for your approval. Items you already approved keep their schedules and will still publish.`
      : `Switched to ${AUTOMATION_MODE_LABELS[nextMode]}. This applies to future runs — your existing approvals, schedules and stored media are unchanged.`;

  return {
    futureAutomationEnabled,
    futureAutoApproval: nextMode === "autopilot",
    cancelsExistingSchedules: false,
    revokesExistingApprovals: false,
    deletesExistingMedia: false,
    message,
  };
}
