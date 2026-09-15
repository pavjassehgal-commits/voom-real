import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getBrandProfile } from "@/lib/mara/internal-data";
import { listAudiences } from "@/lib/contacts/server-data";
import { loadPerformancePlanContext } from "@/lib/performance/data";
import type { PerformancePlanContext } from "@/lib/performance/plan-context";
import {
  normalizeAutomationMode,
  type AutomationModeValue,
} from "@/lib/voom/automation";
import { getPostDraft, approvePostDraft } from "@/lib/post/server-data";
import { postApprovalBlockers } from "@/lib/post/core";
import { cancelPublishItem } from "@/lib/instagram/publish-queue";
import { planCampaign } from "./planner";
import {
  deriveActionState,
  deriveCampaignLifecycle,
  lifecycleLabel,
  type ActionExecutionState,
  ACTION_EXECUTION_LABELS,
} from "./status";
import type {
  AutomatedCampaignView,
  CampaignActionChannel,
  CampaignActionRecord,
  CampaignActionView,
  CampaignBrief,
  CampaignContainerRecord,
  PlannerPerformanceInput,
} from "./types";

type Db = SupabaseClient;
type Admin = SupabaseClient;

export interface BuildAutomatedCampaignInput {
  brief: CampaignBrief;
  /** Saved automation mode; Manual/Assisted/Autopilot change gating only. */
  mode: string | null | undefined;
  /** Build idempotency key minted by the client; same key never duplicates. */
  idempotencyKey: string;
  now?: Date;
}

export interface BuildResult {
  campaignId: string;
  mode: AutomationModeValue;
  actionCount: number;
  summary: string;
  /** True when real performance evidence shaped the plan. */
  performanceUsed: boolean;
}

/**
 * A failed create_automated_campaign RPC.
 *
 * `code` preserves the originating Postgres SQLSTATE (e.g. "23514" check
 * constraint violation, "42P01" undefined table) or PostgREST code (e.g.
 * "PGRST202" stale schema cache), so the API layer can distinguish
 * missing-migration errors from integrity errors from general failures.
 * The message is fixed and non-sensitive: the actual Postgres message,
 * details and hint are logged server-side only and never reach the client.
 */
export class AutomatedCampaignBuildError extends Error {
  readonly code: string | null;

  constructor(code: string | null, cause?: unknown) {
    super("automated_campaign_build_failed", { cause });
    this.name = "AutomatedCampaignBuildError";
    this.code = code;
  }
}

/**
 * Logs the real Postgres failure (code, message, details, hint) for
 * server-side diagnosis only. None of it is returned to the client: the
 * API layer maps the SQLSTATE to a fixed, non-sensitive message.
 */
function logAutomatedBuildFailure(error: {
  code?: string | null;
  message?: string | null;
  details?: string | null;
  hint?: string | null;
} | null): void {
  console.error("[voom][campaign-build] create_automated_campaign RPC failed", {
    code: error?.code ?? null,
    message: error?.message ?? null,
    details: error?.details ?? null,
    hint: error?.hint ?? null,
  });
}

/**
 * Build an Automated Campaign from the guided brief.
 *
 * The build is planning-only: it writes drafts, child email campaigns, the
 * timeline rows and (Autopilot-safe) approved calendar mirrors. It never
 * sends email, never enqueues an Instagram publish job, never calls an AI/media
 * provider and never spends paid media credits — Instagram drafts are created
 * without visuals precisely so the existing media/publishing paths (and their
 * approval gates) remain the only way anything external happens.
 */
