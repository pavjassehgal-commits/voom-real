/**
 * Email Automation v2 — the MARA strategy + copy layer.
 *
 * The pipeline is one-directional, exactly like campaign intelligence:
 *
 *   deterministic skeleton → MARA intelligence → validated structured flow
 *
 * `buildFlowSkeleton()` stays the ONLY authority on structure: the step count,
 * the step order, the waits and the trigger. MARA fills objective, subjects,
 * preview text, bodies, CTAs and a suggested delay INSIDE that skeleton, and
 * every field is schema-validated here before it can reach the database:
 *
 *   - a step MARA did not return keeps its deterministic copy;
 *   - a step MARA invented (extra position) is dropped;
 *   - a proposed delay is clamped, never trusted;
 *   - copy that duplicates another step's copy is refused;
 *   - a CTA repeated across the sequence is refused;
 *   - a URL that was not in the supplied context is dropped — Voom never
 *     invents a link;
 *   - content that trips the existing Autopilot safety vocabulary is refused;
 *   - the deterministic unsubscribe footer is always present, whoever wrote
 *     the body.
 *
 * Pure module: no database, no provider client, no "server-only". The Node
 * suite executes it for real.
 */

import { z } from "zod";

import { evaluateContentSafetyBlockers } from "@/lib/mara/autopilot-safety";
import { MAX_FLOW_STEPS, clampWaitMinutes, flowTypePolicy } from "./policy";
import type { EmailFlowStepDefinition, EmailFlowType } from "./types";
import type { FlowBrandContext, FlowSkeleton } from "./skeleton";

// ─── MARA's structured response contract ───────────────────────────────────

export const flowStrategySchema = z.object({
  objective: z.string().min(1).max(300),
  approach: z.string().min(1).max(600),
  audienceAngle: z.string().min(1).max(400),
  tone: z.string().min(1).max(200),
}).strict();

export type MaraFlowStrategy = z.infer<typeof flowStrategySchema>;

export const flowStepContentSchema = z.object({
  /** The skeleton position this content belongs to. MARA may not invent steps. */
  position: z.number().int().min(0).max(MAX_FLOW_STEPS - 1),
  title: z.string().min(1).max(160),
  purpose: z.string().min(1).max(500),
  subject: z.string().min(1).max(150),
  previewText: z.string().min(1).max(300),
  body: z.string().min(1).max(6000),
  cta: z.string().min(1).max(80),
  /** A real destination from the supplied context, otherwise null. */
  ctaUrl: z.string().min(1).max(500).nullable(),
  /** Suggested wait before this step, in minutes. Clamped by the policy layer. */
  waitMinutes: z.number().int().min(0).max(20160).nullable(),
}).strict();

export type MaraFlowStepContent = z.infer<typeof flowStepContentSchema>;

export const flowIntelligenceSchema = z.object({
  strategy: flowStrategySchema,
  steps: z.array(flowStepContentSchema).min(1).max(MAX_FLOW_STEPS),
  /** One short sentence on the sequencing reasoning, or null. */
  note: z.string().max(400).nullable(),
}).strict();

export type MaraFlowIntelligence = z.infer<typeof flowIntelligenceSchema>;

/**
 * Provider-side structured output contract (strict `json_schema`), mirroring
 * the zod schemas EXACTLY: `additionalProperties: false`, every property
 * listed in `required`, optional values expressed as `["type","null"]`.
 */
