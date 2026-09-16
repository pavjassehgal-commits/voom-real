import "server-only";

import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminClient } from "@/utils/supabase/admin";

import { getBrandProfile } from "@/lib/mara/internal-data";
import { listAudiences } from "@/lib/contacts/server-data";
import { loadPerformancePlanContext } from "@/lib/performance/data";
import type { PerformancePlanContext } from "@/lib/performance/plan-context";
import {
  normalizeAutomationMode,
  type AutomationModeValue,
} from "@/lib/voom/automation";
import { getPostDraft, approvePostDraft } from "@/lib/post/server-data";
import { postApprovalBlockers, composePostCaption } from "@/lib/post/core";
import { cancelPublishItem } from "@/lib/instagram/publish-queue";
import { evaluateAutopilotRecommendation } from "@/lib/mara/autopilot-safety";
import {
  classifyReelProduction,
  productionStatusFor,
  type ReelProductionMethod,
} from "@/lib/mara/reel-production";
import { checkScheduleInstant } from "@/lib/voom/schedule-guard";
import { canUseAutopilot, normalizePlan, type PlanId } from "@/lib/billing/plans";
import { accountTimezone, daysBetween, isoToLocalDate, localToUtcIso } from "@/lib/voom/timezone";
import { generateCampaignIntelligence, type CampaignIntelligenceDeps } from "./intelligence";
import { planCampaign } from "./planner";
import {
  applyCampaignIntelligence,
  buildCampaignIntelligenceContext,
  toCampaignStrategyView,
  type CampaignStrategyView,
  type EnrichedCampaignAction,
} from "./strategy";
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
  CampaignActionContentRecord,
  CampaignActionRecord,
  CampaignActionView,
  CampaignBrief,
  CampaignContainerRecord,
  CampaignStrategyRecord,
  PlannerPerformanceInput,
} from "./types";
import { CAMPAIGN_GOAL_LABELS } from "./types";

type Db = SupabaseClient;
type Admin = SupabaseClient;

export interface BuildAutomatedCampaignInput {
  brief: CampaignBrief;
  /** Saved automation mode; Manual/Assisted/Autopilot change gating only. */
  mode: string | null | undefined;
  /** Build idempotency key minted by the client; same key never duplicates. */
  idempotencyKey: string;
  /** Workspace/business timezone resolved by the build route. */
  timeZone?: string | null;
  /** Billing context is explicit in production; omitted in legacy/test seams. */
  planId?: PlanId | string | null;
  allowAutomaticPaidMedia?: boolean | null;
  now?: Date;
  /**
   * Test seam for the text-AI provider. Production omits it and the existing
   * MARA text provider (`@/lib/ai`) is used. No media provider is ever
   * injectable here: campaign generation cannot reach one.
   */
  deps?: CampaignIntelligenceDeps;
}

export interface BuildResult {
  campaignId: string;
  mode: AutomationModeValue;
  actionCount: number;
  summary: string;
  /** True when real performance evidence shaped the plan. */
  performanceUsed: boolean;
  /** "mara" when MARA wrote the content, "deterministic" for the v1 fallback. */
  generationSource: "mara" | "deterministic";
  /** Slots whose MARA content was refused and kept the deterministic draft. */
  fallbackSlots: number[];
  /** Why the text provider was not used, or null when it was. */
  intelligenceReason: string | null;
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
 * Pipeline: `deterministic skeleton → MARA intelligence → validated plan`.
 * `planCampaign()` stays the only authority on structure (date range, action
 * count, channels, action types, timing boundaries); MARA only fills strategy
 * and content inside it, and every field is schema-validated before it is
 * stored. If the text provider is unavailable or returns anything unusable, the
 * deterministic v1 content is used unchanged and the campaign is still created
 * (`generationSource: "deterministic"`).
 *
 * The build is planning-only: it writes drafts, child email campaigns, the
 * timeline rows and (Autopilot-safe) approved calendar mirrors. It never
 * sends email, never enqueues an Instagram publish job, never submits paid
 * media and never spends paid media credits — Instagram drafts are created
 * without visuals precisely so the existing media/publishing paths (and their
 * approval gates and the central credit guard) remain the only way anything
 * external happens. The only provider call is the text-AI one, and it is
 * optional: its failure changes nothing about what is persisted structurally.
 */
export async function buildAutomatedCampaign(
  db: Db,
  admin: Admin,
  ownerId: string,
  input: BuildAutomatedCampaignInput,
): Promise<BuildResult> {
  const mode = normalizeAutomationMode(input.mode);
  const now = input.now ?? new Date();
  const timeZone = accountTimezone(input.timeZone);
  // Direct unit/test seams may omit billing context; production routes pass it
  // explicitly, including null for an unconfigured plan. An explicit null must
  // fail closed rather than being mistaken for the legacy omission.
  const hasBillingContext = input.planId !== undefined || input.allowAutomaticPaidMedia !== undefined;
  const autopilotEntitled = !hasBillingContext
    || (input.planId != null && canUseAutopilot(normalizePlan(input.planId)) && input.allowAutomaticPaidMedia === true);

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

  const brandContext = {
    brandName: brand.brand_name,
    brandDescription: brand.brand_description,
    industry: brand.industry,
    targetCustomer: brand.target_customer,
    brandPersonality: brand.brand_personality,
    mainGoal: brand.main_goal,
  };
  const plannerPerformance = toPlannerPerformance(performance);
  const brief = { ...input.brief, audienceId };

  // 1) The deterministic skeleton. This is the safe structure: date range,
  //    action count, channels, action types and timing boundaries all come
  //    from here and are never negotiable with the model.
  const plan = planCampaign({
    brief,
    brand: brandContext,
    audiences,
    performance: plannerPerformance,
    timeZone,
    now,
  });

  const selectedAudience = audienceId ? audiences.find((audience) => audience.id === audienceId) ?? null : null;
  const goalLabel = CAMPAIGN_GOAL_LABELS[brief.goal] ?? "Campaign";

  // 2) MARA intelligence — text only, existing MARA text provider, strict
  //    structured output. A failure is not an error: the deterministic plan
  //    stands and the campaign is still created.
  const context = buildCampaignIntelligenceContext({
    businessName: brand.brand_name,
    brand: brandContext,
    brief,
    goalLabel,
    audiences,
    selectedAudience,
    automationMode: mode,
    skeleton: plan.actions,
    summary: plan.summary,
    performance: plannerPerformance,
    timeZone,
    now,
  });
  const generated = await generateCampaignIntelligence(context, input.deps ?? {});

  // 3) Validated merge. The skeleton's length, channels, stages, days and
  //    timing boundaries win; refused content falls back per action.
  const merged = applyCampaignIntelligence({
    skeleton: plan.actions,
    summary: plan.summary,
    brief,
    brand: brandContext,
    goalLabel,
    intelligence: generated.ok ? generated.intelligence : null,
    timeZone,
    now,
  });

  // Automation gating. This is the ONLY place the mode changes persisted
  // state, and it can only move work further INTO review, never into a send:
  //   manual    → every action is a draft proposal;
  //   assisted  → every action waits for approval (drafts only);
  //   autopilot → safe actions are approved internally; anything the existing
  //               safety evaluator blocks still waits for approval. Email is
  //               never sent in any mode (no send call exists here), and paid
  //               media is never submitted in any mode (no media call exists
  //               here either — that stays behind the central credit guard).
  const actionsPayload = merged.actions.map((rawAction) => {
    // Keep the historical three-way gating expression as the final persisted
    // decision. Billing entitlement only changes the safety bit feeding it, so
    // a Free/Pro account can never turn an Autopilot request into approval.
    const action = autopilotEntitled ? rawAction : { ...rawAction, autopilotSafe: false };
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
        contentSource: action.contentSource,
        content: emailContentRecord(action),
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
      contentSource: action.contentSource,
      content: instagramContentRecord(action),
    };
  });

