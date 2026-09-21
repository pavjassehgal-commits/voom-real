/**
 * The permissions Voom asks TikTok for when an account connects — least
 * privilege, and nothing else.
 *
 *   user.info.basic   read-only basic identity: open_id, union_id,
 *                     avatar_url (and avatar variants), display_name. This
 *                     is the authoritative provider identity — Voom stores
 *                     what TikTok itself returned, never user-typed text.
 *                     (After TikTok's user-info scope migration, basic is
 *                     exactly this field set and nothing more.)
 *   video.publish     the Content Posting API Direct Post: query creator
 *                     info, initialize a video post, transfer the media,
 *                     and poll the post status. It CANNOT read the
 *                     creator's video list, statistics, followers, or
 *                     delete anything.
 *
 * Deliberately ABSENT:
 *   video.upload         inbox/draft uploads — Voom Direct Posts on explicit
 *                        approval; it never pushes drafts behind the
 *                        creator's back.
 *   video.list           the Display API video list. Real per-post metrics
 *                        require this extra scope; Voom v1 prefers minimal
 *                        privilege and says "TikTok performance data
 *                        unavailable" truthfully instead of asking for more
 *                        power than publishing needs.
 *   user.info.profile    bio, follower counts, deep links — no publishing
 *                        use; not requested.
 */
export const TIKTOK_BASIC_SCOPE = "user.info.basic";
export const TIKTOK_PUBLISH_SCOPE = "video.publish";

export const TIKTOK_SCOPES = [TIKTOK_BASIC_SCOPE, TIKTOK_PUBLISH_SCOPE] as const;

/** True when the granted scopes permit querying creator info and posting. */
export function hasPublishPermission(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(TIKTOK_PUBLISH_SCOPE);
}

/** True when the granted scopes permit reading the basic user identity. */
export function hasBasicInfoPermission(scopes: readonly string[] | null | undefined): boolean {
  return Array.isArray(scopes) && scopes.includes(TIKTOK_BASIC_SCOPE);
}