export const flowIntelligenceJsonSchema = {
  name: "mara_email_flow_intelligence",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["strategy", "steps", "note"],
    properties: {
      strategy: {
        type: "object",
        additionalProperties: false,
        required: ["objective", "approach", "audienceAngle", "tone"],
        properties: {
          objective: { type: "string", maxLength: 300, description: "What this sequence is for, in one sentence." },
          approach: { type: "string", maxLength: 600, description: "How the sequence moves a reader from first email to last." },
          audienceAngle: { type: "string", maxLength: 400, description: "Who this is written for and what they care about." },
          tone: { type: "string", maxLength: 200, description: "The voice to write in, drawn from the brand context." },
        },
      },
      steps: {
        type: "array",
        minItems: 1,
        maxItems: MAX_FLOW_STEPS,
        items: {
          type: "object",
          additionalProperties: false,
          required: ["position", "title", "purpose", "subject", "previewText", "body", "cta", "ctaUrl", "waitMinutes"],
          properties: {
            position: { type: "integer", minimum: 0, maximum: MAX_FLOW_STEPS - 1, description: "The skeleton position this content fills." },
            title: { type: "string", maxLength: 160 },
            purpose: { type: "string", maxLength: 500 },
            subject: { type: "string", maxLength: 150 },
            previewText: { type: "string", maxLength: 300 },
            body: { type: "string", maxLength: 6000 },
            cta: { type: "string", maxLength: 80 },
            ctaUrl: { type: ["string", "null"], maxLength: 500, description: "A real destination URL from the supplied context, otherwise null." },
            waitMinutes: { type: ["integer", "null"], minimum: 0, maximum: 20160, description: "Suggested wait before this step, in minutes." },
          },
        },
      },
      note: { type: ["string", "null"], maxLength: 400 },
    },
  },
} as const;

export const FLOW_INTELLIGENCE_SYSTEM_PROMPT = [
  "You are MARA, the marketing manager inside Voom, writing a lifecycle email sequence for a small business.",
  "You are filling a fixed skeleton. The number of emails, their order and the trigger are already decided — do not add, remove, reorder or re-channel anything.",
  "For each position in the skeleton, return the title, purpose, subject, preview text, body and call to action.",
  "",
  "Hard rules:",
  "- Write plain, specific prose in the brand's own voice. No marketing clichés, no exclamation marks, no emoji.",
  "- Never invent prices, discounts, offers, statistics, guarantees or superlatives. If the context does not contain it, do not write it.",
  "- Never invent a URL. ctaUrl must be a destination that appears verbatim in the supplied context, otherwise null.",
  "- Never include an email address, phone number, ID number or any personal data in the copy.",
  "- Start the body with the greeting line exactly as supplied, using the {firstName} token. Never invent a person's name.",
  "- Each email must have a different subject and a different call to action. Repeating yourself across the sequence is a failure.",
  "- waitMinutes is a suggestion only; it is clamped to the business's own limits afterwards.",
  "- Return valid JSON matching the schema. No commentary outside the JSON.",
].join("\n");

// ─── Context ───────────────────────────────────────────────────────────────

export interface FlowIntelligenceContextInput {
  skeleton: FlowSkeleton;
  brand: FlowBrandContext;
  /** Real destinations the business supplied; MARA may only reuse these. */
  allowedUrls?: string[];
  /** The greeting line the deterministic skeleton uses, so tone stays consistent. */
  greeting?: string;
}

export function buildFlowIntelligenceContext(input: FlowIntelligenceContextInput) {
  const { skeleton, brand } = input;
  const policy = flowTypePolicy(skeleton.flowType);
  return {
    task: "email_flow_sequence",
    flowType: skeleton.flowType,
    trigger: { type: skeleton.triggerType, label: skeleton.triggerLabel, description: skeleton.triggerDescription },
    objective: skeleton.objective,
    brand: {
      name: brand.brandName,
      description: brand.brandDescription,
      industry: brand.industry,
      targetCustomer: brand.targetCustomer,
      mainGoal: brand.mainGoal,
      personality: brand.brandPersonality,
    },
    eligibility: skeleton.eligibilityNote,
    greeting: input.greeting ?? "Hi {firstName},",
    limits: {
      stepCount: skeleton.steps.length,
      positions: skeleton.steps.map((step) => step.position),
      minWaitMinutes: policy.minWaitMinutes,
      maxWaitMinutes: policy.maxWaitMinutes,
      defaultWaits: skeleton.steps.map((step) => ({ position: step.position, waitMinutes: step.waitMinutes })),
    },
    skeleton: skeleton.steps.map((step) => ({
      position: step.position,
      title: step.title,
      purpose: step.purpose,
      waitMinutes: step.waitMinutes,
      cta: step.cta,
    })),
    allowedUrls: (input.allowedUrls ?? []).slice(0, 10),
    safetyRules: [
      "No prices, discounts or offers.",
      "No claims of being best, first, guaranteed or risk-free.",
      "No URLs that are not in allowedUrls.",
      "No personal data, email addresses or phone numbers.",
    ],
  };
}

