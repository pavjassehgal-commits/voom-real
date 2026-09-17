/**
 * Email Automation v2 — flow creation.
 *
 *   deterministic skeleton → MARA intelligence → strict schema validation →
 *   safety validation → stored flow
 *
 * The deterministic layer (`buildFlowSkeleton` + `policy`) owns the structure;
 * MARA only fills strategy and copy inside it. If the text provider is not
 * configured, fails, rate-limits or returns anything unusable, the flow is
 * still created from the deterministic skeleton — AI availability can never
 * make flow creation unusable.
 *
 * Creation sends nothing: no Resend call, no Meta call, no media provider, no
 * credit reservation. A new flow is always a DRAFT until its owner activates
 * it, in every automation mode.
 */

import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { accountTimezone } from "@/lib/voom/timezone";
import { normalizeAutomationMode, type AutomationModeValue } from "@/lib/voom/automation";
import { buildFlowSkeleton, type FlowBrandContext } from "./skeleton";
import {
  applyFlowIntelligence,
  buildFlowIntelligenceContext,
  toFlowStrategyPayload,
} from "./strategy";
import { generateFlowIntelligence, type FlowIntelligenceDeps } from "./intelligence";
import {
  flowTypePolicy,
  mayCoordinatorProposeFlow,
  triggerForFlowType,
  validateFlowCreation,
} from "./policy";
import type { EmailFlowRecord, EmailFlowType } from "./types";

export class EmailFlowValidationError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "EmailFlowValidationError";
    this.code = code;
  }
}

export class EmailFlowPersistenceError extends Error {
  readonly code: string | null;

  constructor(code: string | null, cause?: unknown) {
    super("email_flow_persistence_failed", { cause });
    this.name = "EmailFlowPersistenceError";
    this.code = code;
  }
}

export interface CreateEmailFlowInput {
  ownerId: string;
  flowType: EmailFlowType;
  name?: string | null;
  audienceId?: string | null;
  stepCount?: number | null;
  inactivityDays?: number | null;
  cooldownDays?: number | null;
  /** Minted by the caller; the same key can never create a second flow. */
  idempotencyKey: string;
  /** Real destinations MARA may reuse as a CTA link. Never invented. */
  allowedUrls?: string[];
  createdBy?: "user" | "coordinator";
  mode?: AutomationModeValue | string | null;
  now?: Date;
  /** Test seam for the text-AI provider only. No media provider is injectable. */
  deps?: FlowIntelligenceDeps;
}

export interface CreateEmailFlowResult {
  flow: EmailFlowRecord;
  flowType: EmailFlowType;
  stepCount: number;
  /** "mara" when MARA wrote content, "deterministic" for the safe fallback. */
  generationSource: "mara" | "deterministic";
  /** Positions whose MARA content was refused and kept the deterministic copy. */
  fallbackPositions: number[];
  /** Truthful reason when the text provider was not used, else null. */
  intelligenceReason: string | null;
  strategySummary: string;
  status: EmailFlowRecord["status"];
  /** True when the Coordinator created it and it is waiting on the owner. */
  awaitingActivation: boolean;
}

/**
 * Creates a flow through the guarded `create_email_flow` RPC.
 *
 * Throws `EmailFlowValidationError` for anything the deterministic model does
 * not support (including an unsupported trigger type) and
 * `EmailFlowPersistenceError` when the database refuses the write.
 */
