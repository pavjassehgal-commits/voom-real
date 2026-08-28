export type MediaType = "image" | "video";
export type MediaAspectRatio = "1:1" | "4:5" | "9:16" | "16:9";
export type MediaGenerationStatus = "pending_confirmation" | "queued" | "processing" | "completed" | "failed" | "cancelled";

export interface MediaGenerationRecord {
  id: string;
  conversation_id: string;
  message_id: string | null;
  draft_id: string | null;
  media_type: MediaType;
  prompt: string;
  aspect_ratio: MediaAspectRatio;
  status: MediaGenerationStatus;
  approval_status: "draft" | "approved" | "rejected";
  mime_type: string | null;
  estimated_cost_usd: number | null;
  duration_seconds: number | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  asset_url: string | null;
}

export interface GeneratedMedia {
  kind: "complete";
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp" | "video/mp4";
}

export interface PendingMedia {
  kind: "pending";
  providerJobId: string;
}

export interface MediaProvider {
  generateImage(input: { prompt: string; aspectRatio: MediaAspectRatio }): Promise<GeneratedMedia>;
  generateVideo(input: { prompt: string; aspectRatio: MediaAspectRatio; durationSeconds: number }): Promise<GeneratedMedia | PendingMedia>;
  pollVideo(providerJobId: string): Promise<GeneratedMedia | PendingMedia>;
}

export type MediaErrorCode = "not_configured" | "rate_limited" | "unavailable" | "malformed_response" | "rejected";

export class MediaError extends Error {
  constructor(public readonly code: MediaErrorCode) {
    super(code);
    this.name = "MediaError";
  }
}
