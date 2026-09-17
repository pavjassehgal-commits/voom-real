/**
 * Email Automation v2 — the deterministic flow skeleton.
 *
 * This is the structural authority for a lifecycle flow, in the same role
 * `planCampaign()` plays for campaigns: it decides how many steps a flow has,
 * what each step is for, how long the waits are, and what the safe fallback
 * copy says. MARA fills strategy and copy INSIDE this skeleton; it can never
 * add, drop, reorder or re-time a step beyond the policy bounds.
 *
 * The fallback copy here is deliberately plain: no prices, no offers, no
 * claims, no links, so a flow is always creatable — and always sendable — even
 * when the text provider is unavailable. `{firstName}` is a literal token the
 * send layer replaces from the contact record.
 *
 * Pure: no I/O, no server-only import, so the Node suite executes it for real.
 */

import {
  clampStepCount,
  clampWaitMinutes,
  flowTypePolicy,
  reentryPolicyLabel,
  waitLabel,
} from "./policy";
import type { EmailFlowStepDefinition, EmailFlowType } from "./types";

export interface FlowBrandContext {
  brandName: string;
  brandDescription: string;
  industry: string;
  targetCustomer: string[];
  mainGoal: string;
  brandPersonality: string[];
}

export interface FlowSkeletonInput {
  flowType: EmailFlowType;
  brand: FlowBrandContext;
  /** Optional audience scope name, for the eligibility sentence only. */
  audienceName?: string | null;
  /** Optional explicit step count; always clamped to the type's bounds. */
  stepCount?: number | null;
  /** Re-engagement only; clamped by the policy layer. */
  inactivityDays?: number | null;
  /** Re-engagement only; clamped by the policy layer. */
  cooldownDays?: number | null;
  /** Optional owner-provided flow name. */
  name?: string | null;
}

export interface FlowSkeleton {
  flowType: EmailFlowType;
  triggerType: "newly_eligible_contact" | "inactive_contact";
  name: string;
  objective: string;
  triggerLabel: string;
  triggerDescription: string;
  eligibilityNote: string;
  reentryPolicy: "once_per_contact" | "cooldown";
  cooldownDays: number | null;
  inactivityDays: number | null;
  triggerConfig: Record<string, unknown>;
  /** One short human sentence for the flow header. */
  strategySummary: string;
  steps: EmailFlowStepDefinition[];
}

interface StepTemplate {
  title: string;
  purpose: string;
  subject: (brand: FlowBrandContext) => string;
  previewText: (brand: FlowBrandContext) => string;
  body: (brand: FlowBrandContext) => string;
  cta: string;
}

const FOOTER =
  "You are receiving this because you subscribed to email from {brandName}. Every email we send has an unsubscribe link, and we honour it immediately.";

function footer(brand: FlowBrandContext) {
  return FOOTER.replace(/\{brandName\}/g, brand.brandName);
}

function audienceSentence(brand: FlowBrandContext) {
  const who = brand.targetCustomer.filter(Boolean).slice(0, 2).join(" and ");
  return who ? `We built it for ${who.toLowerCase()}.` : "";
}