export async function createEmailFlow(
  admin: SupabaseClient,
  input: CreateEmailFlowInput,
): Promise<CreateEmailFlowResult> {
  const createdBy = input.createdBy ?? "user";
  const mode = normalizeAutomationMode(input.mode ?? "assisted");

  // The Coordinator never creates anything for a Manual account.
  if (createdBy === "coordinator" && !mayCoordinatorProposeFlow(mode)) {
    throw new EmailFlowValidationError(
      "manual_mode_no_autonomous_flow",
      "In Manual mode Voom never creates a lifecycle flow on its own. Create one yourself and Voom will run it.",
    );
  }

  const validation = validateFlowCreation({
    flowType: input.flowType,
    name: input.name ?? undefined,
    audienceId: input.audienceId ?? undefined,
    steps: input.stepCount ? new Array(Math.max(0, Math.round(Number(input.stepCount)))) : undefined,
    inactivityDays: input.inactivityDays ?? undefined,
    cooldownDays: input.cooldownDays ?? undefined,
  });
  if (!validation.ok) throw new EmailFlowValidationError(validation.code, validation.message);

  const brand = await loadFlowBrandContext(admin, input.ownerId);

  let audienceName: string | null = null;
  if (input.audienceId) {
    const { data: audience } = await admin.from("audiences")
      .select("id,name")
      .eq("owner_id", input.ownerId)
      .eq("id", input.audienceId)
      .maybeSingle();
    // An audience from another workspace, or a deleted one, is refused rather
    // than silently widened to "every subscriber".
    if (!audience) {
      throw new EmailFlowValidationError("audience_not_found", "That audience was not found in your workspace.");
    }
    audienceName = String(audience.name ?? "");
  }

  // 1) Deterministic skeleton: structure + safe fallback copy.
  const skeleton = buildFlowSkeleton({
    flowType: input.flowType,
    brand: brand.context,
    audienceName,
    stepCount: input.stepCount ?? null,
    inactivityDays: input.inactivityDays ?? null,
    cooldownDays: input.cooldownDays ?? null,
    name: input.name ?? null,
  });

  // 2) MARA intelligence inside that skeleton. Never fatal.
  const context = buildFlowIntelligenceContext({
    skeleton,
    brand: brand.context,
    allowedUrls: input.allowedUrls ?? [],
  });
  const generated = await generateFlowIntelligence(context, input.deps ?? {});

  // 3) Strict schema + safety validation, then a validated merge.
  const applied = applyFlowIntelligence({
    skeleton,
    brand: brand.context,
    intelligence: generated.ok ? generated.intelligence : null,
    allowedUrls: input.allowedUrls ?? [],
  });

  // 4) Store, through the only write path.
  const { data, error } = await admin.rpc("create_email_flow", {
    p_owner_user_id: input.ownerId,
    p_payload: {
      idempotencyKey: input.idempotencyKey,
      businessId: brand.businessId,
      flowType: skeleton.flowType,
      triggerType: triggerForFlowType(skeleton.flowType),
      triggerConfig: skeleton.triggerConfig,
      name: skeleton.name,
      objective: skeleton.objective,
      audienceId: input.audienceId ?? null,
      reentryPolicy: skeleton.reentryPolicy,
      cooldownDays: skeleton.cooldownDays,
      generationSource: applied.source,
      strategy: toFlowStrategyPayload(applied, skeleton.flowType),
      strategySummary: applied.strategySummary,
      createdBy,
      steps: applied.steps.map((step) => ({
        title: step.title,
        purpose: step.purpose,
        waitMinutes: step.waitMinutes,
        subject: step.subject,
        previewText: step.previewText,
        body: step.body,
        cta: step.cta,
        ctaUrl: step.ctaUrl,
        contentSource: step.contentSource,
      })),
    },
  }).single();

  if (error || !data) {
    console.error("[voom][email-flow] create_email_flow RPC failed", {
      code: error?.code ?? null,
      message: error?.message ?? null,
      details: (error as { details?: string | null } | null)?.details ?? null,
      hint: (error as { hint?: string | null } | null)?.hint ?? null,
    });
    // A duplicate coordinator proposal is an expected, benign outcome: the
    // flow already exists, which is exactly what the dedupe guard is for.
    if (/flow_type_already_exists/.test(String(error?.message ?? ""))) {
      throw new EmailFlowValidationError("flow_type_already_exists", "A flow of this type already exists.");
    }
    throw new EmailFlowPersistenceError(error?.code ?? null, error);
  }

  const flow = data as EmailFlowRecord;

  return {
    flow,
    flowType: skeleton.flowType,
    stepCount: applied.steps.length,
    generationSource: applied.source,
    fallbackPositions: applied.fallbackPositions,
    intelligenceReason: generated.ok ? null : generated.reason,
    strategySummary: applied.strategySummary,
    status: flow.status,
    // A flow is always a draft at creation, so it always awaits the owner.
    awaitingActivation: flow.status === "draft",
  };
}