export async function buildAutomatedCampaign(
  db: Db,
  admin: Admin,
  ownerId: string,
  input: BuildAutomatedCampaignInput,
): Promise<BuildResult> {
  const mode = normalizeAutomationMode(input.mode);
  const now = input.now ?? new Date();

  const [brand, audiencesResult, performance] = await Promise.all([
    getBrandProfile(db, ownerId),
    listAudiences(db, { owner_id: ownerId, limit: 200 }).catch(() => ({ ok: false as const, data: [] })),
    loadPerformancePlanContext(db, ownerId).catch(() => null),
  ]);

  const audiences = audiencesResult.ok
    ? audiencesResult.data.map((audience) => ({ id: audience.id, name: audience.name }))
    : [];

  // When the brief names an audience, verify ownership before planning emails
  // against it. An audience from another workspace is dropped, never trusted.
  let audienceId: string | null = null;
  if (input.brief.audienceId) {
    const owned = audiences.find((audience) => audience.id === input.brief.audienceId);
    if (owned) audienceId = owned.id;
  }

  const plan = planCampaign({
    brief: { ...input.brief, audienceId },
    brand: {
      brandName: brand.brand_name,
      brandDescription: brand.brand_description,
      industry: brand.industry,
      targetCustomer: brand.target_customer,
      brandPersonality: brand.brand_personality,
      mainGoal: brand.main_goal,
    },
    audiences,
    performance: toPlannerPerformance(performance),
    now,
  });

  // Automation gating. This is the ONLY place the mode changes persisted
  // state, and it can only move work further INTO review, never into a send:
  //   manual    → every action is a draft proposal;
  //   assisted  → every action waits for approval (drafts only);
  //   autopilot → safe actions are approved internally; anything the existing
  //               safety evaluator blocks still waits for approval. Email is
  //               never sent in any mode (no send call exists here).
  const actionsPayload = plan.actions.map((action) => {
    const status = mode === "autopilot" && action.autopilotSafe
      ? "approved"
      : mode === "manual"
        ? "proposed"
        : "needs_approval";
    const key = actionKey(input.idempotencyKey, action.slot);
    if (action.channel === "email") {
      return {
        slot: action.slot,
        channel: action.channel,
        stage: action.stage,
        title: action.title,
        purpose: action.purpose,
        scheduledFor: action.scheduledFor,
        status,
        subject: action.subject ?? action.title,
        previewText: action.previewText ?? "",
        body: action.body ?? action.title,
        cta: action.cta ?? "",
        audienceId: action.audienceId ?? audienceId,
        safetyBlockers: action.autopilotBlockers,
        idempotencyKey: key,
      };
    }
    return {
      slot: action.slot,
      channel: action.channel,
      stage: action.stage,
      title: action.title,
      purpose: action.purpose,
      scheduledFor: action.scheduledFor,
      status,
      concept: action.concept ?? action.title,
      caption: action.caption ?? "",
      hashtags: action.hashtags ?? [],
      safetyBlockers: action.autopilotBlockers,
      idempotencyKey: key,
    };
  });

  const summaryParts = [plan.summary.narrative];
  if (plan.summary.performanceNote) summaryParts.push(plan.summary.performanceNote);

  const { data, error } = await admin.rpc("create_automated_campaign", {
    p_owner_user_id: ownerId,
    p_payload: {
      campaign: {
        idempotencyKey: input.idempotencyKey,
        name: input.brief.name,
        goal: input.brief.goal,
        startAt: toUtcStart(input.brief.startAt),
        endAt: toUtcEnd(input.brief.endAt),
        offerDetails: input.brief.offerDetails ?? "",
        audience: input.brief.targetAudience ?? "",
        audienceId,
        notes: input.brief.notes ?? "",
        summary: summaryParts.join(" "),
      },
      actions: actionsPayload,
    },
  }).single();

  if (error || !data) {
    // Log the actual Postgres failure (code/message/details/hint)
    // server-side; the client only ever sees a fixed, safe message.
    logAutomatedBuildFailure(error);
    throw new AutomatedCampaignBuildError(error?.code ?? null, error);
  }
  const container = data as CampaignContainerRecord;

  return {
    campaignId: container.id,
    mode,
    actionCount: actionsPayload.length,
    summary: summaryParts.join(" "),
    performanceUsed: plan.summary.performanceUsed,
  };
}

// ─── Read model ────────────────────────────────────────────────────────────

