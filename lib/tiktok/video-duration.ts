import { inspectVideoBytes } from "../media/media-inspect";

/** Browser metadata is advisory only; the stored bytes are authoritative. */
export const TIKTOK_DURATION_MATCH_TOLERANCE_SECONDS = 0.5;

export type TikTokDurationValidation =
  | { ok: true; durationSeconds: number }
  | { ok: false; code: "video_duration_unavailable" | "video_duration_mismatch" | "video_too_long" };

export function inspectTikTokVideoDuration(bytes: Uint8Array): number | null {
  const inspected = inspectVideoBytes(bytes);
  return inspected && Number.isFinite(inspected.durationSeconds) && inspected.durationSeconds > 0
    ? inspected.durationSeconds
    : null;
}

export function validateTikTokVideoDuration(input: {
  trustedDurationSeconds: number | null;
  reportedDurationSeconds?: number | null;
  maxDurationSeconds: number | null;
}): TikTokDurationValidation {
  const trusted = input.trustedDurationSeconds;
  const maximum = input.maxDurationSeconds;
  if (typeof trusted !== "number" || !Number.isFinite(trusted) || trusted <= 0
      || typeof maximum !== "number" || !Number.isFinite(maximum) || maximum <= 0) {
    return { ok: false, code: "video_duration_unavailable" };
  }
  if (input.reportedDurationSeconds !== undefined) {
    const reported = input.reportedDurationSeconds;
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0
        || Math.abs(reported - trusted) > TIKTOK_DURATION_MATCH_TOLERANCE_SECONDS) {
      return { ok: false, code: "video_duration_mismatch" };
    }
  }
  if (trusted > maximum) return { ok: false, code: "video_too_long" };
  return { ok: true, durationSeconds: trusted };
}
