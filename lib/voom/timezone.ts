/**
 * One timezone source of truth for the whole executable content workflow.
 *
 * Every date shown or planned by Voom (Marketing Plan, Today, Approvals,
 * Content Calendar, rolling automation, publishing) resolves "today" through
 * this module, so no screen can disagree with another and no date is ever
 * hardcoded. Until Voom supports user-selectable timezones, accounts resolve
 * to the business timezone and fall back to Asia/Dubai.
 *
 * Pure: no I/O, no server-only imports, so it is directly unit tested.
 */

export const DEFAULT_TIMEZONE = "Asia/Dubai";

const SUPPORTED = /^[A-Za-z_]+\/[A-Za-z_+\-0-9]+$/;

/** Resolves the account timezone. Unknown/blank values fall back to Asia/Dubai. */
export function accountTimezone(value?: string | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || !SUPPORTED.test(trimmed)) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: trimmed });
    return trimmed;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The real current local date in the account timezone, as YYYY-MM-DD. */
export function localDate(now: Date, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
}

/** Local wall-clock minutes since midnight in the account timezone. */
export function localMinutes(now: Date, timeZone = DEFAULT_TIMEZONE): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false }).formatToParts(now);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? "0");
  return hour * 60 + minute;
}

/** Adds whole days to a YYYY-MM-DD local date without touching UTC offsets. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year, month - 1, day));
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

/** Whole-day difference b - a for two YYYY-MM-DD local dates. */
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** 0 = Sunday … 6 = Saturday for a YYYY-MM-DD local date. */
export function weekdayIndex(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay();
}

/**
 * Converts a local wall-clock date + minutes in `timeZone` into a real UTC
 * instant, resolving the zone's offset at that instant (so DST shifts and any
 * future Gulf offset change stay correct). Never hardcodes "+04:00".
 */
export function localToUtcIso(date: string, minutes: number, timeZone = DEFAULT_TIMEZONE): string {
  const target = Date.parse(`${date}T${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00Z`);
  let guess = target - offsetMs(new Date(target), timeZone);
  // One refinement pass settles the offset when the first guess lands on the
  // other side of a transition.
  guess = target - offsetMs(new Date(guess), timeZone);
  return new Date(guess).toISOString();
}

/** The timezone's UTC offset, in milliseconds, at a given instant. */
export function offsetMs(at: Date, timeZone = DEFAULT_TIMEZONE): number {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** Local YYYY-MM-DD for an absolute instant. */
export function isoToLocalDate(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  return localDate(new Date(iso), timeZone);
}

/** "Today" / "Tomorrow" / weekday label for a local date, relative to now. */
export function relativeDayLabel(date: string, now: Date, timeZone = DEFAULT_TIMEZONE): string {
  const today = localDate(now, timeZone);
  const delta = daysBetween(today, date);
  if (delta === 0) return "Today";
  if (delta === 1) return "Tomorrow";
  if (delta === -1) return "Yesterday";
  return new Intl.DateTimeFormat("en-AE", { timeZone: "UTC", weekday: "long" }).format(new Date(`${date}T12:00:00Z`));
}

/** Local time label, e.g. "6:30 PM". */
export function formatLocalTime(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-AE", { timeZone, hour: "numeric", minute: "2-digit" }).format(new Date(iso));
}

/** Full local label, e.g. "Sun, 14 Sep, 6:30 PM". */
export function formatLocalDateTime(iso: string, timeZone = DEFAULT_TIMEZONE): string {
  return new Intl.DateTimeFormat("en-AE", {
    timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit",
  }).format(new Date(iso));
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}
