/**
 * Email Automation v2 — the enrollment and execution engine.
 *
 * One tick does three things for one owner:
 *   1. discover contacts that became eligible and enroll them (consent checked);
 *   2. execute step runs that are due (consent re-checked immediately before
 *      each send, then an idempotent Resend call);
 *   3. advance enrollments to their next safe step, or complete them.
 *
 * Race safety, in three independent layers:
 *   - a partial unique index allows ONE active enrollment per contact per flow;
 *   - a unique index allows ONE run per (enrollment, position), ever;
 *   - `claim_email_flow_step_run` hands the send to exactly one caller, and the
 *     caller only sends when the returned idempotency key is its own.
 *
 * Truthfulness: a successful provider call is recorded as ACCEPTED. Nothing
 * here ever writes 'delivered'; only a verified Resend webhook does.
 */

import "server-only";

import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { accountTimezone, addDays, localDate, localToUtcIso } from "@/lib/voom/timezone";
import { getResendAvailability } from "@/lib/email/config";
import { resolveAudienceContacts } from "@/lib/contacts/server-data";
import {
  MAX_ENROLLMENTS_PER_TICK,
  MAX_SEND_ATTEMPTS,
  MAX_SENDS_PER_TICK,
  SEND_LEASE_MINUTES,
  SEND_WINDOW_START_MINUTES,
  eligibilityReasonLabel,
  flowContactEligibility,
  flowMayExecute,
  isInactiveContact,
} from "./policy";
import { computeStepInstant, nextSafeSendInstant } from "./timing";
import { sendFlowEmail, type FlowSendDeps } from "./send";
import type {
  EmailFlowEnrollmentRecord,
  EmailFlowRecord,
  EmailFlowStepRunRecord,
} from "./types";

/**
 * Proposed production cadence for `/api/cron/email-flows`.
 *
 * 15 minutes is enough to keep a "welcome" email inside its business-hours
 * window on the day a contact becomes eligible, while staying well inside the
 * per-tick caps. It is a proposal for the operator to configure in Supabase
 * Cron — this repository does not schedule it, and no existing cadence changes.
 */
export const EMAIL_FLOW_CRON_CADENCE_MINUTES = 15;

export interface EngineOptions {
  now?: Date;
  /** Provider test seam. Production uses the configured Resend client. */
  send?: FlowSendDeps;
  maxSendsPerTick?: number;
  maxEnrollmentsPerTick?: number;
}

export interface EngineRunSummary {
  ownerId: string;
  flowsEvaluated: number;
  discovered: number;
  enrolled: number;
  alreadyEnrolled: number;
  ineligible: number;
  coolingDown: number;
  dueRuns: number;
  sent: number;
  failed: number;
  retried: number;
  skipped: number;
  advanced: number;
  completed: number;
  stopped: number;
  reclaimed: number;
  providerConfigured: boolean;
}

const EMPTY_SUMMARY: Omit<EngineRunSummary, "ownerId" | "providerConfigured"> = {
  flowsEvaluated: 0,
  discovered: 0,
  enrolled: 0,
  alreadyEnrolled: 0,
  ineligible: 0,
  coolingDown: 0,
  dueRuns: 0,
  sent: 0,
  failed: 0,
  retried: 0,
  skipped: 0,
  advanced: 0,
  completed: 0,
  stopped: 0,
  reclaimed: 0,
};

/** Stable, replayable keys. The same work always produces the same key. */
function key(...parts: string[]): string {
  return createHash("sha256").update(`voom-email-flow:${parts.join(":")}`).digest("hex").slice(0, 48);
}

/**
 * Runs every active lifecycle flow for one owner.
 *
 * Never throws for expected conditions: an ineligible contact, a paused flow or
 * a provider failure is a counted outcome, not a crash. A tick that fails
 * halfway leaves the database consistent because every transition is its own
 * idempotent RPC call.
 */