export async function readAutomatedCampaign(db: Db, ownerId: string, id: string): Promise<AutomatedCampaignView | null> {
  const [{ data: campaign }, { data: actionRows }] = await Promise.all([
    db.from("voom_campaigns").select(CONTAINER_SELECT)
      .eq("owner_user_id", ownerId).eq("id", id).maybeSingle(),
    db.from("voom_campaign_actions")
      .select(ACTION_SELECT)
      .eq("owner_user_id", ownerId).eq("campaign_id", id).order("slot", { ascending: true }),
  ]);
  const container = campaign as CampaignContainerRecord | null;
  if (!container || container.kind !== "multi") return null;

  const actions = (actionRows ?? []) as unknown as CampaignActionRecord[];
  const emailIds = actions.map((a) => a.email_campaign_id).filter((x): x is string => Boolean(x));
  const draftIds = actions.map((a) => a.draft_id).filter((x): x is string => Boolean(x));

  const [childrenResult, sendsResult, draftsResult, queueResult, assetsResult] = await Promise.all([
    emailIds.length
      ? db.from("voom_campaigns").select("id,status,subject,preview_text,content,audience_id").in("id", emailIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    emailIds.length
      ? db.from("campaign_sends").select("campaign_id,internal_status,updated_at").in("campaign_id", emailIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("mara_drafts").select("id,kind,status,title,content,proposed_publish_at").in("id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("instagram_publish_queue").select("draft_id,status").in("draft_id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("post_draft_assets").select("draft_id").in("draft_id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
  ]);

  const children = new Map<string, Record<string, unknown>>((childrenResult.data ?? []).map((row) => [String(row.id), row]));
  const drafts = new Map<string, Record<string, unknown>>((draftsResult.data ?? []).map((row) => [String(row.id), row]));
  const assets = new Set<string>((assetsResult.data ?? []).map((row) => String(row.draft_id)));

  const latestSend = new Map<string, string>();
  for (const row of sendsResult.data ?? []) {
    const campaignId = String(row.campaign_id);
    const current = latestSend.get(campaignId);
    if (!current) latestSend.set(campaignId, String(row.internal_status));
  }
  const queueByDraft = new Map<string, string>();
  for (const row of queueResult.data ?? []) queueByDraft.set(String(row.draft_id), String(row.status));

  const views: CampaignActionView[] = actions.map((action) => {
    const base: CampaignActionView = {
      ...action,
      executionState: "proposed",
      executionLabel: ACTION_EXECUTION_LABELS.proposed,
      email: null,
      instagram: null,
    };

    if (action.channel === "email" && action.email_campaign_id) {
      const child = children.get(action.email_campaign_id);
      const sendStatus = (latestSend.get(action.email_campaign_id) ?? null) as
        | "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped" | null;
      const childStatus = (String(child?.status ?? "draft") as "draft" | "approved" | "rejected");
      const state = deriveActionState({
        kind: "email",
        planStatus: action.status,
        childStatus: child ? childStatus : null,
        sendStatus,
        scheduledFor: action.scheduled_for,
      });
      base.executionState = state;
      base.executionLabel = ACTION_EXECUTION_LABELS[state];
      base.email = {
        subject: child?.subject != null ? String(child.subject) : action.title,
        previewText: child?.preview_text != null ? String(child.preview_text) : null,
        body: child ? String(child.content ?? "") : "",
        cta: extractCta(child ? String(child.content ?? "") : ""),
        childCampaignId: action.email_campaign_id,
        childStatus,
        canSendExplicitly: childStatus === "approved",
      };
      return base;
    }

    if (action.draft_id) {
      const draft = drafts.get(action.draft_id);
      const queueStatus = queueByDraft.get(action.draft_id) ?? null;
      const draftStatus = String(draft?.status ?? "draft") as "draft" | "approved" | "rejected";
      const state = deriveActionState({
        kind: "instagram",
        planStatus: action.status,
        draftStatus: draft ? draftStatus : null,
        queueStatus: queueStatus as never,
        scheduledFor: action.scheduled_for,
      });
      base.executionState = state;
      base.executionLabel = ACTION_EXECUTION_LABELS[state];
      base.instagram = {
        draftId: action.draft_id,
        concept: action.title,
        caption: draft ? String(draft.content ?? "") : "",
        draftStatus,
        queueStatus,
        needsVisual: !assets.has(action.draft_id),
      };
    }
    return base;
  });

  const lifecycle = deriveCampaignLifecycle({
    actions: views.map(toFacts),
    startAt: container.start_at,
    endAt: container.end_at,
  });

  return {
    campaign: container,
    actions: views,
    lifecycle,
    lifecycleLabel: lifecycleLabel(lifecycle),
    counts: {
      total: views.length,
      email: views.filter((a) => a.channel === "email").length,
      instagram: views.filter((a) => a.channel !== "email").length,
      approved: views.filter((a) => ["approved", "scheduled", "executing", "executed"].includes(a.executionState)).length,
      executed: views.filter((a) => a.executionState === "executed").length,
      needingApproval: views.filter((a) => ["proposed", "needs_approval"].includes(a.executionState)).length,
      failed: views.filter((a) => a.executionState === "failed").length,
    },
  };
}

function toFacts(view: CampaignActionView): import("./status").ActionFacts {
  if (view.channel === "email" && view.email) {
    const sendStatus = (
      view.executionState === "executed"
        ? (view.email.childStatus === "rejected" ? "skipped" : "accepted")
        : view.executionState === "executing"
          ? "sending"
          : view.executionState === "failed"
            ? "failed"
            : view.executionState === "skipped"
              ? "skipped"
              : null
    ) as "queued" | "sending" | "accepted" | "delivered" | "failed" | "skipped" | null;
    return {
      kind: "email",
      planStatus: view.status,
      childStatus: view.email.childStatus,
      sendStatus,
      scheduledFor: view.scheduled_for,
    };
  }
  return {
    kind: "instagram",
    planStatus: view.status,
    draftStatus: view.instagram?.draftStatus ?? null,
    queueStatus: (view.instagram?.queueStatus ?? null) as import("./status").InstagramActionFacts["queueStatus"],
    scheduledFor: view.scheduled_for,
  };
}

// ─── Per-action approvals (approval state only; nothing external) ──────────

/**
 * Approve or reject one timeline action.
 *
 * Email: flips the child email campaign's approval only. The existing explicit
 * delivery POST remains the ONLY path that sends.
 * Instagram: approval reuses the exact Post Studio gate — a campaign draft has
 * no visual, so approval is refused truthfully until one is added through
 * Create Content; Voom never auto-generates paid media during a campaign build.
 */
export async function decideCampaignAction(
  admin: Admin,
  ownerId: string,
  campaignId: string,
  actionId: string,
  decision: "approve" | "reject",
): Promise<{ ok: boolean; blockers?: string[]; action?: CampaignActionRecord }> {
  const { data: row, error } = await admin.from("voom_campaign_actions")
    .select(ACTION_SELECT)
    .eq("owner_user_id", ownerId).eq("campaign_id", campaignId).eq("id", actionId).maybeSingle();
  if (error) throw new Error("campaign_action_unavailable");
  const action = row as CampaignActionRecord | null;
  if (!action) return { ok: false, blockers: ["That campaign action was not found."] };

  if (action.channel === "email") {
    const { error: rpcError } = await admin.rpc("set_campaign_action_email_approval", {
      p_owner_user_id: ownerId,
      p_action_id: action.id,
      p_action: decision,
    });
    if (rpcError) throw new Error("campaign_action_decision_failed");
  } else {
    if (!action.draft_id) return { ok: false, blockers: ["That Instagram draft was not found."] };
    if (decision === "reject") {
      const { error: rejectError } = await admin.from("mara_drafts").update({ status: "rejected" })
        .eq("owner_user_id", ownerId).eq("id", action.draft_id);
      if (rejectError) throw new Error("campaign_action_decision_failed");
      await cancelPublishItem(admin, ownerId, action.draft_id).catch(() => false);
      await admin.from("content_calendar_items").delete()
        .eq("owner_user_id", ownerId).eq("source_draft_id", action.draft_id);
      await admin.from("voom_campaign_actions").update({ status: "skipped" })
        .eq("owner_user_id", ownerId).eq("id", action.id);
    } else {
      const post = await getPostDraft(admin, ownerId, action.draft_id);
      if (!post) return { ok: false, blockers: ["That Instagram draft was not found."] };
      const blockers = postApprovalBlockers({ caption: post.caption, hasVisual: post.visualReady, kind: post.kind });
      if (blockers.length) return { ok: false, blockers };
      await approvePostDraft(admin, ownerId, action.draft_id);
      await admin.from("voom_campaign_actions").update({ status: "approved" })
        .eq("owner_user_id", ownerId).eq("id", action.id);
    }
  }

  const { data: updated } = await admin.from("voom_campaign_actions")
    .select(ACTION_SELECT).eq("owner_user_id", ownerId).eq("id", action.id).maybeSingle();
  return { ok: true, action: updated as CampaignActionRecord };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const CONTAINER_SELECT =
  "id,kind,is_automated,parent_campaign_id,name,objective,audience,audience_id,subject,preview_text,content,proposed_send_at,status,goal,start_at,end_at,offer_details,campaign_notes,generated_summary,approved_at,created_at,updated_at";
const ACTION_SELECT =
  "id,campaign_id,slot,channel,stage,title,purpose,scheduled_for,status,email_campaign_id,draft_id,safety_blockers,created_at,updated_at";

function actionKey(buildKey: string, slot: number): string {
  return createHash("sha256").update(`campaign-action:${buildKey}:${slot}`).digest("hex").slice(0, 32);
}

export function newBuildIdempotencyKey(): string {
  return randomUUID();
}

// Date-only inputs are the business's Dubai calendar (UTC+4, no DST).
function toUtcStart(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T00:00+04:00`).toISOString();
  return new Date(value).toISOString();
}

function toUtcEnd(value: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Date(`${value}T23:59+04:00`).toISOString();
  return new Date(value).toISOString();
}

function extractCta(body: string): string | null {
  const match = /CTA:\s*(.+)/.exec(body);
  return match ? match[1].trim() : null;
}

function toPlannerPerformance(context: PerformancePlanContext | null): PlannerPerformanceInput | null {
  if (!context) return null;
  return {
    sampleSize: context.sampleSize,
    confidence: context.confidence === "moderate" ? "moderate" : "low",
    bestContentTypeLabel: context.bestContentType?.label ?? null,
    winnerLabels: context.recentWinners.map((winner) => winner.label),
    engagementSignals: context.engagementSignals,
  };
}

export type { ActionExecutionState, CampaignActionChannel };
