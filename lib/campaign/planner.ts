/**
 * MARA Automated Campaign planner (v1).
 *
 * Given the guided brief ("tell Voom what you want"), this produces a
 * sensible, ordered mix of Instagram actions (Posts, Reels, Stories where
 * appropriate) and an email sequence. The mix is decided dynamically from the
 * goal, the timeframe, business context, available audiences and — when real
 * measured data exists — recent Instagram performance.
 *
 * Safety properties of this module:
 *   - pure and deterministic: same inputs always produce the same plan, so a
 *     repeated build with the same brief cannot invent a second sequence;
 *   - no database, no LLM, no provider client of any kind — planning never
 *     sends, publishes, enqueues paid media or spends a credit;
 *   - every action carries the existing Autopilot safety evaluation so the
 *     build layer can keep anything risky in Needs approval.
 *
 * The example in the product brief (announcement → launch email → reel →
 * reminder → proof post → final email) emerges from the rules below for a
 * ~10-day sales campaign; it is intentionally not hard-coded.
 */

import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import {
  accountTimezone,
  addDays,
  DEFAULT_TIMEZONE,
  isoToLocalDate,
  localDate,
  localMinutes,
  localToUtcIso,
} from "@/lib/voom/timezone";
import {
  CAMPAIGN_GOAL_LABELS,
  MAX_CAMPAIGN_ACTIONS,
  MAX_CAMPAIGN_DAYS,
  MAX_EMAIL_ACTIONS,
  type CampaignBrandContext,
  type CampaignBrief,
  type CampaignGoal,
  type CampaignStage,
  type PlannedAction,
  type PlannedCampaign,
  type PlannerAudience,
  type PlannerPerformanceInput,
} from "./types";

/** Minimum lead before a same-day campaign action can be proposed. */
export const CAMPAIGN_MIN_LEAD_MINUTES = 10;
/** Minimum spacing used when a same-day window needs to be compacted. */
export const CAMPAIGN_MIN_SPACING_MINUTES = 60;

type DraftSpec = Omit<PlannedAction, "slot" | "autopilotSafe" | "autopilotBlockers">;

export interface PlanCampaignInput {
  brief: CampaignBrief;
  brand?: CampaignBrandContext;
  audiences?: PlannerAudience[];
  /** Real advisory performance context, or null when none exists. */
  performance?: PlannerPerformanceInput | null;
  /** Workspace/business timezone. Unknown values fall back to the account default. */
  timeZone?: string | null;
  /** Current instant; injectable for tests. */
  now?: Date;
}

