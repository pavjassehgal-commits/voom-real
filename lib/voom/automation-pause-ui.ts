/** Client presentation only. Every snapshot comes from an owner-scoped server read. */
export type AutomationPauseSnapshot = { pausedAt: string | null } | null;
export type AutomationPauseUiState = {
  snapshot: AutomationPauseSnapshot;
  notice: { paused: boolean; text: string } | null;
};
export type AutomationPauseUiAction =
  | { type: "server"; snapshot: AutomationPauseSnapshot }
  | { type: "confirmed"; snapshot: AutomationPauseSnapshot; paused: boolean; text: string };

export function automationPauseUiReducer(state: AutomationPauseUiState, action: AutomationPauseUiAction): AutomationPauseUiState {
  const snapshot = action.snapshot;
  const paused = snapshot !== null && snapshot.pausedAt !== null;
  const notice = action.type === "confirmed" ? { paused: action.paused, text: action.text } : state.notice;
  return { snapshot, notice: snapshot !== null && notice?.paused === paused ? notice : null };
}
