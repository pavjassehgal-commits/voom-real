import { z } from "zod";

import { readEmailFlow } from "@/lib/email-flows/read";
import { rescheduleOverdueRuns } from "@/lib/email-flows/engine";
import { clampWaitMinutes, flowTypePolicy } from "@/lib/email-flows/policy";
import { ensureUnsubscribeFooter } from "@/lib/email-flows/strategy";
import type { EmailFlowStepRecord, EmailFlowType } from "@/lib/email-flows/types";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Status transitions. Activation is always an explicit owner request from this
 * route — there is no automatic path anywhere in the product.
 */
const statusPayload = z.object({
  status: z.enum(["active", "paused", "archived"]),
}).strict();

/**
 * Content edits. An edit writes a NEW revision: contacts already enrolled stay
 * on the revision they joined with, and every stored send keeps the content
 * snapshot taken when it was claimed, so history can never be rewritten.
 */
const editPayload = z.object({
  name: z.string().trim().min(1).max(160).optional(),
  objective: z.string().trim().max(1000).optional(),
  steps: z.array(z.object({
    position: z.number().int().min(0).max(11),
    title: z.string().trim().max(160).optional(),
    purpose: z.string().trim().max(1000).optional(),
    waitMinutes: z.number().int().min(0).max(20160).nullable().optional(),
    subject: z.string().trim().min(1).max(300),
    previewText: z.string().trim().max(500).optional(),
    body: z.string().trim().min(1).max(12000),
    cta: z.string().trim().max(160).optional(),
    ctaUrl: z.string().trim().max(500).nullable().optional(),
  }).strict()).min(1).max(6),
}).strict();

const patchPayload = z.union([statusPayload, editPayload]);

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That flow was not found." }, { status: 404 });

  try {
    const db = await createClient();
    const flow = await readEmailFlow(db, user.id, id);
    if (!flow) return Response.json({ error: "That flow was not found." }, { status: 404 });
    return Response.json({ flow }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "That flow couldn't load. Please retry." }, { status: 503 });
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That flow was not found." }, { status: 404 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That change is not valid." }, { status: 400 }); }
  const parsed = patchPayload.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the flow details before saving." }, { status: 400 });

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return Response.json({ error: "Email automation is not fully configured on the server yet." }, { status: 503 });
  }

  const db = await createClient();

  if ("status" in parsed.data) {
    return changeStatus(db, admin, user.id, id, parsed.data.status);
  }
  return editContent(db, admin, user.id, id, parsed.data);
}

async function changeStatus(
  db: Awaited<ReturnType<typeof createClient>>,
  admin: ReturnType<typeof createAdminClient>,
  ownerId: string,
  flowId: string,
  status: "active" | "paused" | "archived",
) {
  const { data: current, error: readError } = await db.from("voom_email_flows")
    .select("id,status,flow_type")
    .eq("owner_user_id", ownerId)
    .eq("id", flowId)
    .maybeSingle();
  if (readError || !current) return Response.json({ error: "That flow was not found." }, { status: 404 });

  const { data, error } = await admin.rpc("set_email_flow_status", {
    p_owner_user_id: ownerId,
    p_flow_id: flowId,
    p_status: status,
  }).single();

  if (error || !data) {
    const message = String(error?.message ?? "");
    if (/flow_archived/.test(message)) return Response.json({ error: "That flow is archived and can no longer change." }, { status: 409 });
    if (/cannot_revert_to_draft/.test(message)) return Response.json({ error: "A flow cannot go back to draft." }, { status: 409 });
    return Response.json({ error: "Voom couldn't update that flow. Please retry." }, { status: 503 });
  }

  const previous = String((current as { status?: string }).status ?? "");
  let rescheduled = 0;

  // Resuming (or activating after a long pause) must never burst-send an
  // overdue pile: due steps are recalculated into future business-hours windows.
  if (status === "active" && previous !== "active") {
    const result = await rescheduleOverdueRuns(admin, ownerId, flowId).catch(() => ({ rescheduled: 0 }));
    rescheduled = result.rescheduled;
  }

  const message = status === "active"
    ? rescheduled > 0
      ? `Flow activated. ${rescheduled} email${rescheduled === 1 ? " was" : "s were"} already due, so Voom moved ${rescheduled === 1 ? "it" : "them"} into the next business-hours windows instead of sending a burst.`
      : "Flow activated. Eligible contacts now enroll and their steps run on schedule."
    : status === "paused"
      ? "Flow paused. Nothing new will send; contacts already in the flow keep their history and nothing delivered was changed."
      : "Flow archived. Nothing will send, and the history is kept.";

  const flow = await readEmailFlow(db, ownerId, flowId);
  return Response.json({ flow, status, rescheduled, message });
}

