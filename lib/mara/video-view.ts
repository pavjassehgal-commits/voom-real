import { phaseForState, videoJobSafeError, type VideoJobPhase } from "./video-job";

/**
 * The ONLY shape of a generation job that reaches the browser: no provider
 * job ids, no storage paths, no prompts, no provider names beyond a neutral
 * status, no error specifics — just the phase, a safe message and a
 * short-lived signed preview URL.
 */
export interface ClientGenerationView {
  id: string;
  status: string;
  phase: VideoJobPhase;
  mediaType: "video";
  generationMode: string | null;
  durationSeconds: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  safeError: string | null;
  previewUrl: string | null;
}

export function toClientGenerationView(
  row: {
    id: string;
    status: string;
    generation_mode: string | null;
    duration_seconds: number | null;
    created_at: string;
    started_at: string | null;
    completed_at: string | null;
    error_code: string | null;
  },
  previewUrl: string | null,
): ClientGenerationView {
  return {
    id: row.id,
    status: row.status,
    phase: phaseForState(row.status),
    mediaType: "video",
    generationMode: row.generation_mode,
    durationSeconds: row.duration_seconds,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    safeError: videoJobSafeError(row.error_code),
    previewUrl,
  };
}
