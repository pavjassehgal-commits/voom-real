/**
 * Pure, deterministic channel/format assignment for the rolling social plan.
 *
 * A cadence date is one social deliverable, never a copy on every selected
 * platform. Existing work is retained by its immutable channel+format
 * identity; only an unexecuted draft on a channel that is no longer selected
 * may be detached from the active plan. Connection state is intentionally not
 * an input: it gates execution, not planning eligibility.
 */

import {
  SOCIAL_CHANNEL_LABELS,
  SOCIAL_FORMATS,
  SOCIAL_FORMAT_LABELS,
  SOCIAL_MEDIA_CHANNELS,
  actionChannelFor,
  isValidChannelFormat,
  parseActionChannel,
  type SocialFormat,
  type SocialMediaChannel,
} from "../../social/channels.ts";

const LOCAL_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type PlannedContentType = "post" | "reel" | "story" | "video" | "short";

export interface ExistingPlanAssignment {
  draftId?: string;
  slotKey: string;
  channel?: unknown;
  format?: unknown;
  /** Only approvals/provider-owned or already-published work is protected. */
  protected?: boolean;
  status?: string;
}

export interface ChannelCoverage {
  date: string;
  /** Canonical channel or compact channel_format identifier. Email is ignored. */
  channel: unknown;
  format?: unknown;
}

export interface AssignedPlanSlot {
  date: string;
  channel: SocialMediaChannel;
  format: SocialFormat;
  contentType: PlannedContentType;
  /** Existing legacy date keys are preserved; new slots use date|channel_format. */
  slotKey: string;
  existing: boolean;
  protected: boolean;
}

export interface PlanAssignmentResult {
  assignments: AssignedPlanSlot[];
  /** Safe to detach from the active plan; the drafts themselves remain untouched. */
  detachDraftIds: string[];
}

/**
 * Accepts saved onboarding labels, canonical channel ids, or canonical compact
 * channel_format identifiers. Email, retired channels and unknown values are
 * excluded. The output is always in product order so tie-breaking is stable.
 */
export function normalizeSelectedSocialChannels(value: unknown): SocialMediaChannel[] {
  if (!Array.isArray(value)) return [];
  const selected = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const normalized = entry.trim().toLowerCase();
    if (!normalized) continue;
    if ((SOCIAL_MEDIA_CHANNELS as readonly string[]).includes(normalized)) {
      selected.add(normalized);
      continue;
    }
    for (const channel of SOCIAL_MEDIA_CHANNELS) {
      if (SOCIAL_CHANNEL_LABELS[channel].toLowerCase() === normalized) selected.add(channel);
    }
    const parsed = parseActionChannel(normalized.replace(/[\s-]+/g, "_"));
    if (parsed && parsed.channel !== "email") selected.add(parsed.channel);
  }
  return SOCIAL_MEDIA_CHANNELS.filter((channel) => selected.has(channel));
}

/** Validates the date-only / date|channel_format source-plan identity. */
export function parseWorkflowSlotIdentity(value: unknown): {
  date: string;
  channel: SocialMediaChannel | null;
  format: SocialFormat | null;
  legacy: boolean;
} | null {
  if (typeof value !== "string") return null;
  const separator = value.indexOf("|");
  const date = separator < 0 ? value : value.slice(0, separator);
  if (!isRealLocalDate(date)) return null;
  if (separator < 0) return { date, channel: null, format: null, legacy: true };
  if (separator !== date.length || value.indexOf("|", separator + 1) >= 0) return null;
  const parsed = parseActionChannel(value.slice(separator + 1));
  if (!parsed || parsed.channel === "email" || !parsed.format) return null;
  return {
    date,
    channel: parsed.channel,
    format: parsed.format,
    legacy: false,
  };
}

export function isRealLocalDate(value: string): boolean {
  if (!LOCAL_DATE.test(value)) return false;
  const instant = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant) && new Date(instant).toISOString().slice(0, 10) === value;
}

export function workflowSlotKey(date: string, channel: SocialMediaChannel, format: SocialFormat): string {
  return `${date}|${actionChannelFor(channel, format)}`;
}

export function socialFormatLabel(channel: SocialMediaChannel, format: SocialFormat): string {
  return SOCIAL_FORMAT_LABELS[channel][format] ?? SOCIAL_CHANNEL_LABELS[channel];
}

/**
 * Retains valid assignments and picks at most one plan slot per date. Unselected
 * future drafts and unprotected duplicate drafts are detached (not relabelled
 * or deleted); approved/executing/published work always stays on its original
 * channel and format, even after preferences change.
 */
