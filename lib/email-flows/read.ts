/**
 * Email Automation v2 — the read model.
 *
 * Every number here is counted from real rows. Nothing is estimated, smoothed
 * or invented, and no open/click metric appears anywhere because Voom does not
 * collect one. Destinations are never read: a flow view carries no recipient
 * address, only counts.
 */

import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";

import { accountTimezone } from "@/lib/voom/timezone";
import { getResendAvailability } from "@/lib/email/config";
import {
  EMAIL_FLOW_ACTIVITY_LABELS,
  activityLabel,
  eligibilityReasonLabel,
  flowAttention,
  flowStatusLabel,
  flowTypePolicy,
  reentryPolicyLabel,
  waitLabel,
} from "./policy";
import type {
  EmailFlowCounts,
  EmailFlowEnrollmentRecord,
  EmailFlowRecord,
  EmailFlowStepRecord,
  EmailFlowStepRunRecord,
  EmailFlowSummary,
  EmailFlowView,
} from "./types";

const FLOW_SELECT = "*";
const STEP_SELECT = "id,flow_id,revision,position,step_type,title,purpose,wait_minutes,subject,preview_text,body,cta,cta_url,content_source";

const ACTIVITY_LIMIT = 8;

export interface FlowListOptions {
  /** Include archived flows. Off by default: the UI does not show a graveyard. */
  includeArchived?: boolean;
}

/**
 * The owner's flows, newest first, with real counts and recent activity.
 * Returns an empty list (never a throw) when the 0040 migration is not applied
 * yet, so every screen degrades instead of breaking.
 */
export async function listEmailFlows(
  db: SupabaseClient,
  ownerId: string,
  options: FlowListOptions = {},
): Promise<EmailFlowView[]> {
  let query = db.from("voom_email_flows").select(FLOW_SELECT).eq("owner_user_id", ownerId);
  if (!options.includeArchived) query = query.neq("status", "archived");
  const { data: flowRows, error } = await query.order("created_at", { ascending: false }).limit(50);
  if (error || !flowRows) return [];

  const flows = flowRows as unknown as EmailFlowRecord[];
  if (flows.length === 0) return [];
  const flowIds = flows.map((flow) => flow.id);

  const [stepsResult, audienceResult, enrollmentResult, runResult, eventResult, audienceNameResult] = await Promise.all([
    db.from("voom_email_flow_steps").select(STEP_SELECT).eq("owner_user_id", ownerId).in("flow_id", flowIds),
    Promise.resolve(null),
    db.from("voom_email_flow_enrollments").select("flow_id,status").eq("owner_user_id", ownerId).in("flow_id", flowIds).limit(5000),
    db.from("voom_email_flow_step_runs").select("flow_id,status,scheduled_for").eq("owner_user_id", ownerId).in("flow_id", flowIds).limit(5000),
    db.from("voom_email_flow_events").select("id,flow_id,kind,detail,created_at").eq("owner_user_id", ownerId).in("flow_id", flowIds).order("created_at", { ascending: false }).limit(ACTIVITY_LIMIT * 20),
    loadAudienceNames(db, ownerId, flows),
  ]);
  void audienceResult;

  const stepsByFlow = groupBy((stepsResult.data ?? []) as unknown as EmailFlowStepRecord[], (step) => `${step.flow_id}:${step.revision}`);
  const enrollmentsByFlow = groupBy((enrollmentResult.data ?? []) as unknown as EmailFlowEnrollmentRecord[], (row) => row.flow_id);
  const runsByFlow = groupBy((runResult.data ?? []) as unknown as EmailFlowStepRunRecord[], (row) => row.flow_id);
  const eventsByFlow = groupBy((eventResult.data ?? []) as unknown as Array<{ id: string; flow_id: string; kind: string; detail: Record<string, unknown>; created_at: string }>, (row) => row.flow_id);

  const providerConfigured = getResendAvailability().sendConfigured;

  return flows.map((flow) => {
    const steps = (stepsByFlow.get(`${flow.id}:${flow.current_revision}`) ?? [])
      .slice()
      .sort((a, b) => a.position - b.position);
    const enrollments = enrollmentsByFlow.get(flow.id) ?? [];
    const runs = runsByFlow.get(flow.id) ?? [];
    const events = (eventsByFlow.get(flow.id) ?? []).slice(0, ACTIVITY_LIMIT);

    const counts = countFlow(enrollments, runs);
    const attention = flowAttention({
      status: flow.status,
      createdBy: flow.created_by,
      failedRuns: counts.failed,
      providerConfigured,
    });
    const policy = flowTypePolicy(flow.flow_type);
    const inactivityDays = Number((flow.trigger_config as { inactivityDays?: number } | null)?.inactivityDays ?? policy.defaultInactivityDays ?? 0);
    const audienceName = flow.audience_id ? (audienceNameResult.get(flow.audience_id) ?? null) : null;

    const scheduled = runs
      .filter((run) => run.status === "scheduled")
      .map((run) => run.scheduled_for)
      .filter(Boolean)
      .sort();

    return {
      id: flow.id,
      flowType: flow.flow_type,
      triggerType: flow.trigger_type,
      trigger: { label: policy.triggerLabel, description: policy.triggerDescription },
      name: flow.name,
      objective: flow.objective,
      status: flow.status,
      statusLabel: flowStatusLabel(flow.status),
      audience: flow.audience_id && audienceName ? { id: flow.audience_id, name: audienceName } : null,
      eligibilityNote: eligibilityNote(flow, audienceName, inactivityDays),
      reentry: {
        policy: flow.reentry_policy,
        label: flow.reentry_policy === "cooldown" && flow.cooldown_days
          ? `A contact can re-enter ${flow.cooldown_days} days after finishing the flow.`
          : reentryPolicyLabel(flow.reentry_policy),
      },
      revision: flow.current_revision,
      generationSource: flow.generation_source,
      strategySummary: flow.strategy_summary,
      createdBy: flow.created_by,
      needsAttention: attention.needsAttention,
      attentionReason: attention.reason,
      steps: steps.map((step) => ({
        position: step.position,
        title: step.title,
        purpose: step.purpose,
        waitLabel: waitLabel(step.wait_minutes, step.position),
        waitMinutes: step.wait_minutes,
        subject: step.subject,
        previewText: step.preview_text,
        body: step.body,
        cta: step.cta,
        ctaUrl: step.cta_url,
        contentSource: step.content_source,
      })),
      counts,
      nextScheduledAt: scheduled[0] ?? null,
      recentActivity: events.map((event) => ({
        id: event.id,
        kind: event.kind,
        label: activityLabel(event.kind),
        at: event.created_at,
      })),
      createdAt: flow.created_at,
      activatedAt: flow.activated_at,
      pausedAt: flow.paused_at,
    } satisfies EmailFlowView;
  });
}