/**
 * The Coordinator's proposal path.
 *
 * Durable idempotency: the key is derived from (owner, flow type) only, and the
 * database also refuses a second live proposal of the same type. So
 * `cron → email opportunity → duplicate flow every day` is impossible, and a
 * repeated run is a no-op rather than a new draft.
 */
export function coordinatorProposalKey(ownerId: string, flowType: EmailFlowType): string {
  return createHash("sha256")
    .update(`voom-email-flow-proposal:${ownerId}:${flowType}`)
    .digest("hex")
    .slice(0, 48);
}

export type ProposeFlowOutcome =
  | { outcome: "proposed"; result: CreateEmailFlowResult }
  | { outcome: "already_exists" }
  | { outcome: "not_permitted"; reason: string }
  | { outcome: "failed"; reason: string };

/**
 * Prepares (never activates) a draft flow on the owner's behalf.
 *
 * Autopilot gets exactly the same treatment as Assisted: no existing Voom
 * policy authorises automatic activation of a lifecycle flow that sends email,
 * so activation always stays with the owner.
 */
export async function proposeEmailFlow(
  admin: SupabaseClient,
  input: {
    ownerId: string;
    flowType: EmailFlowType;
    mode: AutomationModeValue | string | null;
    inactivityDays?: number | null;
    now?: Date;
    deps?: FlowIntelligenceDeps;
  },
): Promise<ProposeFlowOutcome> {
  const mode = normalizeAutomationMode(input.mode ?? null);
  if (!mayCoordinatorProposeFlow(mode)) {
    return { outcome: "not_permitted", reason: `automation_mode_${mode}` };
  }

  try {
    const result = await createEmailFlow(admin, {
      ownerId: input.ownerId,
      flowType: input.flowType,
      inactivityDays: input.inactivityDays ?? null,
      idempotencyKey: coordinatorProposalKey(input.ownerId, input.flowType),
      createdBy: "coordinator",
      mode,
      now: input.now,
      deps: input.deps,
    });
    return { outcome: "proposed", result };
  } catch (error) {
    if (error instanceof EmailFlowValidationError && error.code === "flow_type_already_exists") {
      return { outcome: "already_exists" };
    }
    return {
      outcome: "failed",
      reason: error instanceof Error ? error.message : "unknown_error",
    };
  }
}

/**
 * A stable, caller-minted idempotency key for an explicit user creation, so a
 * double-clicked Create cannot build two flows.
 */
export function userFlowKey(ownerId: string, flowType: EmailFlowType, nonce: string): string {
  return createHash("sha256")
    .update(`voom-email-flow:${ownerId}:${flowType}:${nonce}`)
    .digest("hex")
    .slice(0, 48);
}

export function defaultFlowName(flowType: EmailFlowType): string {
  return flowTypePolicy(flowType).label;
}

async function loadFlowBrandContext(
  admin: SupabaseClient,
  ownerId: string,
): Promise<{ context: FlowBrandContext; timeZone: string; businessId: string | null }> {
  const { data } = await admin.from("businesses")
    .select("id,brand_name,brand_description,industry,target_customer,main_goal,brand_personality,timezone")
    .eq("owner_user_id", ownerId)
    .maybeSingle();

  const row = (data ?? {}) as Record<string, unknown>;
  return {
    context: {
      brandName: String(row.brand_name ?? "Your business").slice(0, 160),
      brandDescription: String(row.brand_description ?? "").slice(0, 800),
      industry: String(row.industry ?? "").slice(0, 200),
      targetCustomer: Array.isArray(row.target_customer) ? (row.target_customer as string[]).slice(0, 6) : [],
      mainGoal: String(row.main_goal ?? "").slice(0, 300),
      brandPersonality: Array.isArray(row.brand_personality) ? (row.brand_personality as string[]).slice(0, 8) : [],
    },
    timeZone: accountTimezone((row.timezone as string | null) ?? null),
    businessId: row.id ? String(row.id) : null,
  };
}