export function planCampaign(input: PlanCampaignInput): PlannedCampaign {
  const now = input.now ?? new Date();
  const timeZone = accountTimezone(input.timeZone);
  const brief = normalizeBrief(input.brief);
  const span = campaignSpanDays(brief.startAt, brief.endAt, timeZone);
  const days = Math.min(Math.max(span, 1), MAX_CAMPAIGN_DAYS);
  const last = days - 1;

  const audience = chooseEmailAudience(brief.audienceId ?? null, input.audiences ?? []);
  const perf = input.performance ?? null;

  const mix = channelMix(brief.goal, days);
  const bias = performanceBias(perf);

  const emailDays = scheduleEmailDays(mix.email, days, brief.goal);
  const postDays = schedulePostDays(mix.posts, days, brief.goal);
  const reelDays = scheduleReelDays(mix.reels, days, brief.goal, bias);
  const storyDays = scheduleStoryDays(mix.stories, days, brief.goal, bias);

  const specs: DraftSpec[] = [];

  for (const day of emailDays) {
    specs.push(buildEmailSpec({ brief, brand: input.brand ?? {}, audienceId: audience?.id ?? null, day, days, index: emailDays.indexOf(day), total: emailDays.length, timeZone }));
  }

  postDays.forEach((day, index) => {
    specs.push(buildInstagramPostSpec({ brief, brand: input.brand ?? {}, day, days, index, total: postDays.length, timeZone }));
  });
  reelDays.forEach((day, index) => {
    specs.push(buildReelSpec({ brief, brand: input.brand ?? {}, day, days, index, total: reelDays.length, timeZone }));
  });
  storyDays.forEach((day, index) => {
    specs.push(buildStorySpec({ brief, brand: input.brand ?? {}, day, days, index, total: storyDays.length, lastDay: last, timeZone }));
  });

  // One ordered timeline, earliest first; same-day order follows the channel
  // times set below (story → email → reel → post). The timing pass happens
  // before MARA sees the skeleton, so the model never receives a past slot.
  const timedSpecs = enforceCampaignTiming(specs, brief, now, timeZone);
  timedSpecs.sort((a, b) => Date.parse(a.scheduledFor) - Date.parse(b.scheduledFor));
  const capped = timedSpecs.slice(0, MAX_CAMPAIGN_ACTIONS);

  const actions: PlannedAction[] = capped.map((spec, slot) => {
    const content = [spec.subject, spec.previewText, spec.body, spec.caption, spec.concept].filter(Boolean).join("\n");
    const evaluation = evaluateAutopilotRecommendation(
      { title: spec.title, content, topic: spec.purpose, publishAt: spec.scheduledFor },
      now,
    );
    return {
      ...spec,
      slot,
      autopilotSafe: evaluation.safe,
      autopilotBlockers: evaluation.blockers,
    };
  });

  const emailCount = actions.filter((a) => a.channel === "email").length;
  const postCount = actions.filter((a) => a.channel === "instagram_post").length;
  const reelCount = actions.filter((a) => a.channel === "instagram_reel").length;
  const storyCount = actions.filter((a) => a.channel === "instagram_story").length;

  const counts = countsWithStrings({ emailCount, postCount, reelCount, storyCount });

  return {
    actions,
    summary: {
      days,
      emailCount,
      postCount,
      reelCount,
      storyCount,
      instagramCount: counts.instagramCount,
      narrative: buildNarrative(brief.goal, days, counts.instagramString, counts.emailString),
      performanceUsed: Boolean(perf),
      performanceNote: perf ? performanceNote(perf) : null,
    },
  };
}

// ─── Brief handling ────────────────────────────────────────────────────────

function normalizeBrief(brief: CampaignBrief): CampaignBrief {
  return {
    ...brief,
    name: brief.name.trim(),
    offerDetails: brief.offerDetails?.trim() || "",
    targetAudience: brief.targetAudience?.trim() || "",
    notes: brief.notes?.trim() || "",
  };
}

