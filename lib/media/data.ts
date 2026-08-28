import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { MediaAspectRatio, MediaGenerationRecord, MediaType } from "./types";

export const MEDIA_SELECT = "id,conversation_id,message_id,draft_id,media_type,prompt,aspect_ratio,status,approval_status,mime_type,estimated_cost_usd,duration_seconds,created_at,updated_at,completed_at,storage_path";

export function inferMediaRequest(message: string): { mediaType: MediaType; aspectRatio: MediaAspectRatio; durationSeconds: number | null } | null {
  const value = message.toLowerCase();
  if (/\b(reel|video)\s+(script|concept|idea|plan|storyboard)\b/.test(value)) return null;
  const video = /\b(generate|create|make|produce|animate)\b[\s\S]{0,80}\b(video|reel|clip|animation)\b|\b(text[- ]to[- ]video)\b/.test(value);
  const image = /\b(generate|create|make|design|produce)\b[\s\S]{0,80}\b(image|picture|photo|graphic|visual|poster)\b|\b(text[- ]to[- ]image)\b/.test(value);
  if (!video && !image) return null;
  const mediaType: MediaType = video ? "video" : "image";
  const aspectRatio: MediaAspectRatio = /\b(landscape|16:9|wide)\b/.test(value) ? "16:9" : /\b(square|1:1)\b/.test(value) ? "1:1" : /\b(4:5|portrait post)\b/.test(value) ? "4:5" : "9:16";
  const requestedSeconds = Number(value.match(/\b(\d{1,2})\s*(?:second|sec|s)\b/)?.[1] ?? 8);
  return { mediaType, aspectRatio, durationSeconds: mediaType === "video" ? Math.min(Math.max(requestedSeconds, 4), 12) : null };
}

export async function toMediaView(admin: SupabaseClient, row: Record<string, unknown>): Promise<MediaGenerationRecord> {
  let assetUrl: string | null = null;
  if (row.status === "completed" && typeof row.storage_path === "string") {
    const { data } = await admin.storage.from("mara-media").createSignedUrl(row.storage_path, 3600);
    assetUrl = data?.signedUrl ?? null;
  }
  return {
    id: String(row.id), conversation_id: String(row.conversation_id), message_id: typeof row.message_id === "string" ? row.message_id : null,
    draft_id: typeof row.draft_id === "string" ? row.draft_id : null, media_type: row.media_type as MediaType,
    prompt: String(row.prompt), aspect_ratio: row.aspect_ratio as MediaAspectRatio, status: row.status as MediaGenerationRecord["status"],
    approval_status: row.approval_status as MediaGenerationRecord["approval_status"],
    mime_type: typeof row.mime_type === "string" ? row.mime_type : null,
    estimated_cost_usd: typeof row.estimated_cost_usd === "number" ? row.estimated_cost_usd : null,
    duration_seconds: typeof row.duration_seconds === "number" ? row.duration_seconds : null,
    created_at: String(row.created_at), updated_at: String(row.updated_at), completed_at: typeof row.completed_at === "string" ? row.completed_at : null,
    asset_url: assetUrl,
  };
}
