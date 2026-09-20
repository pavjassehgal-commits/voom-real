import { runEmailFlowsFleet, EMAIL_FLOW_CRON_CADENCE_MINUTES } from "@/lib/email-flows/engine";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

export function isAuthorizedEmailFlowCron(request: Request, secret = process.env.CRON_SECRET): boolean {
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

/**
 * The lifecycle email worker.
 *
 * One pass does, for every owner that has at least one ACTIVE email flow:
 *   1. discover contacts that became eligible and enroll them (consent first);
 *   2. execute step runs that are due, re-checking consent immediately before
 *      each send and sending through the existing Resend infrastructure;
 *   3. advance each enrollment to its next safe step, or complete it.
 *
 * Concurrent and repeated invocations are safe by construction: one active
 * enrollment per contact per flow (partial unique index), one run per
 * enrollment step (unique index), and a claim RPC that hands a send to exactly
 * one caller. Nothing here creates a flow, activates a flow, calls Meta,
 * submits media generation or spends a credit.
 *
 * Auth follows the existing worker pattern exactly: a Supabase Cron job calls
 * this route with `Authorization: Bearer <CRON_SECRET>` (secret in Supabase
 * Vault, never in a migration or source file).
 *
 * NOT registered in vercel.json and NOT scheduled by this change. The intended
 * production cadence — every 15 minutes — is configured in Supabase Cron by an
 * operator, exactly like the publishing, media-generation and performance
 * workers. No existing cron cadence is changed here.
 */
export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Email automation is not configured." }, { status: 503 });
  if (!isAuthorizedEmailFlowCron(request, secret)) {
    return Response.json({ error: "Unauthorized." }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const result = await runEmailFlowsFleet(admin);
    return Response.json(
      { ...result, cadenceMinutes: EMAIL_FLOW_CRON_CADENCE_MINUTES },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "Email automation could not complete safely." }, { status: 503 });
  }
}

export const POST = GET;