export function planChannelAssignments(input: {
  dates: string[];
  today: string;
  selectedChannels: SocialMediaChannel[];
  existing?: ExistingPlanAssignment[];
  coverage?: ChannelCoverage[];
}): PlanAssignmentResult {
  const dates = [...new Set(input.dates.filter(isRealLocalDate))].sort();
  const dateSet = new Set(dates);
  const selected = input.selectedChannels.filter((channel, index, all) => all.indexOf(channel) === index);
  const selectedSet = new Set(selected);
  const detach = new Set<string>();
  const candidatesByDate = new Map<string, Array<{
    source: ExistingPlanAssignment;
    date: string;
    channel: SocialMediaChannel;
    format: SocialFormat;
    protected: boolean;
    identity: string;
  }>>();

  for (const item of input.existing ?? []) {
    const identity = parseWorkflowSlotIdentity(item.slotKey);
    if (!identity) continue; // legacy ordinal rows stay readable and untouched
    const channelFormat = normalizedExistingPair(item, identity.channel, identity.format);
    if (!channelFormat) continue;
    const protectedWork = item.protected === true || item.status === "approved" || item.status === "published";
    const eligible = selectedSet.has(channelFormat.channel) || protectedWork;
    const future = identity.date >= input.today;

    if (!eligible && future && item.draftId) {
      detach.add(item.draftId);
      continue;
    }
    if (!dateSet.has(identity.date) || !eligible) continue;

    const candidates = candidatesByDate.get(identity.date) ?? [];
    candidates.push({
      source: item,
      date: identity.date,
      ...channelFormat,
      protected: protectedWork,
      identity: item.slotKey,
    });
    candidatesByDate.set(identity.date, candidates);
  }

  const assignedByDate = new Map<string, AssignedPlanSlot>();
  // At most one existing assignment wins each date. Protected work wins over
  // an unexecuted draft; within each class, product channel order and key order
  // provide stable tie-breaking. Other unprotected duplicates are detached.
  for (const [date, candidates] of candidatesByDate) {
    candidates.sort((a, b) => {
      if (a.protected !== b.protected) return a.protected ? -1 : 1;
      const channelOrder = selected.indexOf(a.channel) - selected.indexOf(b.channel);
      if (channelOrder !== 0) return channelOrder;
      return a.identity.localeCompare(b.identity);
    });
    const winner = candidates[0];
    assignedByDate.set(date, {
      date,
      channel: winner.channel,
      format: winner.format,
      contentType: contentTypeFor(winner.channel, winner.format),
      slotKey: winner.identity,
      existing: true,
      protected: winner.protected,
    });
    for (const duplicate of candidates.slice(1)) {
      if (!duplicate.protected && duplicate.source.draftId) detach.add(duplicate.source.draftId);
    }
  }

  const counts = new Map<SocialMediaChannel, number>(selected.map((channel) => [channel, 0]));
  const formatCounts = new Map<SocialMediaChannel, Map<SocialFormat, number>>();
  for (const channel of selected) {
    formatCounts.set(channel, new Map((SOCIAL_FORMATS[channel] as readonly SocialFormat[]).map((format) => [format, 0])));
  }
  const occupied = new Set(assignedByDate.keys());
  const countAssignment = (channel: SocialMediaChannel, format: SocialFormat) => {
    counts.set(channel, (counts.get(channel) ?? 0) + 1);
    const byFormat = formatCounts.get(channel);
    if (byFormat) byFormat.set(format, (byFormat.get(format) ?? 0) + 1);
  };

  for (const assignment of assignedByDate.values()) {
    if (selectedSet.has(assignment.channel)) countAssignment(assignment.channel, assignment.format);
  }

  // Coordinator coverage informs deterministic balance without creating
  // another slot. A date is counted once, and a plan assignment takes
  // precedence over its duplicate appearance in the coordinator snapshot.
  const externalDates = new Set<string>();
  for (const commitment of input.coverage ?? []) {
    if (!isRealLocalDate(commitment.date) || occupied.has(commitment.date) || externalDates.has(commitment.date)) continue;
    const pair = normalizedCoveragePair(commitment);
    if (!pair || !selectedSet.has(pair.channel)) continue;
    externalDates.add(commitment.date);
    countAssignment(pair.channel, pair.format);
  }

  const assignments: AssignedPlanSlot[] = [];
  for (const date of dates) {
    const existing = assignedByDate.get(date);
    if (existing) {
      assignments.push(existing);
      continue;
    }
    if (!selected.length) continue;

    const channel = selected.reduce((best, candidate) =>
      (counts.get(candidate) ?? 0) < (counts.get(best) ?? 0) ? candidate : best,
    selected[0]);
    const supportedFormats = SOCIAL_FORMATS[channel] as readonly SocialFormat[];
    const byFormat = formatCounts.get(channel)!;
    const format = supportedFormats.reduce((best, candidate) =>
      (byFormat.get(candidate) ?? 0) < (byFormat.get(best) ?? 0) ? candidate : best,
    supportedFormats[0]);
    const slot: AssignedPlanSlot = {
      date,
      channel,
      format,
      contentType: contentTypeFor(channel, format),
      slotKey: workflowSlotKey(date, channel, format),
      existing: false,
      protected: false,
    };
    assignments.push(slot);
    countAssignment(channel, format);
  }

  return { assignments, detachDraftIds: [...detach].sort() };
}

function normalizedExistingPair(
  item: ExistingPlanAssignment,
  keyChannel: SocialMediaChannel | null,
  keyFormat: SocialFormat | null,
): { channel: SocialMediaChannel; format: SocialFormat } | null {
  // Composite slot identity is the server-owned assignment. Persisted columns
  // are checked on write/read, but a mismatch must never relabel the key.
  if (keyChannel && keyFormat) return { channel: keyChannel, format: keyFormat };
  if (isValidChannelFormat(item.channel, item.format)) {
    return { channel: item.channel as SocialMediaChannel, format: item.format as SocialFormat };
  }
  return null;
}

function normalizedCoveragePair(commitment: ChannelCoverage): { channel: SocialMediaChannel; format: SocialFormat } | null {
  if (isValidChannelFormat(commitment.channel, commitment.format)) {
    return { channel: commitment.channel as SocialMediaChannel, format: commitment.format as SocialFormat };
  }
  const parsed = parseActionChannel(commitment.channel);
  if (parsed && parsed.channel !== "email" && parsed.format) {
    return { channel: parsed.channel, format: parsed.format };
  }
  return null;
}

function contentTypeFor(channel: SocialMediaChannel, format: SocialFormat): PlannedContentType {
  if (channel === "instagram") return format as "post" | "reel" | "story";
  if (channel === "youtube" && format === "short") return "short";
  return "video";
}
