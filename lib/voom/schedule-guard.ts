/**
 * One scheduling guard for every surface that lets a user pick a publish date
 * and time (Post Studio editor, calendar composer, approval edit dialogs) and
 * for the API routes that persist those choices.
 *
 * Rules, enforced identically on the client and the server:
 *   - the date must be a real calendar date, today or later in the BUSINESS
 *     timezone (never the viewer's device timezone),
 *   - when scheduling for today, the time must be later than the current
 *     business-local time (a small lead absorbs submission latency),
 *   - the time must be a real HH:MM value.
 *
 * Pure: no I/O, no server-only imports, so the same code is unit tested in
 * `tests/production-readiness.test.mjs`.
 */

import { DEFAULT_TIMEZONE, localDate, localMinutes, localToUtcIso } from "./timezone.ts";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface ScheduleInput {
  /** Local YYYY-MM-DD in the business timezone. */
  date: string;
  /** Local HH:MM (24h) in the business timezone. */
  time: string;
  /** Current instant; defaults to real "now". Tests pass a fixed Date. */
  now?: Date;
  /** Business timezone; defaults to the account default (Asia/Dubai). */
  timeZone?: string;
  /** Minimum minutes into the future for a same-day time. Default 1. */
  leadMinutes?: number;
}

export type ScheduleResult =
  | { ok: true; /** Absolute UTC instant for the chosen local date/time. */ publishAt: string }
  | { ok: false; error: string; field: "date" | "time" };

/** "YYYY-MM-DD" of the current local date in the business timezone. */
export function currentScheduleDate(now: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  return localDate(now, timeZone);
}

/** The `min` value for a date input: the current local date, never earlier. */
export function minScheduleDate(now: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE): string {
  return currentScheduleDate(now, timeZone);
}

/**
 * The `min` value for a time input when the chosen date is today, or
 * undefined for future dates (any time of day is allowed then).
 */
export function minScheduleTime(date: string, now: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE, leadMinutes = 1): string | undefined {
  if (!DATE_RE.test(date)) return undefined;
  if (date !== localDate(now, timeZone)) return undefined;
  const minutes = localMinutes(now, timeZone) + leadMinutes;
  return `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/**
 * Validates a user-chosen schedule. Returns the absolute UTC instant to store,
 * or an actionable error that names what is wrong.
 */
export function checkSchedule(input: ScheduleInput): ScheduleResult {
  const timeZone = input.timeZone ?? DEFAULT_TIMEZONE;
  const now = input.now ?? new Date();
  const lead = input.leadMinutes ?? 1;
  const date = input.date.trim();

  // Round-trip guard rejects impossible calendar dates (e.g. 2026-02-30).
  const parsed = Date.parse(`${date}T00:00:00Z`);
  if (!DATE_RE.test(date) || !Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    return { ok: false, error: "Choose a valid calendar date for this post.", field: "date" };
  }
  const today = localDate(now, timeZone);
  if (date < today) {
    return { ok: false, error: "That date has already passed. Choose today or a future date.", field: "date" };
  }

  const time = input.time.trim();
  if (!TIME_RE.test(time)) {
    return { ok: false, error: "Choose a time for this post.", field: "time" };
  }
  if (date === today) {
    const [hour, minute] = time.split(":").map(Number);
    const chosen = hour * 60 + minute;
    const floor = localMinutes(now, timeZone) + lead;
    if (chosen < floor) {
      return {
        ok: false,
        error: `That time has already passed today. Choose a later time — it is now ${formatClock(localMinutes(now, timeZone))} in your business timezone.`,
        field: "time",
      };
    }
  }

  const [hour, minute] = time.split(":").map(Number);
  return { ok: true, publishAt: localToUtcIso(date, hour * 60 + minute, timeZone) };
}

/** True when an absolute UTC instant is already before "now" (with tolerance). */
export function isPastInstant(iso: string | null | undefined, now: Date = new Date(), toleranceMs = 60_000): boolean {
  if (!iso) return false;
  const value = Date.parse(iso);
  return Number.isFinite(value) && value < now.getTime() - toleranceMs;
}

/**
 * Validates an absolute UTC instant (e.g. one produced by `normalizeSchedule`
 * or a JSON `publishAt`) against the same rules, in the business timezone.
 * API routes use this so client and server enforce identical policies.
 */
export function checkScheduleInstant(iso: string, now: Date = new Date(), timeZone: string = DEFAULT_TIMEZONE, leadMinutes = 1): ScheduleResult {
  const value = new Date(iso);
  if (Number.isNaN(value.getTime())) {
    return { ok: false, error: "That schedule date is not valid.", field: "date" };
  }
  return checkSchedule({ date: localDate(value, timeZone), time: toTimeInputValue(value, timeZone), now, timeZone, leadMinutes });
}

function toTimeInputValue(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(at);
  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";
  return `${hour}:${minute}`;
}

function formatClock(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour < 12 ? "AM" : "PM";
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, "0")} ${suffix}`;
}
