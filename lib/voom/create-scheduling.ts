/** The Create flow's exact save -> review-version -> approval handshake. */
export interface ScheduleResponse { post?: { contentVersion?: number }; scheduled?: boolean }
export async function scheduleReviewedPost(
  patch: (body: Record<string, unknown>) => Promise<ScheduleResponse>,
  input: { contentVersion?: number; scheduledAt: string | null; publishAt: string },
): Promise<void> {
  if (!Number.isSafeInteger(input.contentVersion) || Number(input.contentVersion) < 1) throw new Error("Refresh and review this post before approving.");
  const saved = await patch({ scheduledAt: input.publishAt, contentVersion: input.contentVersion });
  const expected = Number(input.contentVersion) + (input.scheduledAt && Date.parse(input.scheduledAt) === Date.parse(input.publishAt) ? 0 : 1);
  if (saved.post?.contentVersion !== expected) throw new Error("This post changed while its schedule was saved. Review the latest version before approving.");
  const approved = await patch({ action: "approve", contentVersion: expected });
  if (!approved.scheduled) throw new Error("Approval was recorded, but scheduling could not be verified. Refresh the content item to check its publishing status.");
}
