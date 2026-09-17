/**
 * Email Automation v2 — authoritative time calculations.
 *
 * Every lifecycle instant is resolved in the BUSINESS timezone through
 * `lib/voom/timezone`, the same source of truth the Content Calendar, the
 * rolling plan and Instagram publishing use. Nothing here reads the browser's
 * timezone and nothing hardcodes an offset such as UTC+4.
 *
 * Two rules the engine cannot bypass:
 *   1. a send is only ever scheduled inside the deterministic business-local
 *      send window (a 2-day wait that lands at 03:12 moves to 09:00);
 *   2. a scheduled instant is always strictly in the future.
 *
 * Pure: no I/O, no server-only import, so the Node suite executes it for real.
 */

import {
  addDays,
  localDate,
  localMinutes,
  localToUtcIso,
} from "@/lib/voom/timezone";
import {
  MIN_SCHEDULE_LEAD_MINUTES,
  SEND_WINDOW_END_MINUTES,
  SEND_WINDOW_START_MINUTES,
} from "./policy";

export interface SendWindowInput {
  /** The earliest instant the caller would accept (usually "previous step + wait"). */
  after: string | Date;
  /** Business timezone, already resolved through `accountTimezone`. */
  timeZone: string;
  now?: Date;
  /** Minimum distance into the future. Defaults to the engine lead. */
  leadMinutes?: number;
}

function toIso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Moves an instant into the business-local send window:
 *   - before the window → the same local day at the window start;
 *   - at/after the window close → the next local day at the window start;
 *   - inside the window → unchanged.
 */
export function clampToSendWindow(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) throw new Error("invalid_instant");
  const minutes = localMinutes(at, timeZone);
  const date = localDate(at, timeZone);
  if (minutes < SEND_WINDOW_START_MINUTES) {
    return localToUtcIso(date, SEND_WINDOW_START_MINUTES, timeZone);
  }
  if (minutes >= SEND_WINDOW_END_MINUTES) {
    return localToUtcIso(addDays(date, 1), SEND_WINDOW_START_MINUTES, timeZone);
  }
  return at.toISOString();
}

/**
 * The earliest instant at or after `after` that is both inside the send window
 * and safely in the future. This is the ONLY way the engine produces a send
 * time, so "no send may be scheduled in the past" holds structurally.
 */
export function nextSafeSendInstant(input: SendWindowInput): string {
  const now = input.now ?? new Date();
  const timeZone = input.timeZone;
  const lead = input.leadMinutes ?? MIN_SCHEDULE_LEAD_MINUTES;
  const floor = now.getTime() + lead * 60_000;

  const requested = Date.parse(toIso(input.after));
  if (!Number.isFinite(requested)) throw new Error("invalid_instant");

  let candidate = Math.max(requested, floor);
  // Bounded loop: each pass either lands inside a window or moves a full day
  // forward, so this terminates on the first or second pass for any real
  // timezone and any real wait.
  for (let pass = 0; pass < 8; pass += 1) {
    const clamped = Date.parse(clampToSendWindow(new Date(candidate).toISOString(), timeZone));
    if (clamped >= floor) return new Date(clamped).toISOString();
    candidate = Date.parse(
      localToUtcIso(addDays(localDate(new Date(clamped), timeZone), 1), SEND_WINDOW_START_MINUTES, timeZone),
    );
  }
  // Unreachable for a sane window; keep the guarantee anyway.
  return new Date(
    Date.parse(localToUtcIso(addDays(localDate(now, timeZone), 1), SEND_WINDOW_START_MINUTES, timeZone)),
  ).toISOString();
}

export interface StepInstantInput {
  /** The instant the previous step executed (or the enrollment instant). */
  from: string | Date;
  /** Deterministic wait, already clamped by the policy layer. */
  waitMinutes: number;
  timeZone: string;
  now?: Date;
  leadMinutes?: number;
}

/**
 * The send instant for the next step: `from + wait`, moved into the send
 * window and guaranteed to be in the future.
 */
export function computeStepInstant(input: StepInstantInput): string {
  const from = Date.parse(toIso(input.from));
  if (!Number.isFinite(from)) throw new Error("invalid_instant");
  const wait = Number.isFinite(input.waitMinutes) ? Math.max(0, Math.round(input.waitMinutes)) : 0;
  return nextSafeSendInstant({
    after: new Date(from + wait * 60_000).toISOString(),
    timeZone: input.timeZone,
    now: input.now,
    leadMinutes: input.leadMinutes,
  });
}

/**
 * Spreads a backlog of overdue runs across the next send windows instead of
 * releasing them all at once. Used on resume and after a long outage: nothing
 * is burst-sent, and every returned instant is still in the future.
 *
 * `perWindow` bounds how many sends land in one window (the same ceiling the
 * per-tick send cap uses), so a pile of 200 overdue steps becomes an ordered
 * queue across many business mornings rather than one flood.
 */
export function spreadOverdueRuns(input: {
  count: number;
  timeZone: string;
  now?: Date;
  perWindow?: number;
  /** Minutes between consecutive releases inside one window. */
  spacingMinutes?: number;
  leadMinutes?: number;
}): string[] {
  const now = input.now ?? new Date();
  const perWindow = Math.max(1, input.perWindow ?? 5);
  const spacing = Math.max(1, input.spacingMinutes ?? 5);
  const out: string[] = [];
  let cursor = nextSafeSendInstant({ after: now, timeZone: input.timeZone, now, leadMinutes: input.leadMinutes });

  for (let index = 0; index < input.count; index += 1) {
    if (index > 0 && index % perWindow === 0) {
      // Next business morning, then the intra-window spacing starts again.
      const nextDay = addDays(localDate(new Date(cursor), input.timeZone), 1);
      cursor = nextSafeSendInstant({
        after: localToUtcIso(nextDay, SEND_WINDOW_START_MINUTES, input.timeZone),
        timeZone: input.timeZone,
        now,
        leadMinutes: input.leadMinutes,
      });
    } else if (index > 0) {
      cursor = nextSafeSendInstant({
        after: new Date(Date.parse(cursor) + spacing * 60_000).toISOString(),
        timeZone: input.timeZone,
        now,
        leadMinutes: input.leadMinutes,
      });
    }
    out.push(cursor);
  }
  return out;
}

/** "09:00–18:00" in the business timezone, for the UI. */
export function sendWindowLabel(timeZone: string): string {
  const format = (minutes: number) =>
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(localToUtcIso(localDate(new Date(), timeZone), minutes, timeZone)));
  return `${format(SEND_WINDOW_START_MINUTES)}–${format(SEND_WINDOW_END_MINUTES)}`;
}

/** The local label for a stored instant, e.g. "Tue, 22 Sep, 09:00". */
export function describeInstant(iso: string | null, timeZone: string): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    weekday: "short",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(at);
}
