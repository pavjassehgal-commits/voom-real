/**
 * Automation mode: the saved value AND how the product presents it.
 *
 * The presentation data lives here rather than in JSX so the rule that matters
 * — "the descriptive card that is visually active is the card matching the
 * saved mode" — is a pure function the Node test suite can execute, instead of
 * a styling accident that only a human reviewing the page would notice. No mode
 * is ever hard-coded as active.
 *
 * Copy truthfulness: every statement below describes the shipped workflow
 * engine, not an intention —
 *   lib/voom/weekly-automation.ts      only `assisted`/`autopilot` accounts are
 *                                      picked up by the scheduled run,
 *   lib/voom/workflow/rolling-plan.ts  `manual` returns before any stage; for
 *                                      the automated modes `ensureMedia` runs
 *                                      before the approval split, so paid media
 *                                      generation happens without an approval,
 *   lib/voom/workflow/service.ts       `autoApproveAndSchedule` is Autopilot
 *                                      only and is gated by the one safety
 *                                      evaluator (lib/mara/autopilot-safety.ts),
 *   app/api/plan/route.ts              a Manual account that explicitly builds
 *                                      its plan gets an assisted-style run,
 *   lib/instagram/publishing.ts        publishing needs the connected
 *                                      account's own Instagram permission.
 *
 * Deliberately free of `server-only` and `@/` imports so the behaviour can be
 * executed directly by the Node test suite.
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

/**
 * The mode Voom recommends, and the mode it falls back to when a business row
 * has no usable `automation_level`. "Recommended" is a suggestion about
 * behaviour — it never means "this is your current mode".
 */
export const RECOMMENDED_AUTOMATION_MODE: AutomationModeValue = "assisted";

/**
 * The cost warning shown on the Autopilot card. Autopilot is the mode that both
 * generates media automatically and keeps the workflow moving without a
 * decision per item, so the credit consequence is stated on that card always —
 * before the switch, not only after it.
 */
export const AUTOPILOT_CREDITS_WARNING =
  "Autopilot may use connected AI provider credits to generate media automatically.";

export interface AutomationModeCopy {
  value: AutomationModeValue;
  label: string;
  /** What Voom does in this mode. */
  summary: string;
  /** The truthful paid-MARA-media-generation statement for this mode. */
  media: string;
  /** Present only on the card that carries the credits warning. */
  warning?: string;
}

export const AUTOMATION_MODE_COPY: Record<AutomationModeValue, AutomationModeCopy> = {
  manual: {
    value: "manual",
    label: AUTOMATION_MODE_LABELS.manual,
    summary: "Nothing runs on a schedule. Voom plans, drafts and generates only when you ask it to.",
    media: "No scheduled generation. Paid MARA media generation starts only from an explicit request — building your plan, Create with MARA, Regenerate or Post Studio.",
  },
  assisted: {
    value: "assisted",
    label: AUTOMATION_MODE_LABELS.assisted,
    summary: "Voom keeps your rolling plan topped up and drafts each slot, then waits for your approval before anything is scheduled or published.",
    media: "Paid MARA media generation can happen automatically on scheduled runs, before you approve. Approval is still required before scheduling or publishing.",
  },
  autopilot: {
    value: "autopilot",
    label: AUTOMATION_MODE_LABELS.autopilot,
    summary: "Everything Assisted does, plus Voom approves and schedules safe internal work and continues the workflow; anything risky stops in Approvals.",
    media: "Paid MARA media generation happens automatically on scheduled runs. Publishing to Instagram still requires your connected account's publishing permission.",
    warning: AUTOPILOT_CREDITS_WARNING,
  },
};

export interface AutomationModeCard extends AutomationModeCopy {
  /** True only for the card matching the saved mode. */
  active: boolean;
  /** True for the recommended default, independent of the saved mode. */
  recommended: boolean;
}

/**
 * The three descriptive cards for one saved mode, in display order.
 *
 * Exactly one card comes back `active` and it is always the card whose `value`
 * equals `savedMode` — so the highlighted card follows the saved mode (and the
 * segmented control, which reads the same state) and can never be pinned to
 * Assisted while Manual or Autopilot is stored.
 */
export function automationModeCards(savedMode: AutomationModeValue): AutomationModeCard[] {
  return AUTOMATION_MODES.map((value) => ({
    ...AUTOMATION_MODE_COPY[value],
    active: value === savedMode,
    recommended: value === RECOMMENDED_AUTOMATION_MODE,
  }));
}

/** The single card that must be visually active for one saved mode. */
export function activeAutomationModeCard(savedMode: AutomationModeValue): AutomationModeCard {
  const card = automationModeCards(savedMode).find((candidate) => candidate.active);
  if (!card) throw new Error(`no_active_automation_mode_card:${savedMode}`);
  return card;
}

/**
 * What changing the automation mode does to work that ALREADY EXISTS.
 *
 * The rule: a mode switch governs FUTURE automation only. Turning Autopilot
 * off stops Voom from approving, scheduling and generating on its own from
 * that moment — it does not reach back and withdraw items the user already
 * approved, cancel schedules they already accepted, or delete media already
 * paid for and stored.
 *
 * Both directions of the mistake are real damage. Retroactively cancelling
 * approved schedules silently destroys work the user asked for; equally,
 * leaving automation running after a switch to Manual keeps spending credits
 * the user just said to stop spending. So: existing commitments stand, future
 * automated runs stop.
 *
 * `automationRunsAutomatically` is the single predicate the scheduled runner
 * and the mode copy share, so the promise on the card and the behaviour of the
 * worker can never drift apart.
 */
export function automationRunsAutomatically(mode: AutomationModeValue): boolean {
  return mode === "assisted" || mode === "autopilot";
}

export interface AutomationModeChangeEffect {
  /** Scheduled/automated runs continue for this account after the change. */
  futureAutomationEnabled: boolean;
  /** Voom may approve and schedule items by itself after the change. */
  futureAutoApproval: boolean;
  /** Always false: a mode change never rewrites work that already exists. */
  cancelsExistingSchedules: boolean;
  /** Always false: already-approved items keep their approval. */
  revokesExistingApprovals: boolean;
  /** Always false: stored media is already paid for and is kept. */
  deletesExistingMedia: boolean;
  /** The truthful sentence shown when the mode is changed. */
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
