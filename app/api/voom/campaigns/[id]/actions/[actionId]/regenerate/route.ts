import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { readAutomatedCampaign, regenerateCampaignAction } from "@/lib/campaign/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * "Regenerate draft with MARA" for ONE campaign action.
 *
 *   - only that action's draft content is replaced — the action is never
 *     duplicated and no other campaign item is touched;
 *   - an action that has already been sent or published is refused;
 *   - no paid image/video is generated: this is a text-only call to the
 *     existing MARA text provider, so it spends no media credits and never
 *     reaches the media providers or the central credit guard;
 *   - the client-minted idempotency key makes a retried click a no-op.
 */
const regenerateSchema = z.object({
  idempotencyKey: z.string().trim().uuid(),
}).strict();

export const runtime = "nodejs";

export async function POST(request: Request, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id, actionId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(actionId)) {
    return Response.json({ error: "That campaign action was not found." }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "That request is not valid." }, { status: 400 });
  }
  const parsed = regenerateSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "That request is not valid." }, { status: 400 });

  try {
    const db = await createClient();
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign regeneration is not fully configured on the server yet." }, { status: 503 });
    }

    const result = await regenerateCampaignAction(db, admin, user.id, id, actionId, {
      idempotencyKey: parsed.data.idempotencyKey,
    });
    if (!result.ok) {
      const message = (result.blockers ?? []).join(" ") || "MARA couldn't rewrite that draft just now.";
      // A locked (sent/published) action is a refusal; an unavailable text
      // provider is a retryable failure. Neither changed any content.
      const status = /already been sent|already published|not found/.test(message) ? 409 : 502;
      return Response.json({ error: message }, { status });
    }

    const automated = await readAutomatedCampaign(db, user.id, id);
    return Response.json({
      message: "MARA rewrote that draft. It needs your approval again — nothing was sent, published or generated.",
      automated,
    });
  } catch {
    return Response.json({ error: "MARA couldn't rewrite that draft. Please retry." }, { status: 503 });
  }
}