async function editContent(
  db: Awaited<ReturnType<typeof createClient>>,
  admin: ReturnType<typeof createAdminClient>,
  ownerId: string,
  flowId: string,
  input: z.infer<typeof editPayload>,
) {
  const { data: flowRow, error: flowError } = await db.from("voom_email_flows")
    .select("id,status,flow_type,current_revision")
    .eq("owner_user_id", ownerId)
    .eq("id", flowId)
    .maybeSingle();
  if (flowError || !flowRow) return Response.json({ error: "That flow was not found." }, { status: 404 });

  const flow = flowRow as unknown as { id: string; status: string; flow_type: EmailFlowType; current_revision: number };
  if (flow.status === "archived") {
    return Response.json({ error: "That flow is archived and can no longer change." }, { status: 409 });
  }

  const policy = flowTypePolicy(flow.flow_type);
  if (input.steps.length < policy.minSteps || input.steps.length > policy.maxSteps) {
    return Response.json({
      error: `A ${flow.flow_type === "welcome" ? "Welcome" : "Re-engagement"} flow has between ${policy.minSteps} and ${policy.maxSteps} emails.`,
    }, { status: 400 });
  }

  const { data: stepRows } = await db.from("voom_email_flow_steps")
    .select("position,title,purpose,wait_minutes,subject,preview_text,body,cta,cta_url")
    .eq("owner_user_id", ownerId)
    .eq("flow_id", flowId)
    .eq("revision", flow.current_revision)
    .order("position", { ascending: true });
  const existing = (stepRows ?? []) as unknown as EmailFlowStepRecord[];
  if (existing.length === 0) {
    return Response.json({ error: "That flow has no stored steps to edit." }, { status: 409 });
  }

  const steps = input.steps.map((edit, index) => {
    const base = existing.find((step) => step.position === edit.position) ?? existing[index];
    const position = base ? base.position : index;
    return {
      title: (edit.title ?? base?.title ?? edit.subject).slice(0, 160),
      purpose: (edit.purpose ?? base?.purpose ?? "").slice(0, 1000),
      // The deterministic timing fence always wins over a proposed delay.
      waitMinutes: clampWaitMinutes(flow.flow_type, edit.waitMinutes ?? base?.wait_minutes ?? 0, position),
      subject: edit.subject.slice(0, 300),
      previewText: (edit.previewText ?? base?.preview_text ?? "").slice(0, 500),
      // The opt-out line is appended deterministically, whoever wrote the body.
      body: ensureUnsubscribeFooter(edit.body, "").slice(0, 12000),
      cta: (edit.cta ?? base?.cta ?? "").slice(0, 160),
      ctaUrl: edit.ctaUrl ?? null,
    };
  });

  const { data, error } = await admin.rpc("revise_email_flow", {
    p_owner_user_id: ownerId,
    p_flow_id: flowId,
    p_patch: {
      name: input.name ?? null,
      objective: input.objective ?? null,
    },
    p_steps: steps,
  }).single();

  if (error || !data) {
    const message = String(error?.message ?? "");
    if (/flow_archived/.test(message)) return Response.json({ error: "That flow is archived and can no longer change." }, { status: 409 });
    if (/invalid_step_(subject|body|wait)/.test(message)) {
      return Response.json({ error: "Check the email subject, body and delay before saving." }, { status: 400 });
    }
    return Response.json({ error: "Voom couldn't save that change. Please retry." }, { status: 503 });
  }

  const updated = await readEmailFlow(db, ownerId, flowId);
  return Response.json({
    flow: updated,
    revision: (data as { current_revision?: number }).current_revision ?? null,
    // Documented behaviour, surfaced to the owner rather than left implicit.
    message: `Saved as revision ${updated?.revision ?? ""}. Contacts already in the flow keep the version they enrolled on; new contacts get this one. Nothing already sent was changed.`,
  });
}
