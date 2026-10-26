/** Provider queue facts only; approval is never evidence of publication. */
export const LINKEDIN_STATUS_LABELS: Record<string, string> = {
  scheduled: "Scheduled", claimed: "Preparing submission", submitting: "Submitting to LinkedIn", published: "Published",
  failed: "Failed", permission_required: "Reconnect required", cancelled: "Cancelled", uncertain: "Check LinkedIn — result unknown",
};
