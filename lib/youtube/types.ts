export type YouTubeConnectionStatus = "connected" | "expired" | "revoked" | "error" | "disconnected";

/** The sanitized connection view — metadata only, never tokens or secrets. */
export interface YouTubeConnectionView {
  connected: boolean;
  configured: boolean;
  status: YouTubeConnectionStatus | "not_connected";
  channelId: string | null;
  channelTitle: string | null;
  channelHandle: string | null;
  thumbnailUrl: string | null;
  /** The scopes Google actually granted. */
  scopes: string[];
  accessTokenExpiresAt: string | null;
  defaultPrivacy: "public" | "private" | "unlisted" | null;
  defaultMadeForKids: boolean | null;
  /**
   * Google's unaudited-project restriction: when the API project has not
   * passed the YouTube API Services Compliance Audit, every upload is locked
   * to private viewing mode. Voom surfaces this truthfully instead of
   * promising public publishing Google would silently block.
   */
  projectAudited: boolean;
  lastSyncedAt: string | null;
  connectedAt: string | null;
}

/** One queue row, as the worker/flow layer consumes it. */
export interface YouTubeQueueRow {
  id: string;
  owner_user_id: string;
  draft_id: string;
  calendar_item_id: string | null;
  youtube_format: "short" | "video";
  title: string;
  description: string;
  privacy_status: string | null;
  made_for_kids: boolean | null;
  category_id: string;
  scheduled_at: string;
  status: string;
  idempotency_key: string;
  upload_session_url: string | null;
  upload_content_length: number | null;
  upload_bytes_sent: number;
  youtube_video_id: string | null;
  provider_upload_status: string | null;
  provider_privacy_status: string | null;
  provider_rejection_reason: string | null;
  provider_note: string | null;
  last_provider_check_at: string | null;
  attempts: number;
  last_attempt_at: string | null;
  claimed_at: string | null;
  failure_code: string | null;
  failure_message: string | null;
  published_at: string | null;
}
