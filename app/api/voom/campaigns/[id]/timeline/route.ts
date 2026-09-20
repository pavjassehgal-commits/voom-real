import { getCurrentUser } from "@/lib/voom/server-data";
import { readAutomatedCampaign } from "@/lib/campaign/server";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Campaigns v3 — the unified campaign timeline.
 *
 * ONE request returns ONE campaign's whole chronological timeline across Email
 * and Instagram: what already happened, what is running, what needs approval,
 * what is scheduled and what comes next. Every bucket is DERIVED from the real
 * send/publish state of each action (the email child campaign's delivery rows
 * and the Instagram publish queue), so nothing here can claim a send or a
 * publication that the provider has not confirmed.
 *
 * A client never has to reconstruct the email or Instagram systems to show a
 * campaign. This is the read contract the later experience redesign will use;
 * it adds no new state and no new storage.
 */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id } = await params;
  if (!UUID_RE.test(id)) return Response.json({ error: "That campaign was not found." }, { status: 404 });

  try {
    const db = await createClient();
    const view = await readAutomatedCampaign(db, user.id, id);
    if (!view) return Response.json({ error: "That campaign was not found." }, { status: 404 });

    return Response.json({
      campaign: {
        id: view.campaign.id,
        name: view.campaign.name,
        goal: view.campaign.goal,
        startAt: view.campaign.start_at,
        endAt: view.campaign.end_at,
        channels: view.channels,
        creationMethod: view.creationMethod,
        lifecycle: view.lifecycle,
        lifecycleLabel: view.lifecycleLabel,
        summary: view.campaign.generated_summary,
      },
      strategy: view.strategy,
      timeZone: view.timeZone,
      counts: view.counts,
      timeline: view.timeline,
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "That campaign timeline couldn't load. Please retry." }, { status: 503 });
  }
}
