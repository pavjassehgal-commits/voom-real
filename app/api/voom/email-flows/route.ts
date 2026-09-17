import { z } from "zod";

import { randomUUID } from "node:crypto";
import {
  EmailFlowValidationError,
  createEmailFlow,
  userFlowKey,
} from "@/lib/email-flows/create";
import { listEmailFlows, readEmailFlowSummary } from "@/lib/email-flows/read";
import { EMAIL_FLOW_TYPES, type EmailFlowType } from "@/lib/email-flows/types";
import { flowTypePolicy } from "@/lib/email-flows/policy";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The builder payload. It is deliberately small: the user chooses WHAT to
 * automate and only the controls that genuinely matter. Step counts, delays,
 * consent rules and re-entry behaviour all come from the deterministic policy
 * layer, never from the client.
 */
const createFlowPayload = z.object({
  flowType: z.enum(EMAIL_FLOW_TYPES),
  name: z.string().trim().max(160).optional(),
  audienceId: z.string().trim().regex(UUID_RE).nullable().optional(),
  stepCount: z.number().int().min(1).max(12).nullable().optional(),
  inactivityDays: z.number().int().min(14).max(365).nullable().optional(),
  cooldownDays: z.number().int().min(1).max(365).nullable().optional(),
  /** Client-minted so a double-clicked Create cannot build two flows. */
  idempotencyKey: z.string().trim().min(16).max(200).optional(),
}).strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  try {
    const db = await createClient();
    const [flows, summary] = await Promise.all([
      listEmailFlows(db, user.id),
      readEmailFlowSummary(db, user.id),
    ]);
    return Response.json(
      { flows, summary: summary.summary, schemaReady: summary.available },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Your email automations couldn't load. Please retry." }, { status: 503 });
  }
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That flow is not valid." }, { status: 400 }); }
  const parsed = createFlowPayload.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Check the flow details before creating it." }, { status: 400 });
  }

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return Response.json({ error: "Email automation is not fully configured on the server yet." }, { status: 503 });
  }

  try {
    const db = await createClient();
    const { data: business } = await db.from("businesses")
      .select("automation_level")
      .eq("owner_user_id", user.id)
      .maybeSingle();

    const result = await createEmailFlow(admin, {
      ownerId: user.id,
      flowType: parsed.data.flowType as EmailFlowType,
      name: parsed.data.name ?? null,
      audienceId: parsed.data.audienceId ?? null,
      stepCount: parsed.data.stepCount ?? null,
      inactivityDays: parsed.data.inactivityDays ?? null,
      cooldownDays: parsed.data.cooldownDays ?? null,
      idempotencyKey: parsed.data.idempotencyKey ?? userFlowKey(user.id, parsed.data.flowType, randomUUID()),
      mode: (business as { automation_level?: string | null } | null)?.automation_level,
      // An explicit user creation. The Coordinator has its own path.
      createdBy: "user",
    });

    const policy = flowTypePolicy(result.flowType);
    return Response.json({
      flowId: result.flow.id,
      status: result.status,
      flowType: result.flowType,
      stepCount: result.stepCount,
      generationSource: result.generationSource,
      fallbackPositions: result.fallbackPositions,
      intelligenceReason: result.intelligenceReason,
      strategySummary: result.strategySummary,
      awaitingActivation: result.awaitingActivation,
      // Truthful: a new flow sends nothing until the owner activates it.
      message: result.generationSource === "mara"
        ? `MARA drafted your ${policy.label.toLowerCase()} sequence. Nothing is sent until you activate it.`
        : `Your ${policy.label.toLowerCase()} sequence is ready with Voom's own copy. Nothing is sent until you activate it.`,
    }, { status: 201 });
  } catch (error) {
    if (error instanceof EmailFlowValidationError) {
      const status = error.code === "flow_type_already_exists" ? 409
        : error.code === "audience_not_found" ? 404
          : 400;
      return Response.json({ error: error.message }, { status });
    }
    return Response.json({ error: "Voom couldn't create that flow safely. Nothing was sent." }, { status: 503 });
  }
}
