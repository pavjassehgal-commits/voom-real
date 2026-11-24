const APPROVAL_CONTENT_CHANGED = "approval_content_changed";

export function approvalErrorCode(message: string): string {
  return [APPROVAL_CONTENT_CHANGED, "approval_schedule_expired", "approval_invalid_state", "approval_queue_cancelled", "approval_timezone_unavailable", "approval_incomplete"]
    .find((code) => message.includes(code)) ?? "post_approve_failed";
}
export function approvalConflictMessage(code: string): string | null {
  if (code === APPROVAL_CONTENT_CHANGED) return "This content changed after you reviewed it. Nothing was approved. Review the latest version and approve again.";
  if (code === "approval_schedule_expired") return "This schedule has expired. Nothing was approved. Choose a future time with Change time or Edit, then review and approve again.";
  if (code === "approval_queue_cancelled") return "Publishing was cancelled. Changing the time cannot resume it. Open the platform editor, review the content and explicitly approve again.";
  if (code === "approval_invalid_state") return "This approval is no longer available. Refresh and review the current item before continuing.";
  if (code === "approval_timezone_unavailable") return "Your business timezone could not be verified. Nothing was approved. Check your business settings and retry.";
  if (code === "approval_incomplete") return "Review the complete content with its image or video before approving.";
  return null;
}
