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
 * Legacy per-slot rotation, kept for callers that need a single slot's type
 * without horizon context. The rolling planner now balances the WHOLE horizon
 * (see `contentMixFor` + `assignContentTypes`), so a plan can never collapse
 * into one repeated format the way a fixed modulo rotation could.
 */
export function contentTypeForSlot(slotDate: string, index: number): ContentType {
  const seed = index + weekdayIndex(slotDate);
  if (seed % 5 === 4) return "story";
  if (seed % 3 === 1) return "reel";
  return "post";
}

export type ContentMix = Record<ContentType, number>;

/**
 * The strategic goal behind the plan, derived from the business's free-text
 * main goal. Reels reach new audiences, feed posts convert existing ones, and
 * Stories keep today's followers close — so the goal, not a fixed ratio,
 * tilts the mix (requirement: the distribution may depend on marketing goal,
 * business type and cadence).
 */
export type ContentGoalBias = "reach" | "conversion" | "community" | "balanced";

export function contentGoalBias(goal: string | null | undefined): ContentGoalBias {
  const raw = String(goal ?? "").toLowerCase();
  if (/\b(awareness|reach|growth|grow|followers?|visibility|exposure|audience|brand awareness|new customer|discover)\b/.test(raw)) return "reach";
  if (/\b(sales?|sell|conversion|conversions|bookings?|orders?|leads?|enquir\w*|inquir\w*|revenue|sign[- ]?ups?|promote|launch|offer)\b/.test(raw)) return "conversion";
  if (/\b(engagement|community|loyalty|retention|relationship|trust|interaction|connection)\b/.test(raw)) return "community";
  return "balanced";
}

/** Weights per content type for each goal bias. */
const GOAL_WEIGHTS: Record<ContentGoalBias, Record<ContentType, number>> = {
  reach: { post: 1, reel: 2, story: 0.5 },
  conversion: { post: 2, reel: 1, story: 0.5 },
  community: { post: 1, reel: 1, story: 1.5 },
  balanced: { post: 1.5, reel: 1, story: 0.5 },
};

/**
 * Deterministic, cadence- and goal-aware content mix for a horizon of `count`
 * items.
 *
 * Guarantees:
 *   - the counts always sum to exactly `count`,
 *   - a multi-item plan never collapses into a single content type (a 7-item
 *     daily plan always mixes at least two, normally three types),
 *   - Reels cannot dominate: their weight share caps at half the slots,
 *   - Stories and feed Posts appear meaningfully in a full 7-day plan,
 *   - the same (cadence, count, goal) always yields the same mix, so a
 *     re-run never reshuffles existing slots' types.
 */
export function contentMixFor(cadence: Cadence, count: number, goal: string | null | undefined): ContentMix {
  if (count <= 0) return { post: 0, reel: 0, story: 0 };
  if (count === 1) return { post: 1, reel: 0, story: 0 };
  const weights = GOAL_WEIGHTS[contentGoalBias(goal)];
  const raw: Record<ContentType, number> = {
    post: (weights.post / (weights.post + weights.reel + weights.story)) * count,
    reel: (weights.reel / (weights.post + weights.reel + weights.story)) * count,
    story: (weights.story / (weights.post + weights.reel + weights.story)) * count,
  };
  // Reels never dominate a plan without a strategic reason.
  const reelCap = Math.floor(count / 2);
  raw.reel = Math.min(raw.reel, reelCap);

  const mix: ContentMix = { post: 0, reel: 0, story: 0 };
  let assigned = 0;
  // Largest-remainder apportionment, then hand the residual slots to the type
  // with the largest lost fraction so the totals are exact.
  const order: ContentType[] = ["post", "reel", "story"];
  const remainders: { type: ContentType; fraction: number }[] = [];
  for (const type of order) {
    const floor = Math.floor(raw[type]);
    mix[type] = floor;
    assigned += floor;
    remainders.push({ type, fraction: raw[type] - floor });
  }
  remainders.sort((a, b) => b.fraction - a.fraction || order.indexOf(a.type) - order.indexOf(b.type));
  let next = 0;
  while (assigned < count) {
    mix[remainders[next % remainders.length].type] += 1;
    assigned += 1;
    next += 1;
  }
  return mix;
}

/**
 * Spreads a mix across `count` slots deterministically, keeping formats
 * interleaved so the same type rarely repeats back to back. Works like a
 * round-robin over queues ordered by scarcity: the scarcest remaining type is
 * always preferred unless it just appeared (then the next scarcest is used).
 * A single-type mix (1 item, or a forced cap) still fills straightforwardly.
 */
export function assignContentTypes(count: number, mix: ContentMix): ContentType[] {
  const queues: Record<ContentType, number> = { post: mix.post ?? 0, reel: mix.reel ?? 0, story: mix.story ?? 0 };
  const result: ContentType[] = [];
  let previous: ContentType | null = null;
  for (let index = 0; index < count; index += 1) {
    const remaining = (Object.entries(queues) as [ContentType, number][]).sort(
      ([typeA, a], [typeB, b]) => b - a || typeA.localeCompare(typeB),
    );
    const choice = remaining.find(([type, left]) => left > 0 && type !== previous)
      ?? remaining.find(([, left]) => left > 0);
    if (!choice) break;
    queues[choice[0]] -= 1;
    previous = choice[0];
    result.push(choice[0]);
  }
  return result;
}

/**
 * The full horizon's content types: balanced by cadence and goal, then spread
 * without back-to-back repetition wherever the mix allows it.
 */
export function planContentTypes(input: { cadence: Cadence; count: number; goal: string | null | undefined }): ContentType[] {
  return assignContentTypes(input.count, contentMixFor(input.cadence, input.count, input.goal));
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