/** One flow, or null. Used by the detail API route. */
export async function readEmailFlow(
  db: SupabaseClient,
  ownerId: string,
  flowId: string,
): Promise<EmailFlowView | null> {
  const { data, error } = await db.from("voom_email_flows")
    .select("id")
    .eq("owner_user_id", ownerId)
    .eq("id", flowId)
    .maybeSingle();
  if (error || !data) return null;
  const flows = await listEmailFlows(db, ownerId, { includeArchived: true });
  return flows.find((flow) => flow.id === flowId) ?? null;
}

/**
 * The lifecycle snapshot Today, Automations and the Coordinator all read.
 * `available` is false (rather than an empty list) when 0040 is not applied, so
 * no screen claims "no automations" while the schema is missing.
 */
export async function readEmailFlowSummary(
  db: SupabaseClient,
  ownerId: string,
): Promise<{ available: boolean; summary: EmailFlowSummary }> {
  const empty: EmailFlowSummary = {
    total: 0,
    active: 0,
    paused: 0,
    draft: 0,
    archived: 0,
    enrolledContacts: 0,
    activeEnrollments: 0,
    scheduledRuns: 0,
    needsAttention: 0,
    hasWelcome: false,
    hasReEngagement: false,
    flows: [],
  };

  const { data: flowRows, error } = await db.from("voom_email_flows")
    .select("*")
    .eq("owner_user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) return { available: false, summary: empty };

  const flows = (flowRows ?? []) as unknown as EmailFlowRecord[];
  const live = flows.filter((flow) => flow.status !== "archived");
  if (live.length === 0) {
    return {
      available: true,
      summary: { ...empty, total: flows.length, archived: flows.filter((f) => f.status === "archived").length },
    };
  }

  const flowIds = live.map((flow) => flow.id);
  const [enrollmentResult, runResult] = await Promise.all([
    db.from("voom_email_flow_enrollments").select("flow_id,status,contact_id").eq("owner_user_id", ownerId).in("flow_id", flowIds).limit(5000),
    db.from("voom_email_flow_step_runs").select("flow_id,status,scheduled_for").eq("owner_user_id", ownerId).in("flow_id", flowIds).limit(5000),
  ]);

  const enrollments = (enrollmentResult.data ?? []) as unknown as Array<EmailFlowEnrollmentRecord>;
  const runs = (runResult.data ?? []) as unknown as EmailFlowStepRunRecord[];
  const enrollmentsByFlow = groupBy(enrollments, (row) => row.flow_id);
  const runsByFlow = groupBy(runs, (row) => row.flow_id);
  const providerConfigured = getResendAvailability().sendConfigured;

  const summary: EmailFlowSummary = {
    total: live.length,
    active: live.filter((flow) => flow.status === "active").length,
    paused: live.filter((flow) => flow.status === "paused").length,
    draft: live.filter((flow) => flow.status === "draft").length,
    archived: flows.length - live.length,
    enrolledContacts: new Set(enrollments.map((row) => row.contact_id)).size,
    activeEnrollments: enrollments.filter((row) => row.status === "active").length,
    scheduledRuns: runs.filter((run) => run.status === "scheduled").length,
    needsAttention: 0,
    hasWelcome: live.some((flow) => flow.flow_type === "welcome"),
    hasReEngagement: live.some((flow) => flow.flow_type === "re_engagement"),
    flows: live.map((flow) => {
      const counts = countFlow(enrollmentsByFlow.get(flow.id) ?? [], runsByFlow.get(flow.id) ?? []);
      const attention = flowAttention({
        status: flow.status,
        createdBy: flow.created_by,
        failedRuns: counts.failed,
        providerConfigured,
      });
      const next = (runsByFlow.get(flow.id) ?? [])
        .filter((run) => run.status === "scheduled")
        .map((run) => run.scheduled_for)
        .filter(Boolean)
        .sort()[0] ?? null;
      return {
        id: flow.id,
        name: flow.name,
        flowType: flow.flow_type,
        status: flow.status,
        enrolled: counts.enrolled,
        activeEnrollments: counts.active,
        nextScheduledAt: next,
        needsAttention: attention.needsAttention,
        attentionReason: attention.reason,
        createdBy: flow.created_by,
      };
    }),
  };
  summary.needsAttention = summary.flows.filter((flow) => flow.needsAttention).length;

  return { available: true, summary };
}

/** Recent lifecycle activity across every flow, for Today. Bounded and real. */
export async function readRecentFlowActivity(
  db: SupabaseClient,
  ownerId: string,
  limit = 5,
): Promise<Array<{ id: string; kind: string; label: string; at: string; flowId: string }>> {
  const { data, error } = await db.from("voom_email_flow_events")
    .select("id,flow_id,kind,created_at")
    .eq("owner_user_id", ownerId)
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return (data as unknown as Array<{ id: string; flow_id: string; kind: string; created_at: string }>).map((row) => ({
    id: row.id,
    flowId: row.flow_id,
    kind: row.kind,
    label: EMAIL_FLOW_ACTIVITY_LABELS[row.kind] ?? row.kind,
    at: row.created_at,
  }));
}

/** The business timezone, resolved once per request. */
export async function flowTimeZone(db: SupabaseClient, ownerId: string): Promise<string> {
  const { data } = await db.from("businesses").select("timezone").eq("owner_user_id", ownerId).maybeSingle();
  return accountTimezone((data as { timezone?: string | null } | null)?.timezone);
}

// ─── internals ─────────────────────────────────────────────────────────────

function countFlow(
  enrollments: ReadonlyArray<{ status: string }>,
  runs: ReadonlyArray<{ status: string }>,
): EmailFlowCounts {
  const counts: EmailFlowCounts = {
    enrolled: enrollments.length,
    active: 0,
    completed: 0,
    stopped: 0,
    accepted: 0,
    delivered: 0,
    failed: 0,
    skipped: 0,
    scheduled: 0,
  };
  for (const enrollment of enrollments) {
    if (enrollment.status === "active") counts.active += 1;
    else if (enrollment.status === "completed") counts.completed += 1;
    else if (enrollment.status === "stopped") counts.stopped += 1;
  }
  for (const run of runs) {
    if (run.status === "accepted") counts.accepted += 1;
    else if (run.status === "delivered") counts.delivered += 1;
    else if (run.status === "failed") counts.failed += 1;
    else if (run.status === "skipped") counts.skipped += 1;
    else if (run.status === "scheduled") counts.scheduled += 1;
    else if (run.status === "sending") counts.scheduled += 1;
  }
  return counts;
}

function eligibilityNote(flow: EmailFlowRecord, audienceName: string | null, inactivityDays: number): string {
  const policy = flowTypePolicy(flow.flow_type);
  const scope = audienceName ? `Contacts in “${audienceName}”` : "Subscribed contacts";
  if (flow.flow_type === "re_engagement") {
    return `${scope} Voom has not emailed for ${inactivityDays} days. ${policy.eligibilityNote}`;
  }
  return `${scope} who have not been through this flow. ${policy.eligibilityNote}`;
}

function groupBy<T>(rows: readonly T[], keyOf: (row: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const row of rows) {
    const key = keyOf(row);
    const list = out.get(key) ?? [];
    list.push(row);
    out.set(key, list);
  }
  return out;
}

async function loadAudienceNames(
  db: SupabaseClient,
  ownerId: string,
  flows: readonly EmailFlowRecord[],
): Promise<Map<string, string>> {
  const ids = [...new Set(flows.map((flow) => flow.audience_id).filter((id): id is string => Boolean(id)))];
  if (ids.length === 0) return new Map();
  const { data, error } = await db.from("audiences").select("id,name").eq("owner_id", ownerId).in("id", ids);
  if (error || !data) return new Map();
  return new Map((data as unknown as Array<{ id: string; name: string }>).map((row) => [row.id, row.name]));
}

/** Why a contact was refused, in words the owner can act on. */
export function stopReasonLabel(reason: string | null): string {
  if (!reason) return "Stopped.";
  if (reason === "contact_removed") return "The contact was removed.";
  if (reason === "email_provider_not_configured") return "Resend is not configured on the server.";
  if (reason === "send_failed") return "A send failed after every retry.";
  if (reason === "bounced") return "The provider reported a bounce.";
  if (reason === "complained") return "The recipient reported the email as spam.";
  return eligibilityReasonLabel(reason as never);
}
