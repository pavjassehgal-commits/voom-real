/**
 * Cadence-aware rolling plan maths.
 *
 * The user's chosen posting frequency — not a hardcoded "3 recommendations per
 * week" rule — decides how many executable content items exist inside the
 * rolling horizon and on which local dates they land. Everything here is pure
 * and deterministic: the same owner, cadence and horizon always produce the
 * same slots, so a second cron run in the same day reuses the existing items
 * instead of creating duplicates.
 */

import { addDays, daysBetween, weekdayIndex } from "./timezone.ts";

export const CADENCES = ["daily", "5x_week", "3x_week", "weekly"] as const;
export type Cadence = (typeof CADENCES)[number];

export const CADENCE_LABELS: Record<Cadence, string> = {
  daily: "Daily",
  "5x_week": "5x per week",
  "3x_week": "3x per week",
  weekly: "Weekly",
};

/** Items per rolling 7-day horizon for each cadence. */
export const CADENCE_PER_WEEK: Record<Cadence, number> = {
  daily: 7,
  "5x_week": 5,
  "3x_week": 3,
  weekly: 1,
};

export const DEFAULT_HORIZON_DAYS = 7;

/**
 * Maps whatever the account has saved (new cadence values, legacy onboarding
 * labels, or nothing) onto a supported cadence. Assisted/Autopilot accounts
 * that never picked one default to 3x per week rather than silently posting
 * every day.
 */
export function normalizeCadence(value: string | null | undefined): Cadence {
  const raw = (value ?? "").trim().toLowerCase();
  if (!raw) return "3x_week";
  if ((CADENCES as readonly string[]).includes(raw)) return raw as Cadence;
  if (/multiple times a day|twice daily|2x\s*\/?\s*day/.test(raw)) return "daily";
  if (/daily|every day|7\s*x/.test(raw)) return "daily";
  if (/5\s*x|five times/.test(raw)) return "5x_week";
  if (/2\s*[–-]\s*3|3\s*x|three times|few times a week/.test(raw)) return "3x_week";
  if (/few times a month|monthly|weekly|once a week|1\s*x/.test(raw)) return "weekly";
  return "3x_week";
}

/**
 * The local dates inside [startDate, startDate + horizonDays) that should carry
 * one executable item, beginning TODAY. Distribution is deterministic and
 * evenly spread: daily = every day, 5x = every day except two rest days, 3x =
 * roughly every other day, weekly = the first day of the horizon.
 */
export function slotDates(startDate: string, cadence: Cadence, horizonDays = DEFAULT_HORIZON_DAYS): string[] {
  const count = Math.min(CADENCE_PER_WEEK[cadence], horizonDays);
  if (count <= 0) return [];
  if (count >= horizonDays) return Array.from({ length: horizonDays }, (_, index) => addDays(startDate, index));
  // Even spread across the horizon; index 0 is always today so the plan always
  // has something executable on the current date.
  const offsets = new Set<number>();
  for (let index = 0; index < count; index += 1) {
    offsets.add(Math.round((index * horizonDays) / count));
  }
  // Rounding collisions are impossible for the supported cadences, but stay
  // defensive so a slot is never silently dropped.
  let probe = 0;
  while (offsets.size < count && probe < horizonDays) {
    if (!offsets.has(probe)) offsets.add(probe);
    probe += 1;
  }
  return [...offsets].sort((a, b) => a - b).slice(0, count).map((offset) => addDays(startDate, offset));
}

export const CONTENT_TYPES = ["post", "reel", "story"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];

/**
 * Deterministic content-type rotation across the horizon: mostly feed posts,
 * a Reel roughly every third item, a Story roughly every fifth. The same slot
 * index always produces the same type, so re-running planning never flips a
 * planned Reel into a Post.
 */
export function contentTypeForSlot(slotDate: string, index: number): ContentType {
  const seed = index + weekdayIndex(slotDate);
  if (seed % 5 === 4) return "story";
  if (seed % 3 === 1) return "reel";
  return "post";
}

/**
 * Recommended local publish minute-of-day. Evening slots perform best for the
 * SMB audiences Voom serves; Stories go slightly earlier, Reels slightly later.
 */
export function publishMinutesForSlot(contentType: ContentType, index: number): number {
  const base = contentType === "story" ? 12 * 60 + 30 : contentType === "reel" ? 19 * 60 : 18 * 60 + 30;
  return base + (index % 3) * 15;
}

/** Local minute-of-day used when today's usual slot time has already passed. */
export const LATE_SLOT_GRACE_MINUTES = 45;

/**
 * Resolves the minute-of-day for a slot, pushing today's item into the near
 * future when its usual time has already gone by. Returns null when there is
 * no valid remaining time today, so the caller can skip the slot instead of
 * scheduling a stale, already-past time.
 */
export function resolveSlotMinutes(
  input: { contentType: ContentType; index: number; isToday: boolean; nowMinutes: number },
): number | null {
  const usual = publishMinutesForSlot(input.contentType, input.index);
  if (!input.isToday) return usual;
  const earliest = input.nowMinutes + LATE_SLOT_GRACE_MINUTES;
  if (usual >= earliest) return usual;
  // Round up to the next quarter hour so today's item still publishes today.
  const rounded = Math.ceil(earliest / 15) * 15;
  return rounded <= 23 * 60 + 45 ? rounded : null;
}

/** True when a planned local date still belongs to the live horizon. */
export function isWithinHorizon(today: string, date: string, horizonDays = DEFAULT_HORIZON_DAYS): boolean {
  const delta = daysBetween(today, date);
  return delta >= 0 && delta < horizonDays;
}
