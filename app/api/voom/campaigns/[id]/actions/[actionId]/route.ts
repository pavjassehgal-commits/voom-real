import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import { decideCampaignAction, readAutomatedCampaign } from "@/lib/campaign/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Approving/rejecting a timeline action changes approval STATE only. It never
// sends an email and never publishes to Instagram.
const decisionSchema = z.object({ action: z.enum(["approve", "reject"]) }).strict();

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
    return Response.json({ error: "Choose approve or reject." }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Choose approve or reject." }, { status: 400 });

  try {
    const db = await createClient();
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign approvals are not fully configured on the server yet." }, { status: 503 });
    }

    const result = await decideCampaignAction(admin, user.id, id, actionId, parsed.data.action);
    if (!result.ok) {
      // e.g. an Instagram action with no visual yet — the existing Post
      // Studio approval gate, surfaced truthfully.
      return Response.json({ error: (result.blockers ?? []).join(" ") || "That action could not be approved." }, { status: 409 });
    }

    const automated = await readAutomatedCampaign(db, user.id, id);
    const message = parsed.data.action === "approve"
      ? "Action approved. Email still needs an explicit send; Instagram still needs a visual and schedule."
      : "Action rejected. Nothing was sent or published.";
    return Response.json({ message, automated });
  } catch {
    return Response.json({ error: "Voom couldn't update that campaign action. Please retry." }, { status: 503 });
  }
}
