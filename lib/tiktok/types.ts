export type TikTokConnectionStatus = "connected" | "expired" | "revoked" | "error" | "disconnected";

/** The sanitized connection view — metadata only, never tokens or secrets. */
export interface TikTokConnectionView {
  connected: boolean;
  configured: boolean;
  status: TikTokConnectionStatus | "not_connected";
  /** The authoritative provider identity TikTok itself returned. */
  openId: string | null;
  displayName: string | null;
  avatarUrl: string | null;
  /** The creator's public username, from the last creator-info read. */
  creatorUsername: string | null;
  /** The scopes TikTok actually granted. */
  scopes: string[];
  accessTokenExpiresAt: string | null;
  refreshTokenExpiresAt: string | null;
  /** The owner's explicit privacy default (or null: declare per item). */
  defaultPrivacy: string | null;
  /**
   * Whether Voom's TikTok app has passed TikTok's content-sharing audit.
   * Until it does, TikTok restricts posts through it to SELF_ONLY
   * (private) viewership and caps posting users — surfaced truthfully.
   * The live provider response always remains authoritative.
   */
  appAudited: boolean;
  lastSyncedAt: string | null;
  connectedAt: string | null;
}

/** One queue row, as the worker/flow layer consumes it. */
export interface TikTokQueueRow {
  id: string;
  owner_user_id: string;
  draft_id: string;
  calendar_item_id: string | null;
  title: string;
  privacy_level: string | null;
  disable_comment: boolean | null;
  disable_duet: boolean | null;
  disable_stitch: boolean | null;
  brand_content_toggle: boolean | null;
  brand_organic_toggle: boolean | null;
  is_aigc: boolean | null;
  scheduled_at: string;
  status: string;
  idempotency_key: string;
  tiktok_publish_id: string | null;
  upload_url: string | null;
  upload_content_length: number | null;
  upload_bytes_sent: number;
  provider_status: string | null;
  provider_post_id: string | null;
  provider_fail_reason: string | null;
  provider_note: string | null;
  last_provider_check_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  claimed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  published_at: string | null;
}