const WELCOME_STEPS: StepTemplate[] = [
  {
    title: "Welcome",
    purpose: "Say hello, set expectations, and confirm the subscription.",
    subject: (b) => `Welcome to ${b.brandName}`,
    previewText: () => "Here is what to expect from us, and how often.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `Thanks for subscribing to ${b.brandName}. You are on the list, and this address is the only one we will write to you from.\n\n` +
      `${b.brandDescription ? `${b.brandDescription}\n\n` : ""}` +
      `${audienceSentence(b)}${audienceSentence(b) ? "\n\n" : ""}` +
      `We send occasionally, never daily, and only when there is something worth your time.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Reply and say hello",
  },
  {
    title: "What we do",
    purpose: "Explain the value in plain language so the first email is not the last impression.",
    subject: (b) => `What ${b.brandName} actually does`,
    previewText: (b) => `A short, plain explanation of how ${b.brandName} helps.`,
    body: (b) =>
      `Hi {firstName},\n\n` +
      `A few days ago you subscribed to ${b.brandName}. Here is the short version of what that gets you.\n\n` +
      `${b.brandDescription || `We help our customers with ${b.industry || "their business"}.`}\n\n` +
      `${b.mainGoal ? `Right now we are focused on ${b.mainGoal.toLowerCase()}.\n\n` : ""}` +
      `If any of that is useful, just reply to this email — a real person reads every answer.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Reply with a question",
  },
  {
    title: "Next step",
    purpose: "Give the reader one concrete, low-effort next step.",
    subject: (b) => `One thing worth doing with ${b.brandName}`,
    previewText: () => "A single next step, and nothing else.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `This is the last email in your welcome sequence, so here is the one thing we suggest next: tell us what you are trying to get done.\n\n` +
      `${b.mainGoal ? `Most people come to ${b.brandName} because they want to ${b.mainGoal.toLowerCase()}.\n\n` : ""}` +
      `Reply with a sentence about your situation and we will point you at the right place.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Tell us what you need",
  },
  {
    title: "How we work",
    purpose: "Set expectations about frequency and how to reach a human.",
    subject: (b) => `How often you will hear from ${b.brandName}`,
    previewText: () => "Our sending habits, in one short email.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `A quick note on how we use your inbox, because it matters.\n\n` +
      `We write when there is something worth saying. We do not send reminders about reminders, and we never sell your details.\n\n` +
      `If the frequency ever feels wrong, the unsubscribe link at the bottom of any email stops everything immediately.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Read our latest update",
  },
  {
    title: "Still here",
    purpose: "A gentle closing note that keeps the door open.",
    subject: (b) => `We are still here when you need ${b.brandName}`,
    previewText: () => "No pitch — just where to find us.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `Nothing to sell in this one. We just wanted you to know that when you are ready, we are here.\n\n` +
      `${b.brandDescription ? `${b.brandDescription}\n\n` : ""}` +
      `Reply to this email any time and it reaches a person.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Reply any time",
  },
];

const RE_ENGAGEMENT_STEPS: StepTemplate[] = [
  {
    title: "Reconnect",
    purpose: "Reintroduce the business to someone who has not heard from it in a while.",
    subject: (b) => `It has been a while — ${b.brandName}`,
    previewText: () => "A quick hello, and what has changed since you last heard from us.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `It has been a while since we last wrote to you, so this is a short hello from ${b.brandName}.\n\n` +
      `${b.brandDescription ? `${b.brandDescription}\n\n` : ""}` +
      `${b.mainGoal ? `Lately we have been working on ${b.mainGoal.toLowerCase()}.\n\n` : ""}` +
      `If you would rather not hear from us, the unsubscribe link below stops everything in one click — no hard feelings.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "See what is new",
  },
  {
    title: "Follow up",
    purpose: "One concrete reason to come back, then the sequence ends.",
    subject: (b) => `Still interested in ${b.brandName}?`,
    previewText: () => "One question, and an easy way to opt out.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `We sent you a note a few days ago and we did not hear back, which is completely fine.\n\n` +
      `This is the last email in this sequence. If ${b.brandName} is still useful to you, reply and tell us what you need. If it is not, unsubscribe below and we will stop.\n\n` +
      `Either way, thank you for being on the list.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Reply and let us know",
  },
  {
    title: "Last note",
    purpose: "Close the sequence cleanly and leave the choice with the reader.",
    subject: (b) => `Closing the loop from ${b.brandName}`,
    previewText: () => "The last email in this sequence.",
    body: (b) =>
      `Hi {firstName},\n\n` +
      `This is the last email in this sequence, so we will keep it short.\n\n` +
      `You stay on the list unless you unsubscribe, but we will not keep chasing you. When something genuinely worth your time happens, you will hear about it.\n\n` +
      `${b.brandName}\n\n` +
      `${footer(b)}`,
    cta: "Unsubscribe or reply",
  },
];

const TEMPLATES: Record<EmailFlowType, StepTemplate[]> = {
  welcome: WELCOME_STEPS,
  re_engagement: RE_ENGAGEMENT_STEPS,
};

const DEFAULT_NAMES: Record<EmailFlowType, string> = {
  welcome: "Welcome flow",
  re_engagement: "Re-engagement flow",
};

/**
 * Builds the deterministic skeleton: structure + safe fallback copy.
 *
 * The step count and every wait come from the policy layer, never from a
 * caller, so an out-of-range request is impossible to store.
 */
export function buildFlowSkeleton(input: FlowSkeletonInput): FlowSkeleton {
  const policy = flowTypePolicy(input.flowType);
  const templates = TEMPLATES[input.flowType];
  const stepCount = clampStepCount(
    input.flowType,
    Number.isFinite(input.stepCount as number) ? Number(input.stepCount) : policy.defaultSteps,
  );

  const inactivityDays = input.flowType === "re_engagement"
    ? Math.min(
        policy.maxInactivityDays ?? 365,
        Math.max(
          policy.minInactivityDays ?? 14,
          Math.round(Number.isFinite(input.inactivityDays as number)
            ? Number(input.inactivityDays)
            : (policy.defaultInactivityDays ?? 45)),
        ),
      )
    : null;

  const cooldownDays = policy.reentryPolicy === "cooldown"
    ? Math.min(365, Math.max(1, Math.round(
        Number.isFinite(input.cooldownDays as number)
          ? Number(input.cooldownDays)
          : (policy.defaultCooldownDays ?? 90),
      )))
    : null;

  const steps: EmailFlowStepDefinition[] = [];
  for (let position = 0; position < stepCount; position += 1) {
    const template = templates[position] ?? templates[templates.length - 1];
    const defaultWait = policy.defaultWaitMinutes[position] ?? policy.defaultWaitMinutes[policy.defaultWaitMinutes.length - 1] ?? 0;
    steps.push({
      position,
      title: template.title,
      purpose: template.purpose,
      waitMinutes: clampWaitMinutes(input.flowType, defaultWait, position),
      subject: template.subject(input.brand),
      previewText: template.previewText(input.brand),
      body: template.body(input.brand),
      cta: template.cta,
      ctaUrl: null,
      contentSource: "deterministic",
    });
  }

  const brandName = input.brand.brandName || "your business";
  const audiencePart = input.audienceName ? ` in “${input.audienceName}”` : "";

  return {
    flowType: input.flowType,
    triggerType: policy.triggerType,
    name: (input.name ?? "").trim() || DEFAULT_NAMES[input.flowType],
    objective: policy.objective,
    triggerLabel: policy.triggerLabel,
    triggerDescription: policy.triggerDescription,
    eligibilityNote: policy.eligibilityNote,
    reentryPolicy: policy.reentryPolicy,
    cooldownDays,
    inactivityDays,
    triggerConfig: input.flowType === "re_engagement"
      ? { inactivityDays: inactivityDays as number, cooldownDays: cooldownDays as number }
      : {},
    strategySummary: input.flowType === "welcome"
      ? `A ${steps.length}-email welcome sequence for subscribed contacts${audiencePart}, written in ${brandName}'s own voice.`
      : `A ${steps.length}-email re-engagement sequence for subscribed contacts${audiencePart} Voom has not emailed for ${inactivityDays} days.`,
    steps,
  };
}

/** Browser-safe step view of a skeleton or stored step row. */
export function skeletonStepView(step: EmailFlowStepDefinition) {
  return {
    position: step.position,
    title: step.title,
    purpose: step.purpose,
    waitLabel: waitLabel(step.waitMinutes, step.position),
    waitMinutes: step.waitMinutes,
    subject: step.subject,
    previewText: step.previewText,
    body: step.body,
    cta: step.cta,
    ctaUrl: step.ctaUrl,
    contentSource: step.contentSource,
  };
}

/** One sentence describing how a contact may re-enter, for the UI. */
export function skeletonReentryLabel(input: { reentryPolicy: "once_per_contact" | "cooldown"; cooldownDays: number | null }) {
  return reentryPolicyLabel(input.reentryPolicy);
}
