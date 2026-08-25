const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

export function resolveRelativeDateTime(request: string, baseIso?: string, now: Date = new Date()): string | null {
  const weekdayMatch = request.match(/\b(?:(next)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  const timeMatch = request.match(/\bat\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  if (!weekdayMatch || !timeMatch) return null;
  const base = baseIso ? new Date(baseIso) : now;
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Dubai", year: "numeric", month: "2-digit", day: "2-digit", weekday: "long" }).formatToParts(base);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  const year = Number(part("year")); const month = Number(part("month")); const day = Number(part("day"));
  const currentWeekday = WEEKDAYS.indexOf(part("weekday").toLowerCase()); const targetWeekday = WEEKDAYS.indexOf(weekdayMatch[2].toLowerCase());
  let delta = (targetWeekday - currentWeekday + 7) % 7;
  if (weekdayMatch[1] || delta === 0) delta = delta || 7;
  let hour = Number(timeMatch[1]); const minute = Number(timeMatch[2] ?? "0");
  if (timeMatch[3].toLowerCase() === "pm" && hour !== 12) hour += 12;
  if (timeMatch[3].toLowerCase() === "am" && hour === 12) hour = 0;
  // Dubai is UTC+04:00 year-round.
  return new Date(Date.UTC(year, month - 1, day + delta, hour - 4, minute)).toISOString();
}