// ─── Validated merge ───────────────────────────────────────────────────────

export interface ApplyFlowIntelligenceInput {
  skeleton: FlowSkeleton;
  brand: FlowBrandContext;
  intelligence: MaraFlowIntelligence | null;
  allowedUrls?: string[];
}

export interface AppliedFlowStep extends EmailFlowStepDefinition {
  /** Why a deterministic step was kept instead of MARA's. */
  refusal?: string;
}

export interface AppliedFlow {
  source: "mara" | "deterministic";
  steps: AppliedFlowStep[];
  strategy: MaraFlowStrategy | null;
  strategySummary: string;
  /** Positions whose MARA content was refused and kept the deterministic copy. */
  fallbackPositions: number[];
  note: string | null;
}

const SUBJECT_LIMIT = 300;
const BODY_LIMIT = 12000;
const PREVIEW_LIMIT = 500;
const CTA_LIMIT = 160;

/**
 * The deterministic unsubscribe line. Voom appends it to every lifecycle email
 * body, whoever wrote the body, so the opt-out promise is never dependent on
 * a provider response.
 */
export function unsubscribeFooter(brandName: string) {
  return `You are receiving this because you subscribed to email from ${brandName || "this business"}. Every email we send has an unsubscribe link, and we honour it immediately.`;
}

/** Appends the footer unless the body already carries an unsubscribe line. */
export function ensureUnsubscribeFooter(body: string, brandName: string): string {
  if (/unsubscribe/i.test(body)) return body;
  return `${body.trimEnd()}\n\n${unsubscribeFooter(brandName)}`;
}

/**
 * Merges MARA's content into the deterministic skeleton.
 *
 * The skeleton always wins on structure. Each step is validated on its own, so
 * one bad email cannot sink the whole flow: it keeps the deterministic copy and
 * the rest of the sequence still carries MARA's writing.
 */
export function applyFlowIntelligence(input: ApplyFlowIntelligenceInput): AppliedFlow {
  const { skeleton, intelligence } = input;
  const brandName = input.brand.brandName || "this business";
  const allowed = new Set((input.allowedUrls ?? []).map((url) => url.trim().toLowerCase()).filter(Boolean));

  if (!intelligence) {
    return {
      source: "deterministic",
      steps: skeleton.steps.map((step) => ({ ...step })),
      strategy: null,
      strategySummary: skeleton.strategySummary,
      fallbackPositions: [],
      note: null,
    };
  }

  const byPosition = new Map<number, MaraFlowStepContent>();
  for (const step of intelligence.steps) {
    if (!byPosition.has(step.position)) byPosition.set(step.position, step);
  }

  const usedSubjects = new Set<string>();
  const usedBodies = new Set<string>();
  const usedCtas = new Set<string>();
  const steps: AppliedFlowStep[] = [];
  const fallbackPositions: number[] = [];

  for (const base of skeleton.steps) {
    const proposal = byPosition.get(base.position);
    const deterministic: EmailFlowStepDefinition = {
      ...base,
      body: ensureUnsubscribeFooter(base.body, brandName),
    };

    if (!proposal) {
      steps.push(deterministic);
      continue;
    }

    const refusal = validateProposal({ proposal, allowed, usedSubjects, usedBodies, usedCtas });
    if (refusal) {
      fallbackPositions.push(base.position);
      steps.push({ ...deterministic, refusal });
      continue;
    }

    const subject = proposal.subject.trim().slice(0, SUBJECT_LIMIT);
    const body = ensureUnsubscribeFooter(proposal.body.trim().slice(0, BODY_LIMIT), brandName);
    const cta = proposal.cta.trim().slice(0, CTA_LIMIT);
    const ctaUrl = proposal.ctaUrl && allowed.has(proposal.ctaUrl.trim().toLowerCase())
      ? proposal.ctaUrl.trim()
      : null;

    usedSubjects.add(subject.toLowerCase());
    usedBodies.add(fingerprint(body));
    usedCtas.add(cta.toLowerCase());

    steps.push({
      position: base.position,
      title: proposal.title.trim().slice(0, 160) || base.title,
      purpose: proposal.purpose.trim().slice(0, 500) || base.purpose,
      waitMinutes: clampWaitMinutes(skeleton.flowType, proposal.waitMinutes, base.position),
      subject,
      previewText: proposal.previewText.trim().slice(0, PREVIEW_LIMIT),
      body,
      cta,
      ctaUrl,
      contentSource: "mara",
    });
  }

  const maraSteps = steps.filter((step) => step.contentSource === "mara").length;

  return {
    source: maraSteps > 0 ? "mara" : "deterministic",
    steps,
    strategy: maraSteps > 0 ? intelligence.strategy : null,
    strategySummary: maraSteps > 0
      ? summarize(intelligence, skeleton, fallbackPositions.length)
      : skeleton.strategySummary,
    fallbackPositions,
    note: maraSteps > 0 ? (intelligence.note ?? null) : null,
  };
}