/** Whole inclusive day count between the brief dates in the supplied timezone. */
export function campaignSpanDays(startAt: string, endAt: string, timeZone = DEFAULT_TIMEZONE): number {
  const start = campaignDate(startAt, timeZone);
  const end = campaignDate(endAt, timeZone);
  if (!start || !end) return 1;
  const ms = Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

/** Resolves a brief value to the workspace's local calendar date. */
export function campaignDate(value: string, timeZone = DEFAULT_TIMEZONE): string | null {
  const dateMatch = /^(\d{4}-\d{2}-\d{2})$/.exec(value);
  if (dateMatch) {
    const parsed = Date.parse(`${dateMatch[1]}T00:00:00Z`);
    return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === dateMatch[1] ? dateMatch[1] : null;
  }
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : isoToLocalDate(parsed.toISOString(), timeZone);
}

function scheduledFor(startAt: string, dayOffset: number, hour: number, minute = 0, timeZone = DEFAULT_TIMEZONE): string {
  const start = campaignDate(startAt, timeZone);
  if (!start) return new Date(startAt).toISOString();
  // Resolve the local wall-clock through Intl so DST and workspace zones are correct.
  return localToUtcIso(addDays(start, dayOffset), hour * 60 + minute, timeZone);
}

/**
 * Enforces the non-negotiable time bounds after every scheduling decision.
 * This is deliberately exported so the MARA merge path can run the exact same
 * guard as the deterministic skeleton before it is persisted.
 */
export function enforceCampaignTiming<T extends { channel: string; dayOffset: number; scheduledFor: string }>(
  items: T[],
  brief: CampaignBrief,
  now: Date,
  timeZone = DEFAULT_TIMEZONE,
): T[] {
  const zone = accountTimezone(timeZone);
  const startDate = campaignDate(brief.startAt, zone);
  const endDate = campaignDate(brief.endAt, zone);
  if (!startDate || !endDate) return [];
  const today = localDate(now, zone);
  const earliestToday = ceilMinute(now.getTime() + CAMPAIGN_MIN_LEAD_MINUTES * 60_000);
  const endOfDay = (date: string) => Date.parse(localToUtcIso(date, 23 * 60 + 59, zone));
  const desiredMinutes: Record<string, number> = {
    email: 9 * 60,
    instagram_story: 10 * 60 + 30,
    instagram_reel: 17 * 60,
    instagram_post: 19 * 60,
  };
  const groups = new Map<string, Array<{ item: T; index: number; desired: number }>>();

  items.forEach((item, index) => {
    const allowedDate = addDays(startDate, item.dayOffset);
    if (allowedDate < startDate || allowedDate > endDate || allowedDate < today) return;
    const proposedMs = Date.parse(item.scheduledFor);
    const proposedDate = Number.isFinite(proposedMs) ? isoToLocalDate(new Date(proposedMs).toISOString(), zone) : "";
    const minutes = proposedDate === allowedDate && Number.isFinite(proposedMs)
      ? localMinutes(new Date(proposedMs), zone)
      : desiredMinutes[item.channel] ?? 12 * 60;
    const desired = Number.isFinite(proposedMs) && proposedDate === allowedDate
      ? proposedMs
      : Date.parse(localToUtcIso(allowedDate, minutes, zone));
    const group = groups.get(allowedDate) ?? [];
    group.push({ item, index, desired });
    groups.set(allowedDate, group);
  });

  const output: Array<{ item: T; index: number; scheduledMs: number }> = [];
  for (const [date, group] of groups) {
    const isToday = date === today;
    const floor = isToday ? earliestToday : Date.parse(localToUtcIso(date, 0, zone));
    const ceiling = endOfDay(date);
    if (isToday && floor > ceiling) continue;

    // A late same-day request gets fewer, higher-value actions rather than a
    // fake two-hour bundle. Email and feed posts carry more conversion value
    // than Stories/Reels when the remaining day cannot fit the full mix.
    const capacity = Math.max(0, Math.floor((ceiling - floor) / (CAMPAIGN_MIN_SPACING_MINUTES * 60_000)) + 1);
    const selected = isToday && group.length > capacity
      ? [...group].sort((a, b) => actionPriority(b.item.channel) - actionPriority(a.item.channel) || a.index - b.index).slice(0, capacity)
      : group;
    selected.sort((a, b) => a.desired - b.desired || a.index - b.index);

    let cursor = floor;
    for (const candidate of selected) {
      const scheduledMs = Math.max(candidate.desired, cursor);
      if (scheduledMs > ceiling) continue;
      output.push({ item: candidate.item, index: candidate.index, scheduledMs });
      cursor = scheduledMs + CAMPAIGN_MIN_SPACING_MINUTES * 60_000;
    }
  }

  const byIndex = new Map(output.map((entry) => [entry.index, entry]));
  return items.flatMap((item, index) => {
    const entry = byIndex.get(index);
    return entry ? [{ ...item, scheduledFor: new Date(entry.scheduledMs).toISOString() }] : [];
  });
}

function ceilMinute(milliseconds: number): number {
  return Math.ceil(milliseconds / 60_000) * 60_000;
}

function actionPriority(channel: string): number {
  if (channel === "email") return 4;
  if (channel === "instagram_post") return 3;
  if (channel === "instagram_reel") return 2;
  return 1;
}

// ─── Channel mix (dynamic by goal + timeframe) ─────────────────────────────

interface Mix {
  email: number;
  posts: number;
  reels: number;
  stories: number;
}

export function channelMix(goal: CampaignGoal, days: number): Mix {
  const span = Math.min(Math.max(days, 1), MAX_CAMPAIGN_DAYS);
  let email = 1;
  let posts = 1;
  let reels = 0;
  let stories = 0;

  if (goal === "awareness") {
    email = span <= 3 ? 1 : span <= 13 ? 1 : 2;
    posts = clamp(Math.round(span / 3), 1, 5);
    reels = span >= 4 ? 1 : 0;
    if (span >= 14) reels += 1;
    stories = span >= 2 ? 1 : 0;
    if (span >= 10) stories += 1;
  } else if (goal === "announce") {
    email = span <= 3 ? 1 : span <= 13 ? 2 : 3;
    posts = span <= 3 ? 1 : 2;
    if (span >= 12) posts += 1;
    reels = span >= 5 ? 1 : 0;
    stories = 1;
    if (span >= 12) stories += 1;
  } else if (goal === "re_engage") {
    email = span <= 3 ? 2 : span <= 10 ? 3 : 4;
    posts = span <= 4 ? 1 : 2;
    if (span >= 14) posts += 1;
    reels = span >= 7 ? 1 : 0;
    stories = 0;
  } else {
    // promote_product / drive_sales — the example 10-day sequence lives here.
    email = span <= 3 ? 1 : span <= 9 ? 2 : span <= 16 ? 3 : 4;
    posts = span <= 3 ? 1 : span <= 9 ? 2 : 3;
    if (span >= 16) posts += 1;
    reels = span >= 4 ? 1 : 0;
    if (span >= 14) reels += 1;
    stories = span >= 3 ? 1 : 0;
  }

  email = Math.min(email, MAX_EMAIL_ACTIONS);
  const total = email + posts + reels + stories;
  if (total > MAX_CAMPAIGN_ACTIONS) {
    // Keep every email; trim Instagram extras first, stories before reels/posts.
    let overflow = total - MAX_CAMPAIGN_ACTIONS;
    const trim = (count: number, take: number) => {
      const removed = Math.min(count, take);
      overflow -= removed;
      return count - removed;
    };
    stories = trim(stories, overflow);
    if (overflow > 0) posts = trim(posts, overflow);
    if (overflow > 0) reels = trim(reels, overflow);
  }
  return { email, posts, reels, stories };
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

// ─── Day scheduling ────────────────────────────────────────────────────────

function launchEmailDay(goal: CampaignGoal, days: number) {
  if (goal === "re_engage") return 0;
  return days >= 4 ? 1 : 0;
}

function scheduleEmailDays(count: number, days: number, goal: CampaignGoal): number[] {
  const last = days - 1;
  const first = launchEmailDay(goal, days);
  if (count <= 0) return [];
  if (count === 1) return [first];
  const out = new Set<number>([first, last]);
  const inner = count - 2;
  for (let i = 1; i <= inner; i += 1) {
    const pos = first + Math.round(((last - first) * i) / (inner + 1));
    out.add(pos);
  }
  return [...out].sort((a, b) => a - b).slice(0, count);
}

function schedulePostDays(count: number, days: number, goal: CampaignGoal): number[] {
  if (count <= 0) return [];
  const last = days - 1;
  const out = new Set<number>();
  // Non-re-engagement campaigns open with an Instagram announcement on day 1.
  if (goal !== "re_engage") out.add(0);
  for (let i = 0; i < count; i += 1) {
    const pos = Math.round((last * i) / Math.max(count - 1, 1));
    out.add(pos);
  }
  return [...out].sort((a, b) => a - b).slice(0, count);
}

function scheduleReelDays(count: number, days: number, goal: CampaignGoal, bias: PerformanceBias): number[] {
  if (count <= 0) return [];
  const last = days - 1;
  const floor = goal === "re_engage" ? 1 : 1;
  let first = clamp(Math.round(last * 0.4), floor, Math.max(floor, last - 1));
  if (bias.reelStrong) first = clamp(first - 1, floor, first);
  const out = new Set<number>([first]);
  if (count >= 2) out.add(clamp(Math.round(last * 0.72), first + 1, last));
  return [...out].sort((a, b) => a - b);
}

function scheduleStoryDays(count: number, days: number, goal: CampaignGoal, bias: PerformanceBias): number[] {
  if (count <= 0) return [];
  const last = days - 1;
  const out = new Set<number>();
  // Announcement / awareness lead with a Story; bias moves it to the opening
  // day when Stories are the account's strongest measured format.
  out.add(bias.storyStrong ? 0 : goal === "awareness" ? 0 : 0);
  if (count >= 2) out.add(last);
  return [...out].sort((a, b) => a - b);
}

interface PerformanceBias {
  reelStrong: boolean;
  postStrong: boolean;
  storyStrong: boolean;
}

function performanceBias(perf: PlannerPerformanceInput | null): PerformanceBias {
  if (!perf) return { reelStrong: false, postStrong: false, storyStrong: false };
  const label = (perf.bestContentTypeLabel ?? "").toLowerCase();
  const winners = (perf.winnerLabels ?? []).join(" ").toLowerCase();
  const text = `${label} ${winners}`;
  return {
    reelStrong: /reel|video/.test(text),
    storyStrong: /stor/.test(text),
    postStrong: /post|photo|image|feed/.test(text),
  };
}

// ─── Content builders ──────────────────────────────────────────────────────

interface BuildContext {
  brief: CampaignBrief;
  brand: CampaignBrandContext;
  day: number;
  days: number;
  index: number;
  total: number;
  timeZone: string;
}

function brandName(brand: CampaignBrandContext): string {
  return brand.brandName?.trim() || "your business";
}

function audienceLine(brief: CampaignBrief, brand: CampaignBrandContext): string {
  if (brief.targetAudience) return brief.targetAudience;
  const customers = brand.targetCustomer?.filter(Boolean);
  if (customers?.length) return customers.join(", ");
  return "your customers";
}

function offerLine(brief: CampaignBrief): string {
  return brief.offerDetails ? brief.offerDetails.trim() : "";
}

function stageFor(goal: CampaignGoal, day: number, days: number, index: number, total: number): CampaignStage {
  if (goal === "re_engage") return "retention";
  if (total > 1 && index === total - 1) return "conversion";
  const fraction = days <= 1 ? 1 : day / (days - 1);
  if (fraction < 0.3) return "awareness";
  if (fraction < 0.65) return "consideration";
  return "conversion";
}

const STAGE_PURPOSE: Record<CampaignStage, string> = {
  awareness: "Introduces the campaign and earns attention.",
  consideration: "Shows the benefit with proof and context.",
  conversion: "Gives a clear reason and moment to act.",
  retention: "Brings past customers back with a personal reason to return.",
};

function emailSubject(goal: CampaignGoal, brand: CampaignBrandContext, offer: string, stage: CampaignStage): string {
  const name = brandName(brand);
  const offerBit = offer ? ` — ${offer}` : "";
  const byStage: Record<CampaignStage, string> = {
    awareness: `${name}: something new for you`,
    consideration: `Why people choose ${name}`,
    conversion: offer ? `${offer} — your last chance from ${name}` : `Your invite from ${name}`,
    retention: `We've missed you at ${name}`,
  };
  if (goal === "announce") return `${name}: the news you asked for${offerBit}`;
  return byStage[stage];
}

function ctaFor(goal: CampaignGoal, stage: CampaignStage): { label: string; url?: string } {
  if (goal === "awareness" && stage === "awareness") return { label: "See what's new" };
  if (goal === "re_engage") return { label: "Come back and see" };
  if (stage === "conversion") return { label: "Shop the offer" };
  return { label: "Take a look" };
}

function buildEmailSpec(ctx: BuildContext & { audienceId: string | null }): DraftSpec {
  const { brief, brand, day, days, index, total } = ctx;
  const name = brandName(brand);
  const stage = stageFor(brief.goal, day, days, index, total);
  const offer = offerLine(brief);
  const audience = audienceLine(brief, brand);
  const cta = ctaFor(brief.goal, stage);
  const isFinal = total > 1 && index === total - 1;
  const subject = emailSubject(brief.goal, brand, offer, stage);
  const previewText = isFinal && offer
    ? `Last chance: ${offer}.`
    : stage === "retention"
      ? "A quick note from the team."
      : brief.goal === "announce"
        ? "Here is what is happening."
        : "A quick update from our team.";

  const opener = stage === "retention"
    ? `It has been a while, and we wanted to personally say hi.`
    : stage === "awareness"
      ? `Here at ${name}, we have been working on something made for ${audience}.`
      : stage === "consideration"
        ? `We wanted to share why customers like you come back to ${name}.`
        : isFinal
          ? `This is our final note before the campaign ends.`
          : `Everything is ready for you at ${name}.`;

  const offerParagraph = offer
    ? `\n\nThe details: ${offer}.`
    : "";
  const benefitParagraph = brand.brandDescription?.trim()
    ? `\n\n${brand.brandDescription.trim()}`
    : "";
  const closing = stage === "retention"
    ? `\n\nIf now is a good time to come back, everything is waiting for you.`
    : `\n\n${cta.label} whenever you are ready — no pressure, just a simple, clear next step.`;

  const body = [
    `Hi,`,
    `\n${opener}${benefitParagraph}${offerParagraph}${closing}`,
    `\n\nCTA: ${cta.label}`,
    `\n\nWarmly,\nThe ${name} team`,
  ].join("").slice(0, 11000);

  return {
    channel: "email",
    dayOffset: day,
    scheduledFor: scheduledFor(brief.startAt, day, isFinal ? 16 : index === 0 ? 9 : 11, 0, ctx.timeZone),
    stage,
    title: `${subject}`.slice(0, 160),
    purpose: `${STAGE_PURPOSE[stage]} Email ${index + 1} of ${total} in the ${CAMPAIGN_GOAL_LABELS[brief.goal].toLowerCase()} sequence.`,
    subject: subject.slice(0, 300),
    previewText: previewText.slice(0, 500),
    body,
    cta: cta.label,
    audienceId: ctx.audienceId,
  };
}

function hashtagSet(brand: CampaignBrandContext, goal: CampaignGoal): string[] {
  const tags = new Set<string>();
  const slug = brandName(brand).toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 20);
  if (slug) tags.add(`#${slug}`);
  const industry = (brand.industry ?? "").toLowerCase();
  if (/beauty|skin|cosmetic/.test(industry)) tags.add("#skincare");
  if (/fashion|cloth|apparel/.test(industry)) tags.add("#ootd");
  if (/food|cafe|restaurant/.test(industry)) tags.add("#foodie");
  if (/fitness|gym|wellness/.test(industry)) tags.add("#fitness");
  const byGoal: Record<CampaignGoal, string[]> = {
    promote_product: ["#newin", "#shoplocal", "#smallbusiness"],
    drive_sales: ["#specialoffer", "#shoplocal", "#smallbusiness"],
    announce: ["#comingsoon", "#smallbusiness", "#behindthescenes"],
    re_engage: ["#welcomeback", "#smallbusiness", "#customerlove"],
    awareness: ["#meetus", "#smallbusiness", "#behindthescenes"],
  };
  byGoal[goal].forEach((t) => tags.add(t));
  return [...tags].slice(0, 8);
}

function postCaption(brief: CampaignBrief, brand: CampaignBrandContext, stage: CampaignStage): { caption: string; hashtags: string[] } {
  const name = brandName(brand);
  const offer = offerLine(brief);
  const hook = stage === "awareness"
    ? `Say hello to the latest from ${name}.`
    : stage === "consideration"
      ? `Why customers keep choosing ${name}:`
      : offer
        ? `Last days for ${offer}.`
        : `Made for ${audienceLine(brief, brand)} — ready when you are.`;
  const middle = [
    brief.name && !brief.name.toLowerCase().startsWith("campaign") ? brief.name.trim() : "",
    brief.notes?.trim() ?? "",
    offer ? `Details: ${offer}.` : "",
  ].filter(Boolean).join(" ");
  const cta = brief.goal === "awareness" ? "Follow along for the full reveal." : brief.goal === "re_engage" ? "Come and see what is new." : "Tap through and take a look.";
  const hashtags = hashtagSet(brand, brief.goal);
  return {
    caption: `${hook}\n\n${middle}\n\n${cta}\n\n${hashtags.join(" ")}`.trim().slice(0, 2200),
    hashtags,
  };
}

function buildInstagramPostSpec(ctx: BuildContext): DraftSpec {
  const { brief, brand, day, days, index, total } = ctx;
  const stage = stageFor(brief.goal, day, days, index, total);
  const { caption, hashtags } = postCaption(brief, brand, stage);
  const title = stage === "awareness"
    ? `${brandName(brand)} campaign announcement`
    : stage === "consideration"
      ? `${brandName(brand)} benefit / proof post`
      : `${brandName(brand)} reminder post`;
  return {
    channel: "instagram_post",
    dayOffset: day,
    scheduledFor: scheduledFor(brief.startAt, day, 19, 0, ctx.timeZone),
    stage,
    title: title.slice(0, 160),
    purpose: `${STAGE_PURPOSE[stage]} Instagram post ${index + 1} of ${total}.`,
    concept: title,
    caption,
    hashtags,
  };
}

function buildReelSpec(ctx: BuildContext): DraftSpec {
  const { brief, brand, day, days, index, total } = ctx;
  const stage = stageFor(brief.goal, day, days, index, total);
  const name = brandName(brand);
  const offer = offerLine(brief);
  const hook = brief.goal === "awareness"
    ? `3 seconds to see what makes ${name} different`
    : offer
      ? `Watch this before ${offer} is gone`
      : `The thing customers keep asking us about`;
  const scenes = [
    `Scene 1 (hook): ${hook}.`,
    `Scene 2 (benefit): show ${brief.name} in use for ${audienceLine(brief, brand)}.${offer ? ` Include: ${offer}.` : ""}`,
    `Scene 3 (CTA): end on the ${name} mark and a clear next step.`,
  ];
  const hashtags = hashtagSet(brand, brief.goal).concat(["#reels", "#explore"]).slice(0, 9);
  const caption = `${hook}\n\n${scenes.join(" ")}\n\n${brief.goal === "awareness" ? "Follow for more." : "Find out more through the profile."}\n\n${hashtags.join(" ")}`.slice(0, 2200);
  return {
    channel: "instagram_reel",
    dayOffset: day,
    scheduledFor: scheduledFor(brief.startAt, day, 17, 0, ctx.timeZone),
    stage,
    title: `${name} Reel: ${brief.goal === "awareness" ? "behind the scenes" : offer ? "offer highlight" : "why customers choose us"}`.slice(0, 160),
    purpose: `${STAGE_PURPOSE[stage]} Reel ${index + 1} of ${total}; short-form video tends to reach new viewers.`,
    concept: scenes.join(" "),
    caption,
    hashtags,
  };
}

function buildStorySpec(ctx: BuildContext & { lastDay: number }): DraftSpec {
  const { brief, brand, day, days, index, total, lastDay } = ctx;
  const stage = stageFor(brief.goal, day, days, index, total);
  const name = brandName(brand);
  const offer = offerLine(brief);
  const isClosing = day >= lastDay && total > 1;
  const overlay = isClosing
    ? offer
      ? `Last chance: ${offer}`
      : "Ending soon — tap to see it"
    : stage === "awareness"
      ? `Something new from ${name}`
      : `See why people choose ${name}`;
  const sticker = brief.goal === "awareness" ? "poll / question sticker" : "link or profile sticker";
  const concept = [`Story frame text: "${overlay}".`, `Sticker: ${sticker}.`, "Keep it full-screen, one line of text, and end on the brand mark."].join(" ");
  return {
    channel: "instagram_story",
    dayOffset: day,
    scheduledFor: scheduledFor(brief.startAt, day, 10, 30, ctx.timeZone),
    stage,
    title: `${name} Story: ${isClosing ? "closing reminder" : "campaign moment"}`.slice(0, 160),
    purpose: `${STAGE_PURPOSE[stage]} Story ${index + 1} of ${total}; Stories keep the campaign present between feed posts.`,
    concept,
    caption: overlay,
  };
}

// ─── Audience selection ────────────────────────────────────────────────────

function chooseEmailAudience(audienceId: string | null, audiences: PlannerAudience[]): PlannerAudience | null {
  if (!audienceId) return audiences.find((a) => (a.eligibleEmailCount ?? 0) > 0) ?? null;
  return audiences.find((a) => a.id === audienceId) ?? null;
}

// ─── Summary ───────────────────────────────────────────────────────────────

function buildNarrative(goal: CampaignGoal, days: number, instagramString: string, emailString: string): string {
  const lead = `MARA created a ${days}-day ${CAMPAIGN_GOAL_LABELS[goal].toLowerCase()} campaign with ${instagramString} and ${emailString}.`;
  const strategy: Record<CampaignGoal, string> = {
    promote_product: "The sequence opens with an announcement, supports it with benefit and proof content, then follows with conversion-focused reminders.",
    drive_sales: "The sequence opens with an announcement, supports it with benefit and proof content, then follows with conversion-focused reminders.",
    announce: "The sequence leads with the announcement across Instagram and email, then reinforces it with reminders.",
    re_engage: "The sequence leads with email to win customers back, supported by fresh Instagram reasons to return.",
    awareness: "The sequence builds awareness first on Instagram, then follows with email to turn attention into interest.",
  };
  return `${lead} ${strategy[goal]}`;
}

function performanceNote(perf: PlannerPerformanceInput): string {
  const format = perf.bestContentTypeLabel?.trim();
  const base = format
    ? `Your real Instagram performance suggests ${format.toLowerCase()} are connecting most right now, so MARA moved that format slightly earlier. This is advisory, not a rule.`
    : "MARA used your recent real Instagram performance as an advisory input while spacing the sequence.";
  return base;
}

// Helpers so the summary reads naturally for 0/1/many.
function countsWithStrings(counts: { emailCount: number; postCount: number; reelCount: number; storyCount: number }) {
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const igParts = [
    counts.postCount ? plural(counts.postCount, "Instagram post") : "",
    counts.reelCount ? plural(counts.reelCount, "Reel") : "",
    counts.storyCount ? plural(counts.storyCount, "Story") : "",
  ].filter(Boolean);
  const instagramCount = counts.postCount + counts.reelCount + counts.storyCount;
  const instagramString = instagramCount === 0
    ? "no Instagram actions"
    : `${plural(instagramCount, "Instagram action")} (${igParts.join(", ")})`;
  return {
    ...counts,
    instagramCount,
    instagramString,
    emailString: plural(counts.emailCount, "email"),
  };
}