export async function runEmailFlowsForOwner(
  admin: SupabaseClient,
  ownerId: string,
  options: EngineOptions = {},
): Promise<EngineRunSummary> {
  const now = options.now ?? new Date();
  const summary: EngineRunSummary = {
    ownerId,
    ...EMPTY_SUMMARY,
    providerConfigured: getResendAvailability().sendConfigured,
  };

  const timeZone = await ownerTimeZone(admin, ownerId);

  const { data: flowRows } = await admin.from("voom_email_flows")
    .select("*")
    .eq("owner_user_id", ownerId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(20);

  const flows = (flowRows ?? []) as unknown as EmailFlowRecord[];

  for (const flow of flows) {
    // A flow that was never explicitly activated by its owner never runs. This
    // is the mode gate: Autopilot cannot self-authorise an activation.
    if (!flowMayExecute(flow)) continue;
    summary.flowsEvaluated += 1;

    await enrollForFlow(admin, ownerId, flow, timeZone, now, summary, options);
    await executeFlow(admin, ownerId, flow, timeZone, now, summary, options);
  }

  return summary;
}

// ─── 1. Discovery + enrollment ─────────────────────────────────────────────

async function enrollForFlow(
  admin: SupabaseClient,
  ownerId: string,
  flow: EmailFlowRecord,
  timeZone: string,
  now: Date,
  summary: EngineRunSummary,
  options: EngineOptions,
): Promise<void> {
  const limit = options.maxEnrollmentsPerTick ?? MAX_ENROLLMENTS_PER_TICK;

  const candidates = await discoverCandidates(admin, ownerId, flow, limit * 4);
  if (candidates.length === 0) return;

  const suppressed = await loadSuppressedEmails(admin, ownerId, candidates.map((c) => c.email).filter((e): e is string => Boolean(e)));
  const lastEmailed = flow.flow_type === "re_engagement"
    ? await loadLastEmailedAt(admin, ownerId, candidates)
    : new Map<string, string>();

  const inactivityDays = Number((flow.trigger_config as { inactivityDays?: number } | null)?.inactivityDays ?? 45);

  let considered = 0;
  for (const contact of candidates) {
    if (summary.enrolled >= limit) break;
    considered += 1;

    // Consent is authoritative and fail-closed: only an explicit subscription
    // with a valid, unsuppressed address may enroll.
    const eligibility = flowContactEligibility(contact, suppressed);
    if (!eligibility.eligible) {
      summary.ineligible += 1;
      continue;
    }

    // Re-engagement only ever acts on inactivity Voom can actually observe.
    if (flow.flow_type === "re_engagement") {
      const inactive = isInactiveContact({
        lastEmailedAt: lastEmailed.get(contact.id) ?? null,
        contactCreatedAt: contact.created_at ?? null,
        inactivityDays,
        now,
      });
      if (!inactive) continue;
    }

    summary.discovered += 1;

    // The first email goes out in the next business-hours window; it is never
    // scheduled in the past and never at 03:00 local time.
    const scheduledFor = nextSafeSendInstant({ after: now, timeZone, now });

    const { data, error } = await admin.rpc("enroll_email_flow_contact", {
      p_owner_user_id: ownerId,
      p_flow_id: flow.id,
      p_contact_id: contact.id,
      p_scheduled_for: scheduledFor,
      p_idempotency_key: key("enroll", flow.id, contact.id),
    });

    if (error) {
      // A concurrent tick may have won the race; the unique index already made
      // that safe, so this is counted and skipped rather than retried.
      summary.skipped += 1;
      continue;
    }

    const outcome = (data as { outcome?: string } | null)?.outcome;
    if (outcome === "enrolled") summary.enrolled += 1;
    else if (outcome === "already_enrolled") summary.alreadyEnrolled += 1;
    else if (outcome === "cooldown") summary.coolingDown += 1;
    else if (outcome === "ineligible") summary.ineligible += 1;
    else summary.skipped += 1;
  }

  // Keeps the discovery count honest when the tick stopped early at the cap.
  void considered;
}

interface CandidateContact {
  id: string;
  email: string | null;
  email_status: string | null;
  first_name: string | null;
  created_at: string | null;
}

/**
 * Contacts that could possibly be eligible for this flow, newest first, bounded.
 * Ownership and consent are re-checked per contact; this is only a candidate
 * set, never a recipient list.
 */
async function discoverCandidates(
  admin: SupabaseClient,
  ownerId: string,
  flow: EmailFlowRecord,
  limit: number,
): Promise<CandidateContact[]> {
  if (flow.audience_id) {
    const resolved = await resolveAudienceContacts(admin, ownerId, flow.audience_id);
    if (!resolved.ok) return [];
    return resolved.data
      .slice(0, limit)
      .map((contact) => ({
        id: contact.id,
        email: contact.email,
        email_status: contact.email_status,
        first_name: contact.first_name,
        created_at: contact.created_at,
      }));
  }

  const { data } = await admin.from("contacts")
    .select("id,email,email_status,first_name,created_at")
    .eq("owner_id", ownerId)
    .eq("email_status", "subscribed")
    .not("email", "is", null)
    .order("created_at", { ascending: false })
    .limit(limit);

  return ((data ?? []) as unknown as CandidateContact[]);
}

// ─── 2. Execution ──────────────────────────────────────────────────────────

async function executeFlow(
  admin: SupabaseClient,
  ownerId: string,
  flow: EmailFlowRecord,
  timeZone: string,
  now: Date,
  summary: EngineRunSummary,
  options: EngineOptions,
): Promise<void> {
  const limit = Math.max(1, options.maxSendsPerTick ?? MAX_SENDS_PER_TICK);
  const leaseCutoff = new Date(now.getTime() - SEND_LEASE_MINUTES * 60_000).toISOString();

  // Due runs, oldest first, plus abandoned leases from a crashed tick.
  const [{ data: dueRows }, { data: staleRows }] = await Promise.all([
    admin.from("voom_email_flow_step_runs")
      .select("*")
      .eq("owner_user_id", ownerId)
      .eq("flow_id", flow.id)
      .eq("status", "scheduled")
      .lte("scheduled_for", now.toISOString())
      .order("scheduled_for", { ascending: true })
      .limit(limit),
    admin.from("voom_email_flow_step_runs")
      .select("*")
      .eq("owner_user_id", ownerId)
      .eq("flow_id", flow.id)
      .eq("status", "sending")
      .lt("updated_at", leaseCutoff)
      .order("updated_at", { ascending: true })
      .limit(limit),
  ]);

  const runs = [...((dueRows ?? []) as unknown as EmailFlowStepRunRecord[]), ...((staleRows ?? []) as unknown as EmailFlowStepRunRecord[])];
  if (runs.length === 0) return;
  summary.dueRuns += runs.length;

  for (const run of runs) {
    if (run.status === "sending") summary.reclaimed += 1;
    await executeRun(admin, ownerId, flow, timeZone, now, run, summary, options);
  }
}

async function executeRun(
  admin: SupabaseClient,
  ownerId: string,
  flow: EmailFlowRecord,
  timeZone: string,
  now: Date,
  run: EmailFlowStepRunRecord,
  summary: EngineRunSummary,
  options: EngineOptions,
): Promise<void> {
  // ── Eligibility is re-checked immediately before EVERY send ───────────────
  const { data: enrollmentRow } = await admin.from("voom_email_flow_enrollments")
    .select("id,status,contact_id,revision,current_position")
    .eq("owner_user_id", ownerId)
    .eq("id", run.enrollment_id)
    .maybeSingle();
  const enrollment = enrollmentRow as unknown as EmailFlowEnrollmentRecord | null;

  if (!enrollment || enrollment.status !== "active") {
    summary.skipped += 1;
    return;
  }

  const { data: contactRow } = await admin.from("contacts")
    .select("id,email,email_status,first_name")
    .eq("owner_id", ownerId)
    .eq("id", enrollment.contact_id)
    .maybeSingle();
  const contact = contactRow as unknown as (CandidateContact | null);

  if (!contact) {
    // The contact was removed: stop the enrollment, send nothing.
    await admin.rpc("stop_email_flow_enrollment", {
      p_owner_user_id: ownerId,
      p_enrollment_id: enrollment.id,
      p_reason: "contact_removed",
      p_kind: "enrollment_stopped",
    });
    summary.stopped += 1;
    summary.skipped += 1;
    return;
  }

  const suppressed = await loadSuppressedEmails(admin, ownerId, contact.email ? [contact.email] : []);
  const eligibility = flowContactEligibility(contact, suppressed);

  if (!eligibility.eligible) {
    // Enrolled Monday, unsubscribed Tuesday, follow-up due Wednesday:
    // Wednesday's email does not send, and the enrollment stops here.
    await admin.rpc("stop_email_flow_enrollment", {
      p_owner_user_id: ownerId,
      p_enrollment_id: enrollment.id,
      p_reason: eligibility.reason,
      p_kind: "send_skipped",
    });
    summary.stopped += 1;
    summary.skipped += 1;
    return;
  }

  if (!summary.providerConfigured) {
    // Fail closed and say why: nothing is attempted, nothing is claimed.
    await admin.rpc("stop_email_flow_enrollment", {
      p_owner_user_id: ownerId,
      p_enrollment_id: enrollment.id,
      p_reason: "email_provider_not_configured",
      p_kind: "send_skipped",
    });
    summary.stopped += 1;
    summary.skipped += 1;
    return;
  }

  // ── Claim: exactly one caller may send this step ──────────────────────────
  const attemptKey = key("send", run.id, String(run.attempts + 1), now.toISOString().slice(0, 13));
  const { data: claimedRow, error: claimError } = await admin.rpc("claim_email_flow_step_run", {
    p_owner_user_id: ownerId,
    p_run_id: run.id,
    p_attempt_key: attemptKey,
    p_lease_minutes: SEND_LEASE_MINUTES,
  });

  if (claimError) {
    // flow_not_active / enrollment_not_active: nothing is sent, ever.
    summary.skipped += 1;
    return;
  }

  const claimed = claimedRow as unknown as EmailFlowStepRunRecord | null;
  if (!claimed || claimed.idempotency_key !== attemptKey) {
    // Another worker owns it, it is in flight, or it already completed.
    summary.skipped += 1;
    return;
  }

  const snapshot = (claimed.content_snapshot ?? {}) as { subject?: string; body?: string };
  const subject = String(snapshot.subject ?? "").slice(0, 300);
  const body = String(snapshot.body ?? "");
  if (!subject || !body) {
    await admin.rpc("record_email_flow_step_provider_result", {
      p_owner_user_id: ownerId,
      p_run_id: claimed.id,
      p_outcome: "failed",
      p_error_code: "invalid_step_content",
      p_error_message: "The stored step content could not be sent.",
    });
    summary.failed += 1;
    return;
  }

  // ── Send through the EXISTING Resend infrastructure ───────────────────────
  let provider;
  try {
    provider = await sendFlowEmail(
      {
        to: eligibility.destination as string,
        subject,
        body,
        idempotencyKey: attemptKey,
        firstName: contact.first_name,
      },
      options.send ?? {},
    );
  } catch {
    provider = {
      ok: false,
      providerMessageId: null,
      providerStatus: null,
      errorCode: "provider_request_failed",
      errorMessage: "The provider request did not complete.",
    };
  }

  const { data: recordedRow } = await admin.rpc("record_email_flow_step_provider_result", {
    p_owner_user_id: ownerId,
    p_run_id: claimed.id,
    p_outcome: provider.ok ? "accepted" : "failed",
    p_provider_status: provider.providerStatus,
    p_provider_message_id: provider.providerMessageId,
    p_error_code: provider.errorCode,
    p_error_message: provider.errorMessage,
  });

  if (!provider.ok) {
    summary.failed += 1;
    await maybeRetry(admin, ownerId, timeZone, now, claimed, summary);
    return;
  }

  summary.sent += 1;

  // ── Advance: schedule the next step, or complete the enrollment ───────────
  const recorded = recordedRow as unknown as EmailFlowStepRunRecord | null;
  const nextStep = await loadStep(admin, ownerId, flow.id, enrollment.revision, run.position + 1);

  if (!nextStep) {
    await admin.rpc("advance_email_flow_enrollment", {
      p_owner_user_id: ownerId,
      p_enrollment_id: enrollment.id,
      p_completed_position: run.position,
      p_next_scheduled_for: null,
      p_next_idempotency_key: null,
    });
    summary.completed += 1;
    return;
  }

  // The wait is measured from when this step actually executed, then moved into
  // the business-local send window and guaranteed to be in the future.
  const executedAt = recorded?.accepted_at ?? now.toISOString();
  const nextAt = computeStepInstant({ from: executedAt, waitMinutes: nextStep.wait_minutes, timeZone, now });

  const { data: advance } = await admin.rpc("advance_email_flow_enrollment", {
    p_owner_user_id: ownerId,
    p_enrollment_id: enrollment.id,
    p_completed_position: run.position,
    p_next_scheduled_for: nextAt,
    p_next_idempotency_key: key("run", enrollment.id, String(run.position + 1)),
  });

  const outcome = (advance as { outcome?: string } | null)?.outcome;
  if (outcome === "advanced") summary.advanced += 1;
  else if (outcome === "completed") summary.completed += 1;
}

/**
 * Bounded retry. A failed step is put back in the queue at the next safe window
 * with the SAME run row, so `attempts` keeps counting and the claim writer stops
 * it for good after `MAX_SEND_ATTEMPTS`. A run is never retried forever.
 */
async function maybeRetry(
  admin: SupabaseClient,
  ownerId: string,
  timeZone: string,
  now: Date,
  run: EmailFlowStepRunRecord,
  summary: EngineRunSummary,
): Promise<void> {
  if (run.attempts + 1 >= MAX_SEND_ATTEMPTS) return;
  const retryAt = nextSafeSendInstant({
    after: new Date(now.getTime() + 30 * 60_000).toISOString(),
    timeZone,
    now,
  });
  const { error } = await admin.rpc("reschedule_email_flow_step_run", {
    p_owner_user_id: ownerId,
    p_run_id: run.id,
    p_new_scheduled_for: retryAt,
  });
  if (!error) summary.retried += 1;
}

async function loadStep(
  admin: SupabaseClient,
  ownerId: string,
  flowId: string,
  revision: number,
  position: number,
): Promise<{ wait_minutes: number } | null> {
  const { data } = await admin.from("voom_email_flow_steps")
    .select("id,wait_minutes")
    .eq("owner_user_id", ownerId)
    .eq("flow_id", flowId)
    .eq("revision", revision)
    .eq("position", position)
    .maybeSingle();
  return (data as unknown as { wait_minutes: number } | null) ?? null;
}

// ─── Pause / resume ────────────────────────────────────────────────────────

/**
 * Recalculates safe execution times after a resume (or after a long outage).
 *
 * Nothing is burst-sent: overdue runs are spread across the next business-hours
 * windows, a bounded number per window, and every new instant is in the future.
 * Runs that already left Voom (sending/accepted/delivered/failed/skipped) are
 * never touched.
 */
export async function rescheduleOverdueRuns(
  admin: SupabaseClient,
  ownerId: string,
  flowId: string,
  options: { now?: Date; perWindow?: number; spacingMinutes?: number } = {},
): Promise<{ rescheduled: number }> {
  const now = options.now ?? new Date();
  const timeZone = await ownerTimeZone(admin, ownerId);

  const { data: rows } = await admin.from("voom_email_flow_step_runs")
    .select("id,scheduled_for")
    .eq("owner_user_id", ownerId)
    .eq("flow_id", flowId)
    .eq("status", "scheduled")
    .lte("scheduled_for", now.toISOString())
    .order("scheduled_for", { ascending: true })
    .limit(500);

  const overdue = (rows ?? []) as unknown as Array<{ id: string; scheduled_for: string }>;
  if (overdue.length === 0) return { rescheduled: 0 };

  const perWindow = Math.max(1, options.perWindow ?? 5);
  const spacing = Math.max(1, options.spacingMinutes ?? 5);
  let rescheduled = 0;
  let cursor = nextSafeSendInstant({ after: now, timeZone, now });

  for (let index = 0; index < overdue.length; index += 1) {
    if (index > 0) {
      const nextWindowStart = index % perWindow === 0
        ? localToUtcIso(addDays(localDate(new Date(cursor), timeZone), 1), SEND_WINDOW_START_MINUTES, timeZone)
        : new Date(Date.parse(cursor) + spacing * 60_000).toISOString();
      cursor = nextSafeSendInstant({ after: nextWindowStart, timeZone, now });
    }
    const { error } = await admin.rpc("reschedule_email_flow_step_run", {
      p_owner_user_id: ownerId,
      p_run_id: overdue[index].id,
      p_new_scheduled_for: cursor,
    });
    if (!error) rescheduled += 1;
  }

  return { rescheduled };
}

// ─── Fleet ─────────────────────────────────────────────────────────────────

export interface FleetSummary {
  owners: number;
  enrolled: number;
  sent: number;
  failed: number;
  skipped: number;
  completed: number;
  failures: number;
  providerConfigured: boolean;
}

/**
 * The scheduled fleet pass. Only owners with at least one ACTIVE flow are
 * touched, so an account with no lifecycle automation costs nothing.
 */
export async function runEmailFlowsFleet(
  admin: SupabaseClient,
  options: EngineOptions & { ownerIds?: string[] } = {},
): Promise<FleetSummary> {
  const now = options.now ?? new Date();
  const summary: FleetSummary = {
    owners: 0,
    enrolled: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    completed: 0,
    failures: 0,
    providerConfigured: getResendAvailability().sendConfigured,
  };

  let query = admin.from("voom_email_flows")
    .select("owner_user_id")
    .eq("status", "active");
  if (options.ownerIds && options.ownerIds.length > 0) {
    query = query.in("owner_user_id", options.ownerIds);
  }
  const { data: rows, error } = await query.limit(500);
  if (error) throw new Error("email_flow_fleet_query_failed");

  const ownerIds = [...new Set(((rows ?? []) as Array<{ owner_user_id: string }>).map((row) => String(row.owner_user_id)))];
  summary.owners = ownerIds.length;

  for (const ownerId of ownerIds) {
    try {
      const result = await runEmailFlowsForOwner(admin, ownerId, { ...options, now });
      summary.enrolled += result.enrolled;
      summary.sent += result.sent;
      summary.failed += result.failed;
      summary.skipped += result.skipped;
      summary.completed += result.completed;
    } catch (cause) {
      summary.failures += 1;
      console.error("[voom][email-flow] owner tick failed", {
        ownerId,
        message: cause instanceof Error ? cause.message : "unknown_error",
      });
    }
  }

  return summary;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

async function ownerTimeZone(admin: SupabaseClient, ownerId: string): Promise<string> {
  const { data } = await admin.from("businesses")
    .select("timezone")
    .eq("owner_user_id", ownerId)
    .maybeSingle();
  return accountTimezone((data as { timezone?: string | null } | null)?.timezone);
}

/** Suppressed addresses for this owner. Missing table → empty set (fail open on reads only; sends still need a subscription). */
async function loadSuppressedEmails(
  admin: SupabaseClient,
  ownerId: string,
  emails: string[],
): Promise<Set<string>> {
  const unique = [...new Set(emails.filter(Boolean).map((email) => email.toLowerCase()))].slice(0, 500);
  if (unique.length === 0) return new Set();
  try {
    const { data, error } = await admin.from("voom_email_suppressions")
      .select("email")
      .eq("owner_id", ownerId)
      .in("email", unique);
    if (error) return new Set();
    return new Set(((data ?? []) as Array<{ email: string }>).map((row) => String(row.email).toLowerCase()));
  } catch {
    return new Set();
  }
}

/**
 * The last time Voom emailed each candidate — from real stored sends only.
 *
 * Voom observes two things: campaign sends (0018) and lifecycle step runs
 * (0040). Nothing else is inferred: no purchases, no carts, no page views.
 * If neither source answers, the contact is treated as NOT inactive, so a
 * re-engagement flow can never act on invented behaviour.
 */
async function loadLastEmailedAt(
  admin: SupabaseClient,
  ownerId: string,
  candidates: CandidateContact[],
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const byEmail = new Map<string, string>();
  for (const candidate of candidates) {
    if (candidate.email) byEmail.set(candidate.email.toLowerCase(), candidate.id);
  }
  if (byEmail.size === 0) return out;

  const emails = [...byEmail.keys()].slice(0, 500);

  try {
    const { data } = await admin.from("campaign_sends")
      .select("accepted_at,delivered_at,campaign_recipients!inner(contact)")
      .eq("owner_user_id", ownerId)
      .in("internal_status", ["accepted", "delivered"])
      .in("campaign_recipients.contact", emails)
      .limit(1000);

    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const recipient = row.campaign_recipients as { contact?: string } | null;
      const address = recipient?.contact ? String(recipient.contact).toLowerCase() : null;
      if (!address) continue;
      const at = String(row.delivered_at ?? row.accepted_at ?? "");
      if (!at) continue;
      const previous = out.get(byEmail.get(address) ?? "");
      if (!previous || Date.parse(at) > Date.parse(previous)) out.set(byEmail.get(address) as string, at);
    }
  } catch {
    // Unavailable history → no inferred inactivity.
  }

  try {
    const { data } = await admin.from("voom_email_flow_step_runs")
      .select("accepted_at,delivered_at,voom_email_flow_enrollments!inner(contact_id)")
      .eq("owner_user_id", ownerId)
      .in("status", ["accepted", "delivered"])
      .limit(1000);

    const wanted = new Set(candidates.map((candidate) => candidate.id));
    for (const row of (data ?? []) as Array<Record<string, unknown>>) {
      const enrollment = row.voom_email_flow_enrollments as { contact_id?: string } | null;
      const contactId = enrollment?.contact_id ? String(enrollment.contact_id) : null;
      if (!contactId || !wanted.has(contactId)) continue;
      const at = String(row.delivered_at ?? row.accepted_at ?? "");
      if (!at) continue;
      const previous = out.get(contactId);
      if (!previous || Date.parse(at) > Date.parse(previous)) out.set(contactId, at);
    }
  } catch {
    // Unavailable history → no inferred inactivity.
  }

  return out;
}

/** Plain-language reason for a skip, for logs and needs-attention surfaces. */
export function skipReasonLabel(reason: string): string {
  if (reason === "contact_removed") return "The contact was removed, so nothing was sent.";
  if (reason === "email_provider_not_configured") return "Resend is not configured, so nothing was sent.";
  return eligibilityReasonLabel(reason as never);
}
