/**
 * Assisted Mode: applying a user's confirmation of a draft approval card.
 *
 * Every publishable change to a draft — caption, title, format, schedule,
 * media brief, platform publishing metadata or the attached image/video —
 * advances `mara_drafts.content_version` inside the database (migration
 * 0059: guard_draft_approval_integrity + bump_draft_version_for_media). Each
 * approval card records the `contentVersion` it shows, read in the same row
 * read as the caption and schedule it displays.
 *
 * A confirmation therefore approves exactly that version or nothing: the
 * draft must still be at the card's version, and the status write is a
 * compare-and-swap on it. An edit or a media replacement that lands while
 * the card is being processed (even after the card was claimed, when the
 * editor's card refresh skips it) moves the version, the write matches zero
 * rows, and the confirmation fails closed with APPROVAL_STALE. A card from
 * before content versions existed carries no version and is treated as stale
 * once, so the owner re-confirms the current version.
 */

/** Thrown when a confirmed approval no longer matches its draft; nothing was approved. */
export const APPROVAL_STALE = "approval_stale";

/** Thrown when the post is not complete yet (its image/video is missing); nothing was approved. */
export const APPROVAL_INCOMPLETE = "approval_incomplete";

/** Instagram drafts publish with media; their approval must cover it. */
const MEDIA_REQUIRED_KINDS = new Set(["instagram_post", "reel", "story"]);
export function approvalRequiresMedia(kind: unknown): boolean {
  return typeof kind === "string" && MEDIA_REQUIRED_KINDS.has(kind);
}

export interface ApprovalDraftRow {
  content_version: number | string | null;
  status: string;
}

/** The version a card snapshot was shown at, or null when it has none. */
export function confirmedContentVersion(snapshot: Record<string, unknown>): number | null {
  const value = snapshot.contentVersion;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

/** True only when the card shows the draft's current content version. */
export function approvalCoversDraft(snapshot: Record<string, unknown>, draft: ApprovalDraftRow): boolean {
  const shown = confirmedContentVersion(snapshot);
  return shown !== null && Number(draft.content_version) === shown;
}

// The structural slice of the Supabase client this module uses.
interface DraftApprovalDb {
  from(table: string): {
    update(values: Record<string, unknown>): DraftUpdateChain;
  };
}
interface DraftUpdateChain {
  eq(column: string, value: unknown): DraftUpdateChain;
  neq(column: string, value: unknown): DraftUpdateChain;
  select(columns: string): { maybeSingle(): PromiseLike<{ data: { id: string } | null; error: unknown }> };
  then: PromiseLike<{ error: unknown }>["then"];
}

/**
 * Approves `draftId` at exactly the confirmed content version, then runs
 * `afterApprove` (calendar mirror). If that fails, our own approval is
 * undone (a status-only write does not move the version).
 */
export async function approveDraftFromConfirmedSnapshot<T>(
  db: DraftApprovalDb,
  ownerId: string,
  draftId: string,
  snapshot: Record<string, unknown>,
  draft: ApprovalDraftRow,
  afterApprove: () => Promise<T>,
): Promise<T> {
  if (!approvalCoversDraft(snapshot, draft)) throw new Error(APPROVAL_STALE);
  const version = confirmedContentVersion(snapshot) as number;
  const { data: approved, error } = await db.from("mara_drafts")
    .update({ status: "approved", approval_origin: "user" })
    .eq("owner_user_id", ownerId).eq("id", draftId)
    .eq("content_version", version).neq("status", "rejected")
    .select("id").maybeSingle();
  if (error) throw new Error("draft_approval_failed");
  if (!approved) throw new Error(APPROVAL_STALE);
  try {
    return await afterApprove();
  } catch (err) {
    await db.from("mara_drafts").update({ status: draft.status })
      .eq("owner_user_id", ownerId).eq("id", draftId).eq("content_version", version);
    throw err;
  }
}