function validateProposal(input: {
  proposal: MaraFlowStepContent;
  allowed: ReadonlySet<string>;
  usedSubjects: ReadonlySet<string>;
  usedBodies: ReadonlySet<string>;
  usedCtas: ReadonlySet<string>;
}): string | null {
  const { proposal } = input;
  const subject = proposal.subject.trim();
  const body = proposal.body.trim();
  const cta = proposal.cta.trim();
  const preview = proposal.previewText.trim();

  if (!subject || !body || !cta || !preview) return "empty_content";
  if (subject.length > SUBJECT_LIMIT) return "subject_too_long";
  if (body.length > BODY_LIMIT) return "body_too_long";

  if (input.usedSubjects.has(subject.toLowerCase())) return "duplicate_subject";
  if (input.usedBodies.has(fingerprint(body))) return "duplicate_body";
  if (input.usedCtas.has(cta.toLowerCase())) return "duplicate_cta";

  if (proposal.ctaUrl && !input.allowed.has(proposal.ctaUrl.trim().toLowerCase())) {
    // Not a refusal on its own: the link is dropped and the copy is kept.
  }

  const blockers = evaluateContentSafetyBlockers([subject, preview, body, cta].join("\n"));
  if (blockers.length > 0) return `unsafe_content:${blockers[0]}`;

  // A stub is not an email: MARA has to actually write the body, otherwise the
  // deterministic copy — which is always complete — is used instead.
  if (body.replace(/\s+/g, " ").trim().length < 40) return "body_too_short";

  return null;
}

function fingerprint(value: string) {
  return value.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 400);
}

function summarize(
  intelligence: MaraFlowIntelligence,
  skeleton: FlowSkeleton,
  fallbackCount: number,
): string {
  const base = `${intelligence.strategy.objective.trim()} ${intelligence.strategy.approach.trim()}`.trim();
  const clipped = base.length > 320 ? `${base.slice(0, 317).trimEnd()}…` : base;
  const label = skeleton.flowType === "welcome" ? "Welcome" : "Re-engagement";
  const tail = fallbackCount > 0
    ? ` ${fallbackCount} email${fallbackCount === 1 ? "" : "s"} kept Voom's own copy.`
    : "";
  return `${label}: ${clipped}${tail}`.slice(0, 400);
}

/** The stored strategy payload for voom_email_flows.strategy. */
export function toFlowStrategyPayload(applied: AppliedFlow, flowType: EmailFlowType) {
  return {
    flowType,
    source: applied.source,
    strategy: applied.strategy,
    note: applied.note,
    fallbackPositions: applied.fallbackPositions,
    steps: applied.steps.map((step) => ({
      position: step.position,
      title: step.title,
      purpose: step.purpose,
      waitMinutes: step.waitMinutes,
      cta: step.cta,
      contentSource: step.contentSource,
    })),
  };
}
