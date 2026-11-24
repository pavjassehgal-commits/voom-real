/** Approved scheduling policy. SQL equivalents in migration 0080 are tested. */
export const SCHEDULE_LEAD_MS = 60_000;
export const AUTOMATIC_PUBLISH_GRACE_MS = 20 * 60_000;
export const SCHEDULE_EXPIRED_CODE = "instagram_schedule_expired";
export const SCHEDULE_EXPIRED_MESSAGE = "The scheduled publishing window expired. Choose a new future time or Post now explicitly. Existing provider submissions are checked read-only.";
export function automaticPublishExpired(publishAt: string | null | undefined, now = Date.now()): boolean {
  const at = publishAt ? Date.parse(publishAt) : NaN;
  return !Number.isFinite(at) || now >= at + AUTOMATIC_PUBLISH_GRACE_MS;
}