  const strategy = toCampaignStrategyView(merged);
  const summaryParts = [strategy.summary];
  if (merged.performanceNote) summaryParts.push(merged.performanceNote);

  const { data, error } = await admin.rpc("create_automated_campaign", {
    p_owner_user_id: ownerId,
    p_payload: {
      campaign: {
        idempotencyKey: input.idempotencyKey,
        name: input.brief.name,
        goal: input.brief.goal,
        startAt: toUtcStart(input.brief.startAt, timeZone),
        endAt: toUtcEnd(input.brief.endAt, timeZone),
        offerDetails: input.brief.offerDetails ?? "",
        audience: input.brief.targetAudience ?? "",
        audienceId,
        notes: input.brief.notes ?? "",
        summary: summaryParts.join(" "),
        strategy: strategyPayload(strategy),
        strategySummary: strategy.summary,
        generationSource: merged.source,
        fallbackSlots: merged.fallbackSlots,
        performanceUsed: plan.summary.performanceUsed,
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
    /** Which layer wrote the campaign content: MARA or the v1 fallback. */
    generationSource: merged.source,
    /** Slots whose MARA content was refused and kept the deterministic draft. */
    fallbackSlots: merged.fallbackSlots,
    /** Truthful reason when MARA text generation was not used. */
    intelligenceReason: generated.ok ? null : generated.reason,
  };
}

// ─── Read model ────────────────────────────────────────────────────────────

export async function readAutomatedCampaign(db: Db, ownerId: string, id: string): Promise<AutomatedCampaignView | null> {
  const [{ data: campaign }, { data: actionRows }, { data: business }] = await Promise.all([
    db.from("voom_campaigns").select(CONTAINER_SELECT)
      .eq("owner_user_id", ownerId).eq("id", id).maybeSingle(),
    db.from("voom_campaign_actions")
      .select(ACTION_SELECT)
      .eq("owner_user_id", ownerId).eq("campaign_id", id).order("slot", { ascending: true }),
    db.from("businesses").select("timezone").eq("owner_user_id", ownerId).maybeSingle(),
  ]);
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
  const container = campaign as CampaignContainerRecord | null;
  if (!container || container.kind !== "multi") return null;

  const actions = (actionRows ?? []) as unknown as CampaignActionRecord[];
  const emailIds = actions.map((a) => a.email_campaign_id).filter((x): x is string => Boolean(x));
  const draftIds = actions.map((a) => a.draft_id).filter((x): x is string => Boolean(x));

  const [childrenResult, sendsResult, draftsResult, queueResult, assetsResult, productionResult] = await Promise.all([
    emailIds.length
      ? db.from("voom_campaigns").select("id,status,subject,preview_text,content,audience_id").eq("owner_user_id", ownerId).in("id", emailIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    emailIds.length
      ? db.from("campaign_sends").select("campaign_id,internal_status,updated_at").eq("owner_user_id", ownerId).in("campaign_id", emailIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("mara_drafts").select("id,kind,status,title,content,proposed_publish_at").eq("owner_user_id", ownerId).in("id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("instagram_publish_queue").select("draft_id,status").eq("owner_user_id", ownerId).in("draft_id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("post_draft_assets").select("draft_id").eq("owner_user_id", ownerId).in("draft_id", draftIds)
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
    draftIds.length
      ? db.from("mara_pending_actions").select("id,status,sanitized_arguments,new_value,created_at").eq("owner_user_id", ownerId).eq("tool_name", "choose_reel_production").in("status", ["pending", "confirmed", "executing", "failed"])
      : Promise.resolve({ data: [] as Record<string, unknown>[], error: null }),
  ]);

  const children = new Map<string, Record<string, unknown>>((childrenResult.data ?? []).map((row) => [String(row.id), row]));
  const drafts = new Map<string, Record<string, unknown>>((draftsResult.data ?? []).map((row) => [String(row.id), row]));
  const assets = new Set<string>((assetsResult.data ?? []).map((row) => String(row.draft_id)));
  const productionByDraft = new Map<string, { method: "create_with_mara" | "upload_asset" | "film_yourself" | null; status: string | null }>();
  const productionRows = [...(productionResult.data ?? [])].sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
  for (const row of productionRows) {
    const args = (row.sanitized_arguments ?? {}) as Record<string, unknown>;
    const value = (row.new_value ?? {}) as Record<string, unknown>;
    const draftId = typeof args.draftId === "string" ? args.draftId : null;
    if (!draftId || productionByDraft.has(draftId)) continue;
    const method = value.selectedProductionMethod;
    productionByDraft.set(draftId, {
      method: method === "create_with_mara" || method === "upload_asset" || method === "film_yourself" ? method : null,
      status: typeof value.productionStatus === "string" ? value.productionStatus : null,
    });
  }
  const postViews = new Map<string, Awaited<ReturnType<typeof getPostDraft>>>();
  let assetDb: Admin = db;
  try { assetDb = createAdminClient(); } catch { /* authenticated read remains a safe fallback */ }
  await Promise.all(draftIds.map(async (draftId) => {
    const post = await getPostDraft(assetDb, ownerId, draftId).catch(() => null);
    postViews.set(draftId, post);
  }));

  const latestSend = new Map<string, string>();
  const sendRows = [...(sendsResult.data ?? [])].sort((a, b) => String(b.updated_at ?? "").localeCompare(String(a.updated_at ?? "")));
  for (const row of sendRows) {
    const campaignId = String(row.campaign_id);
    if (!latestSend.has(campaignId)) latestSend.set(campaignId, String(row.internal_status));
  }
  const queueByDraft = new Map<string, string>();
  for (const row of queueResult.data ?? []) queueByDraft.set(String(row.draft_id), String(row.status));

  const views: CampaignActionView[] = actions.map((action) => {
    const content = normalizeActionContent(action.mara_content);
    const base: CampaignActionView = {
      ...action,
      executionState: "proposed",
      executionLabel: ACTION_EXECUTION_LABELS.proposed,
      contentSource: action.content_source ?? "deterministic",
      content,
      // A sent/published action is never editable; the per-channel checks
      // below narrow this with the real send/queue state.
      canEditContent: true,
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
      // Truthful lock: once a real send exists (anything but a skipped row) the
      // content is frozen — what the recipient saw stays what the record says.
      base.canEditContent = sendStatus === null || sendStatus === "skipped";
      base.email = {
        subject: child?.subject != null ? String(child.subject) : action.title,
        previewText: child?.preview_text != null ? String(child.preview_text) : null,
        body: child ? String(child.content ?? "") : "",
        cta: content?.cta ?? extractCta(child ? String(child.content ?? "") : ""),
        ctaUrl: content?.ctaUrl ?? null,
        audienceNote: content?.audienceNote ?? null,
        sendTimeNote: content?.sendTimeNote ?? null,
        childCampaignId: action.email_campaign_id,
        childStatus,
        canSendExplicitly: childStatus === "approved" && (sendStatus === null || sendStatus === "skipped"),
      };
      return base;
    }

    if (action.draft_id) {
      const draft = drafts.get(action.draft_id);
      const postView = postViews.get(action.draft_id);
      const queueStatus = queueByDraft.get(action.draft_id) ?? null;
      const draftStatus = String(draft?.status ?? "draft") as "draft" | "approved" | "rejected";
      const hasVisual = postView?.visualReady ?? assets.has(action.draft_id);
      const state = deriveActionState({
        kind: "instagram",
        planStatus: action.status,
        draftStatus: draft ? draftStatus : null,
        hasVisual,
        queueStatus: queueStatus as never,
        scheduledFor: action.scheduled_for,
      });
      base.executionState = state;
      base.executionLabel = ACTION_EXECUTION_LABELS[state];
      // Truthful lock: a queue row that is publishing or already published
      // means Meta owns this content now — it can no longer be rewritten.
      base.canEditContent = queueStatus !== "publishing" && queueStatus !== "published";
      base.instagram = {
        draftId: action.draft_id,
        concept: content?.concept ?? action.title,
        caption: draft ? String(draft.content ?? "") : "",
        format: content?.format ?? formatForChannel(action.channel),
        hook: content?.hook ?? null,
        visualDirection: content?.visualDirection ?? null,
        script: content?.script ?? [],
        cta: content?.cta ?? null,
        draftStatus,
        queueStatus,
        needsVisual: !(postView?.visualReady ?? assets.has(action.draft_id)),
        media: postView?.visual
          ? {
              previewUrl: postView.visual.previewUrl,
              mimeType: postView.visual.mimeType,
              displayName: postView.visual.displayName,
              origin: postView.visual.origin,
            }
          : null,
        availableProductionMethods: action.channel === "instagram_reel"
          ? classifyReelProduction({
              concept: content?.concept ?? action.title,
              script: (content?.script ?? []).join(" "),
            }).availableMethods
          : ["create_with_mara", "upload_asset"],
        selectedProductionMethod: productionByDraft.get(action.draft_id)?.method ?? null,
        productionStatus: productionByDraft.get(action.draft_id)?.status ?? null,
      };
    }
    return base;
  });

  // Slot edits must not leave the detail workspace in an order different from
  // the actual schedule. Keep the durable slot untouched for idempotency, but
  // present the read model chronologically with slot as the deterministic tie-breaker.
  views.sort((a, b) => Date.parse(a.scheduled_for) - Date.parse(b.scheduled_for) || a.slot - b.slot);

  const lifecycle = deriveCampaignLifecycle({
    actions: views.map(toFacts),
    startAt: container.start_at,
    endAt: container.end_at,
  });

  return {
    timeZone,
    campaign: container,
    strategy: toStrategyRecord(container),
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
    hasVisual: view.instagram ? !view.instagram.needsVisual : false,
    queueStatus: (view.instagram?.queueStatus ?? null) as import("./status").InstagramActionFacts["queueStatus"],
    scheduledFor: view.scheduled_for,
  };
}

// ─── Campaign-contained Instagram production ───────────────────────────────

/**
 * Records a Reel production choice beside the campaign action while reusing
 * the existing `choose_reel_production` approval/upload bridge. This creates
 * no media, makes no provider call, and is idempotent per campaign action.
 */
export async function chooseCampaignReelProduction(
  admin: Admin,
  ownerId: string,
  campaignId: string,
  actionId: string,
  method: ReelProductionMethod,
): Promise<{ ok: boolean; pendingActionId?: string; blockers?: string[] }> {
  const action = await loadCampaignAction(admin, ownerId, campaignId, actionId);
  if (!action || action.channel !== "instagram_reel" || !action.draft_id) {
    return { ok: false, blockers: ["That Reel action was not found."] };
  }
  const locked = await actionContentLock(admin, ownerId, action);
  if (locked) return { ok: false, blockers: [locked] };
  const post = await getPostDraft(admin, ownerId, action.draft_id);
  if (!post) return { ok: false, blockers: ["That Reel draft was not found."] };

  const capability = classifyReelProduction({
    concept: post.concept || action.title,
    script: post.composedCaption || action.purpose,
  });
  if (!capability.availableMethods.includes(method)) {
    return { ok: false, blockers: ["That production method is not available for this Reel concept."] };
  }

  const idempotencyKey = `campaign-reel-production:${action.id}`;
  const proposal = {
    draftId: action.draft_id,
    concept: (post.concept || action.title).slice(0, 500),
    script: (post.composedCaption || action.purpose).slice(0, 4000),
    shotInstructions: capability.shotInstructions,
    availableMethods: capability.availableMethods,
    recommendedMethod: capability.recommendedMethod,
    missingAssetRequest: capability.missingAssetRequest,
    allowedAssetKinds: capability.allowedAssetKinds,
    selectedProductionMethod: method,
    productionStatus: productionStatusFor(method),
    assetReceived: post.visualReady,
  };
  const sanitizedArguments = {
    draftId: action.draft_id,
    concept: proposal.concept,
    script: proposal.script,
    shotInstructions: proposal.shotInstructions,
    selectedProductionMethod: method,
    productionStatus: proposal.productionStatus,
  };
  const summary = method === "film_yourself"
    ? "Film this Reel yourself, then upload the finished clip through the campaign workspace."
    : method === "upload_asset"
      ? "Upload an existing Reel asset through the campaign workspace."
      : "Create this Reel with MARA after the explicit production request.";

  const { data: existingRows } = await admin.from("mara_pending_actions")
    .select("id,new_value,status,sanitized_arguments,idempotency_key")
    .eq("owner_user_id", ownerId)
    .eq("tool_name", "choose_reel_production")
    .in("status", ["pending", "confirmed", "executing", "failed"])
    .order("created_at", { ascending: false });
  const existing = (existingRows ?? []).find((row) => {
    const args = (row.sanitized_arguments ?? {}) as Record<string, unknown>;
    return row.idempotency_key === idempotencyKey || args.draftId === action.draft_id;
  });
  if (existing?.id) {
    if (existing.status !== "pending" && existing.status !== "failed") return { ok: true, pendingActionId: String(existing.id) };
    const { error: updateError } = await admin.from("mara_pending_actions")
      .update({ status: "pending", sanitized_arguments: sanitizedArguments, new_value: proposal, summary, idempotency_key: idempotencyKey, error_summary: null, result_summary: null, executed_at: null })
      .eq("owner_user_id", ownerId).eq("id", existing.id).in("status", ["pending", "failed"]);
    if (updateError) throw new Error("reel_production_choice_failed");
    return { ok: true, pendingActionId: String(existing.id) };
  }

  const { data, error } = await admin.from("mara_pending_actions").insert({
    owner_user_id: ownerId,
    conversation_id: post.conversationId,
    tool_name: "choose_reel_production",
    sanitized_arguments: sanitizedArguments,
    summary,
    new_value: proposal,
    idempotency_key: idempotencyKey,
  }).select("id").single();
  if (error || !data?.id) {
    // Two campaign-detail clicks can race before either sees the row. The
    // owner/key uniqueness constraint is the arbiter; replay its winner.
    const { data: replay } = await admin.from("mara_pending_actions")
      .select("id").eq("owner_user_id", ownerId).eq("idempotency_key", idempotencyKey).maybeSingle();
    if (replay?.id) return { ok: true, pendingActionId: String(replay.id) };
    throw new Error("reel_production_choice_failed");
  }
  return { ok: true, pendingActionId: String(data.id) };
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

// ─── v2: editing and regenerating one action's content ─────────────────────

export interface CampaignActionEdit {
  // Email
  subject?: string;
  previewText?: string;
  body?: string;
  audienceNote?: string;
  sendTimeNote?: string;
  // Instagram
  caption?: string;
  concept?: string;
  hook?: string;
  visualDirection?: string;
  script?: string[];
  format?: "post" | "reel" | "story";
  // Shared
  purpose?: string;
  cta?: string;
  ctaUrl?: string | null;
  scheduledFor?: string | null;
}

export interface CampaignActionContentResult {
  ok: boolean;
  blockers?: string[];
  action?: CampaignActionRecord;
}

/**
 * Edits ONE campaign action's draft content before approval.
 *
 * It never rebuilds the campaign, never touches another action, and never
 * sends or publishes: the guarded `update_campaign_action_content` RPC refuses
 * an action that already has a real send in flight/completed or an Instagram
 * queue row that is publishing or published.
 */
export async function editCampaignActionContent(
  admin: Admin,
  ownerId: string,
  campaignId: string,
  actionId: string,
  edit: CampaignActionEdit,
): Promise<CampaignActionContentResult> {
  const action = await loadCampaignAction(admin, ownerId, campaignId, actionId);
  if (!action) return { ok: false, blockers: ["That campaign action was not found."] };

  const locked = await actionContentLock(admin, ownerId, action);
  if (locked) return { ok: false, blockers: [locked] };

  const content = normalizeActionContent(action.mara_content) ?? {};
  const isEmail = action.channel === "email";
  const patch: Record<string, unknown> = {};
  const nextContent: CampaignActionContentRecord = { ...content };
  if (edit.purpose !== undefined) {
    const purpose = edit.purpose.trim();
    if (!purpose || purpose.length > 1000) return { ok: false, blockers: ["Add a purpose between 1 and 1000 characters."] };
    patch.purpose = purpose;
  }

  if (action.channel === "email") {
    if (edit.subject !== undefined) {
      const subject = edit.subject.trim();
      if (!subject || subject.length > 300) return { ok: false, blockers: ["A subject between 1 and 300 characters is required."] };
      patch.subject = subject;
      patch.title = subject.slice(0, 160);
    }
    if (edit.previewText !== undefined) {
      if (edit.previewText.length > 500) return { ok: false, blockers: ["Keep the preview text under 500 characters."] };
      patch.previewText = edit.previewText.trim();
    }
    if (edit.body !== undefined) {
      const body = edit.body.trim();
      if (!body || body.length > 12000) return { ok: false, blockers: ["An email body between 1 and 12000 characters is required."] };
      patch.body = body;
    }
    if (edit.audienceNote !== undefined) nextContent.audienceNote = edit.audienceNote.slice(0, 500);
    if (edit.sendTimeNote !== undefined) nextContent.sendTimeNote = edit.sendTimeNote.slice(0, 300);
    if (edit.cta !== undefined) {
      if (edit.cta.length > 160) return { ok: false, blockers: ["Keep the CTA under 160 characters."] };
      nextContent.cta = edit.cta.trim();
    }
    if (edit.ctaUrl !== undefined) nextContent.ctaUrl = edit.ctaUrl ? edit.ctaUrl.slice(0, 500) : null;
  } else {
    if (edit.format !== undefined) nextContent.format = edit.format;
    const composed = composePostCaption({
      caption: (edit.caption ?? action.title).slice(0, 2200),
      cta: edit.cta ?? content.cta ?? "",
      hashtags: storedHashtags(action),
    });
    if (composed.length > 2200) return { ok: false, blockers: ["Keep the caption under 2200 characters."] };
    patch.caption = composed;
    if (edit.concept !== undefined) {
      const concept = edit.concept.trim();
      if (!concept || concept.length > 160) return { ok: false, blockers: ["A concept between 1 and 160 characters is required."] };
      patch.title = concept;
      nextContent.concept = concept;
    }
    if (edit.hook !== undefined) nextContent.hook = edit.hook.slice(0, 300);
    if (edit.visualDirection !== undefined) nextContent.visualDirection = edit.visualDirection.slice(0, 1200);
    const targetFormat = edit.format ?? formatForChannel(action.channel);
    const script = edit.script !== undefined
      ? edit.script.map((line) => line.trim()).filter(Boolean).slice(0, 8)
      : (content.script ?? []);
    if (targetFormat === "reel") {
      if (!script.length) return { ok: false, blockers: ["A Reel needs at least one shot instruction."] };
      if (script.some((line) => line.length > 300)) return { ok: false, blockers: ["Keep each Reel shot under 300 characters."] };
      nextContent.script = script;
    } else {
      if (edit.script !== undefined && script.length) {
        return { ok: false, blockers: ["Posts and Stories do not use a Reel shot script."] };
      }
      // A Post/Story must not retain Reel-only structure after a format edit.
      nextContent.script = [];
    }
    if (edit.cta !== undefined) {
      if (edit.cta.length > 160) return { ok: false, blockers: ["Keep the CTA under 160 characters."] };
      nextContent.cta = edit.cta.trim();
    }
    patch.queueCaption = composed.slice(0, 2200);
  }

  let scheduledFor = normalizeScheduledFor(edit.scheduledFor, action);
  if (edit.scheduledFor !== undefined && !scheduledFor) {
    return { ok: false, blockers: ["Choose a valid proposed time."] };
  }
  if (edit.scheduledFor !== undefined && scheduledFor && edit.scheduledFor !== null && edit.scheduledFor !== "") {
    const { data: business } = await admin.from("businesses").select("timezone").eq("owner_user_id", ownerId).maybeSingle();
    const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
    const guard = checkScheduleInstant(scheduledFor, new Date(), timeZone, 10);
    if (!guard.ok) return { ok: false, blockers: [guard.error] };
    scheduledFor = guard.publishAt;
  }
  if (scheduledFor) patch.scheduledFor = scheduledFor;

  patch.content = nextContent;
  if (!isEmail && edit.format !== undefined) patch.format = edit.format;
  patch.contentSource = "edited";
  patch.safetyBlockers = evaluateContentSafety(action, patch, scheduledFor ?? action.scheduled_for);

  return writeActionContent(admin, ownerId, action.id, patch, null, false);
}

export interface RegenerateCampaignActionInput {
  /** Client-minted key; a retried regenerate with the same key is a no-op. */
  idempotencyKey: string;
  now?: Date;
  deps?: CampaignIntelligenceDeps;
}

/**
 * "Regenerate draft with MARA" for ONE action.
 *
 * Only that action's draft content is replaced. The action row is never
 * duplicated, no other campaign item is touched, a sent or published action is
 * refused, and no paid image/video is generated — this is a text-only call to
 * the existing MARA text provider. Because the content is new, the item returns
 * to Needs approval (its previous approval described the old draft).
 */
export async function regenerateCampaignAction(
  db: Db,
  admin: Admin,
  ownerId: string,
  campaignId: string,
  actionId: string,
  input: RegenerateCampaignActionInput,
): Promise<CampaignActionContentResult> {
  const now = input.now ?? new Date();
  const action = await loadCampaignAction(admin, ownerId, campaignId, actionId);
  if (!action) return { ok: false, blockers: ["That campaign action was not found."] };

  const locked = await actionContentLock(admin, ownerId, action);
  if (locked) return { ok: false, blockers: [locked] };

  const [{ data: container }, brand, performance, { data: business }] = await Promise.all([
    admin.from("voom_campaigns").select(CONTAINER_SELECT)
      .eq("owner_user_id", ownerId).eq("id", campaignId).maybeSingle(),
    getBrandProfile(db, ownerId).catch(() => null),
    loadPerformancePlanContext(db, ownerId).catch(() => null),
    admin.from("businesses").select("timezone").eq("owner_user_id", ownerId).maybeSingle(),
  ]);
  const timeZone = accountTimezone((business as { timezone?: string | null } | null)?.timezone);
  const campaign = container as CampaignContainerRecord | null;
  if (!campaign) return { ok: false, blockers: ["That campaign was not found."] };

  const goal = (campaign.goal ?? "announce") as CampaignBrief["goal"];
  const brandContext = {
    brandName: brand?.brand_name ?? null,
    brandDescription: brand?.brand_description ?? null,
    industry: brand?.industry ?? null,
    targetCustomer: (brand?.target_customer ?? null) as string[] | null,
    brandPersonality: (brand?.brand_personality ?? null) as string[] | null,
    mainGoal: brand?.main_goal ?? null,
  };
  const brief: CampaignBrief = {
    name: campaign.name,
    goal,
    startAt: campaign.start_at ?? now.toISOString(),
    endAt: campaign.end_at ?? now.toISOString(),
    offerDetails: campaign.offer_details ?? "",
    targetAudience: campaign.audience ?? "",
    notes: campaign.campaign_notes ?? "",
  };
  const plannerPerformance = toPlannerPerformance(performance);

  // The single-slot skeleton: the action's own channel, day and proposed time
  // stay authoritative, exactly as in a full build.
  const skeleton: EnrichedCampaignAction[] = [{
    slot: 0,
    channel: action.channel,
    dayOffset: dayOffsetOf(action.scheduled_for, campaign.start_at, timeZone),
    scheduledFor: action.scheduled_for,
    stage: action.stage,
    title: action.title,
    purpose: action.purpose,
    subject: action.channel === "email" ? action.title : undefined,
    caption: action.channel === "email" ? undefined : action.title,
    hashtags: storedHashtags(action),
    autopilotSafe: true,
    autopilotBlockers: [],
    contentSource: "deterministic",
  }];

  const { data: siblingRows } = await admin.from("voom_campaign_actions")
    .select("slot,channel,title").eq("owner_user_id", ownerId).eq("campaign_id", campaignId)
    .order("slot", { ascending: true });

  const context = buildCampaignIntelligenceContext({
    businessName: brandContext.brandName,
    brand: brandContext,
    brief,
    goalLabel: CAMPAIGN_GOAL_LABELS[goal] ?? "Campaign",
    audiences: [],
    selectedAudience: null,
    automationMode: "manual",
    skeleton,
    summary: {
      days: Math.max(1, dayOffsetOf(campaign.end_at ?? campaign.start_at ?? now.toISOString(), campaign.start_at, timeZone) + 1),
      emailCount: 0,
      postCount: 0,
      reelCount: 0,
      storyCount: 0,
      instagramCount: 0,
      narrative: campaign.generated_summary ?? "",
      performanceUsed: Boolean(plannerPerformance),
      performanceNote: null,
    },
    performance: plannerPerformance,
    timeZone,
    now,
    focus: {
      slot: 0,
      instruction: "Rewrite ONLY this one action. Keep its channel, stage and proposed day. Do not repeat what the other actions in this campaign already say.",
      siblings: (siblingRows ?? [])
        .filter((row) => String(row.slot) !== String(action.slot))
        .map((row) => ({ channel: String(row.channel), title: String(row.title).slice(0, 160) })),
    },
  });

  const generated = await generateCampaignIntelligence(context, input.deps ?? {});
  const merged = applyCampaignIntelligence({
    skeleton,
    summary: {
      days: 1, emailCount: 0, postCount: 0, reelCount: 0, storyCount: 0, instagramCount: 0,
      narrative: campaign.generated_summary ?? "", performanceUsed: false, performanceNote: null,
    },
    brief,
    brand: brandContext,
    goalLabel: CAMPAIGN_GOAL_LABELS[goal] ?? "Campaign",
    intelligence: generated.ok ? generated.intelligence : null,
    timeZone,
    now,
  });
  const next = merged.actions[0];
  if (!next || next.contentSource !== "mara") {
    // Nothing is written: the existing draft stays exactly as it was.
    return { ok: false, blockers: ["MARA couldn't rewrite that draft just now. Your existing draft is unchanged."] };
  }

  const content = normalizeActionContent(action.mara_content) ?? {};
  const patch: Record<string, unknown> = { contentSource: "mara" };

  if (action.channel === "email") {
    patch.title = next.title.slice(0, 160);
    patch.purpose = next.purpose.slice(0, 1000);
    patch.subject = (next.subject ?? next.title).slice(0, 300);
    patch.previewText = (next.previewText ?? "").slice(0, 500);
    patch.body = (next.body ?? next.title).slice(0, 12000);
    patch.content = {
      ...content,
      cta: next.cta ?? null,
      ctaUrl: next.ctaUrl ?? null,
      audienceNote: next.audienceNote ?? null,
      sendTimeNote: next.sendTimeNote ?? null,
    };
  } else {
    const composed = composePostCaption({
      caption: (next.caption ?? next.title).slice(0, 2200),
      cta: next.cta ?? "",
      hashtags: next.hashtags ?? storedHashtags(action),
    });
    patch.title = next.title.slice(0, 160);
    patch.purpose = next.purpose.slice(0, 1000);
    patch.caption = composed;
    patch.queueCaption = composed.slice(0, 2200);
    patch.content = {
      ...content,
      format: next.format ?? formatForChannel(action.channel),
      concept: next.concept ?? next.title,
      hook: next.hook ?? null,
      cta: next.cta ?? null,
      visualDirection: next.visualDirection ?? null,
      script: next.script ?? [],
    };
  }
  patch.scheduledFor = next.scheduledFor;
  patch.safetyBlockers = next.autopilotBlockers;

  // Reset review: the content is new, so the previous approval no longer
  // describes it. The RPC handles the email child status and the Instagram
  // mirror/queue withdrawal — published or in-flight items were refused above.
  return writeActionContent(admin, ownerId, action.id, patch, input.idempotencyKey, true);
}

async function loadCampaignAction(
  admin: Admin,
  ownerId: string,
  campaignId: string,
  actionId: string,
): Promise<CampaignActionRecord | null> {
  const { data, error } = await admin.from("voom_campaign_actions")
    .select(ACTION_SELECT)
    .eq("owner_user_id", ownerId).eq("campaign_id", campaignId).eq("id", actionId).maybeSingle();
  if (error) throw new Error("campaign_action_unavailable");
  return (data as CampaignActionRecord | null) ?? null;
}

/**
 * The truthful content lock: an email with a real send, or an Instagram item
 * that is publishing or published, can never be rewritten.
 */
async function actionContentLock(admin: Admin, ownerId: string, action: CampaignActionRecord): Promise<string | null> {
  if (action.channel === "email") {
    if (!action.email_campaign_id) return "That campaign action was not found.";
    const { data } = await admin.from("campaign_sends")
      .select("internal_status").eq("owner_user_id", ownerId).eq("campaign_id", action.email_campaign_id).limit(1);
    const sent = (data ?? []).some((row) => String(row.internal_status) !== "skipped");
    return sent ? "This email has already been sent, so its content can no longer be changed." : null;
  }
  if (!action.draft_id) return "That campaign action was not found.";
  const { data } = await admin.from("instagram_publish_queue")
    .select("status").eq("owner_user_id", ownerId).eq("draft_id", action.draft_id).maybeSingle();
  const status = data ? String((data as { status: string }).status) : null;
  return status === "published" || status === "publishing"
    ? "This Instagram item is already published or publishing, so its content can no longer be changed."
    : null;
}

async function writeActionContent(
  admin: Admin,
  ownerId: string,
  actionId: string,
  patch: Record<string, unknown>,
  idempotencyKey: string | null,
  resetReview: boolean,
): Promise<CampaignActionContentResult> {
  const { data, error } = await admin.rpc("update_campaign_action_content", {
    p_owner_user_id: ownerId,
    p_action_id: actionId,
    p_patch: patch,
    p_idempotency_key: idempotencyKey,
    p_reset_review: resetReview,
  }).single();
  if (error || !data) {
    const message = `${error?.code ?? ""} ${error?.message ?? ""}`;
    if (/campaign_action_locked/.test(message)) {
      return { ok: false, blockers: ["That action has already been sent or published, so it can no longer be changed."] };
    }
    if (/campaign_action_not_found/.test(message)) {
      return { ok: false, blockers: ["That campaign action was not found."] };
    }
    throw new Error("campaign_action_content_update_failed");
  }
  return { ok: true, action: data as CampaignActionRecord };
}

/** Re-runs the existing Autopilot safety evaluation on edited content. */
function evaluateContentSafety(
  action: CampaignActionRecord,
  patch: Record<string, unknown>,
  scheduledFor: string,
): string[] {
  const content = action.channel === "email"
    ? [patch.subject, patch.previewText, patch.body].filter((v): v is string => typeof v === "string").join("\n")
    : String(patch.caption ?? action.title);
  const evaluation = evaluateAutopilotRecommendation(
      { title: String(patch.title ?? action.title), content, topic: String(patch.purpose ?? action.purpose), publishAt: scheduledFor },
  );
  return evaluation.blockers;
}

function normalizeScheduledFor(value: string | null | undefined, action: CampaignActionRecord): string | null {
  if (value === undefined) return null;
  if (value === null || value === "") return action.scheduled_for;
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

/** Whole-day offset of an instant from the campaign start in the business calendar. */
function dayOffsetOf(instant: string, startAt: string | null, timeZone = "Asia/Dubai"): number {
  if (!startAt) return 0;
  const zone = accountTimezone(timeZone);
  return Math.max(0, daysBetween(isoToLocalDate(startAt, zone), isoToLocalDate(instant, zone)));
}

/** Hashtags stored inside a v1 composed caption, preserved across edits. */
function storedHashtags(action: CampaignActionRecord): string[] {
  const stored = normalizeActionContent(action.mara_content);
  if (Array.isArray((stored as { hashtags?: unknown } | null)?.hashtags)) {
    return ((stored as { hashtags: unknown[] }).hashtags).filter((tag): tag is string => typeof tag === "string");
  }
  return [];
}

// ─── Helpers ───────────────────────────────────────────────────────────────

const CONTAINER_SELECT =
  "id,kind,is_automated,parent_campaign_id,name,objective,audience,audience_id,subject,preview_text,content,proposed_send_at,status,goal,start_at,end_at,offer_details,campaign_notes,generated_summary,strategy,strategy_summary,generation_source,approved_at,created_at,updated_at";
const ACTION_SELECT =
  "id,campaign_id,slot,channel,stage,title,purpose,scheduled_for,status,email_campaign_id,draft_id,safety_blockers,mara_content,content_source,created_at,updated_at";

function actionKey(buildKey: string, slot: number): string {
  return createHash("sha256").update(`campaign-action:${buildKey}:${slot}`).digest("hex").slice(0, 32);
}

export function newBuildIdempotencyKey(): string {
  return randomUUID();
}

// Date-only inputs are the business's local calendar, resolved through the
// same timezone source as the planner. Full instants retain their instant.
function toUtcStart(value: string, timeZone = "Asia/Dubai"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return localToUtcIso(value, 0, accountTimezone(timeZone));
  return new Date(value).toISOString();
}

function toUtcEnd(value: string, timeZone = "Asia/Dubai"): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return localToUtcIso(value, 23 * 60 + 59, accountTimezone(timeZone));
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
    // v2: the extra evidence MARA's campaign intelligence receives. It is
    // still advisory, still bounded, and still absent when there is not
    // enough real data (buildPerformancePlanContext already returned null).
    basis: context.basis,
    windowDays: context.windowDays,
    strongestTopicLabel: context.strongestTopic?.label ?? null,
    underperformerLabels: context.underperformingThemes.map((theme) => theme.label),
  };
}

// ─── v2 content helpers ────────────────────────────────────────────────────

/** The structured content stored on an email action. */
function emailContentRecord(action: EnrichedCampaignAction): CampaignActionContentRecord {
  return {
    cta: action.cta ?? undefined,
    ctaUrl: action.ctaUrl ?? null,
    audienceNote: action.audienceNote ?? undefined,
    sendTimeNote: action.sendTimeNote ?? undefined,
  };
}

/** The structured content stored on an Instagram action. */
function instagramContentRecord(action: EnrichedCampaignAction): CampaignActionContentRecord {
  return {
    format: action.format ?? formatForChannel(action.channel),
    concept: action.concept ?? undefined,
    hook: action.hook ?? undefined,
    cta: action.cta ?? undefined,
    visualDirection: action.visualDirection ?? undefined,
    script: action.script ?? [],
    hashtags: action.hashtags ?? [],
  };
}

/** The strategy object persisted on the container (plus its advisory note). */
function strategyPayload(strategy: CampaignStrategyView) {
  return {
    objective: strategy.objective,
    coreMessage: strategy.coreMessage,
    audienceAngle: strategy.audienceAngle,
    narrative: strategy.narrative,
    ctaStrategy: strategy.ctaStrategy,
    sequenceRationale: strategy.sequenceRationale,
    performanceNote: strategy.performanceNote,
  };
}

function formatForChannel(channel: string): "post" | "reel" | "story" {
  if (channel === "instagram_reel") return "reel";
  if (channel === "instagram_story") return "story";
  return "post";
}

/** Reads the stored strategy back into the presentation shape. */
function toStrategyRecord(container: CampaignContainerRecord): CampaignStrategyRecord | null {
  const stored = (container.strategy ?? null) as Record<string, unknown> | null;
  const summary = container.strategy_summary?.trim();
  if (!stored && !summary) return null;
  const text = (key: string) => (typeof stored?.[key] === "string" ? String(stored?.[key]) : "");
  return {
    objective: text("objective"),
    coreMessage: text("coreMessage"),
    audienceAngle: text("audienceAngle"),
    narrative: text("narrative"),
    ctaStrategy: text("ctaStrategy"),
    sequenceRationale: text("sequenceRationale"),
    summary: summary ?? text("sequenceRationale"),
    source: container.generation_source === "mara" ? "mara" : "deterministic",
    performanceNote: typeof stored?.performanceNote === "string" ? String(stored.performanceNote) : null,
  };
}

/** Normalizes the stored `mara_content` jsonb, tolerating older rows. */
function normalizeActionContent(value: unknown): CampaignActionContentRecord | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const text = (key: string) => (typeof raw[key] === "string" && raw[key] ? String(raw[key]) : null);
  const content: CampaignActionContentRecord = {
    ...(raw.format === "post" || raw.format === "reel" || raw.format === "story" ? { format: raw.format } : {}),
    concept: text("concept") ?? undefined,
    hook: text("hook") ?? undefined,
    cta: text("cta") ?? undefined,
    ctaUrl: text("ctaUrl") ?? null,
    visualDirection: text("visualDirection") ?? undefined,
    script: Array.isArray(raw.script) ? raw.script.filter((line): line is string => typeof line === "string") : [],
    hashtags: Array.isArray(raw.hashtags) ? raw.hashtags.filter((tag): tag is string => typeof tag === "string") : [],
    audienceNote: text("audienceNote") ?? undefined,
    sendTimeNote: text("sendTimeNote") ?? undefined,
  };
  return content;
}

export type { ActionExecutionState, CampaignActionChannel };
