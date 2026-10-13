import { getCampaign } from "@/lib/mara/internal-data";
import { readEmailCampaignResults } from "@/lib/voom/email-results-server";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Read-only results for one email campaign: counts of real recorded sends and
 * verified Resend events, plus the account-wide unsubscribe total.
 *
 * Ownership is checked with the signed-in user's own session (RLS) before
 * anything else is read; another business's campaign id returns 404 exactly
 * like a missing one. Nothing is sent, and no provider is contacted.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  try {
    const campaign = await getCampaign(await createClient(), user.id, id);
    if (!campaign) return Response.json({ error: "That campaign was not found." }, { status: 404 });
    if (campaign.kind !== "email") {
      return Response.json({ error: "Results are available for email campaigns." }, { status: 404 });
    }
    const view = await readEmailCampaignResults(createAdminClient(), user.id, id);
    return Response.json(view, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Campaign results are temporarily unavailable." }, { status: 503 });
  }
}
