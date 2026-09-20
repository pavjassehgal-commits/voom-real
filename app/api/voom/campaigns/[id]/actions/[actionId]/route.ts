import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";
import {
  chooseCampaignReelProduction,
  decideCampaignAction,
  editCampaignActionContent,
  readAutomatedCampaign,
} from "@/lib/campaign/server";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Approving/rejecting a timeline action changes approval STATE only. It never
// sends an email and never publishes to Instagram.
const decisionSchema = z.object({ action: z.enum(["approve", "reject"]) }).strict();
const productionSchema = z.object({
  action: z.literal("production"),
  method: z.enum(["create_with_mara", "upload_asset", "film_yourself"]),
}).strict();

/**
 * Editing ONE action's draft content before approval. The limits mirror the
 * existing campaign/draft validation (subject 300, preview 500, body 12000,
 * caption 2200). Editing never sends, never publishes and never rebuilds the
 * campaign — the guarded RPC refuses an action that is already sent/published.
 */
const editSchema = z.object({
  purpose: z.string().trim().max(1000).optional(),
  subject: z.string().trim().max(300).optional(),
  previewText: z.string().trim().max(500).optional(),
  body: z.string().trim().max(12000).optional(),
  caption: z.string().trim().max(2200).optional(),
  concept: z.string().trim().max(160).optional(),
  hook: z.string().trim().max(300).optional(),
  visualDirection: z.string().trim().max(1200).optional(),
  // Instagram Reel shot script (≤8×300) and the Multi-Social beat list
  // (≤40×400) share one field; the server validates per channel.
  script: z.array(z.string().trim().max(400)).max(40).optional(),
  format: z.enum(["post", "reel", "story"]).optional(),
  // Multi-Social Core: the YouTube deliverable description.
  description: z.string().trim().max(5000).optional(),
  cta: z.string().trim().max(160).optional(),
  ctaUrl: z.string().trim().max(500).nullable().optional(),
  audienceNote: z.string().trim().max(500).optional(),
  sendTimeNote: z.string().trim().max(300).optional(),
  scheduledFor: z.string().trim().max(40).nullable().optional(),
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
    return Response.json({ error: "Choose approve or reject." }, { status: 400 });
  }
  const parsed = decisionSchema.safeParse(body);
  const productionParsed = productionSchema.safeParse(body);
  if (!parsed.success && !productionParsed.success) return Response.json({ error: "Choose approve, reject, or a Reel production method." }, { status: 400 });

  try {
    const db = await createClient();
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign approvals are not fully configured on the server yet." }, { status: 503 });
    }

    if (productionParsed.success) {
      const result = await chooseCampaignReelProduction(admin, user.id, id, actionId, productionParsed.data.method);
      if (!result.ok) {
        return Response.json({ error: (result.blockers ?? []).join(" ") || "That production method could not be recorded." }, { status: 409 });
      }
      const automated = await readAutomatedCampaign(db, user.id, id);
      return Response.json({
        message: "Production choice saved in this campaign. Nothing has been generated, uploaded, sent, or published.",
        pendingActionId: result.pendingActionId,
        automated,
      });
    }
    if (!parsed.success) return Response.json({ error: "Choose approve or reject." }, { status: 400 });

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

/**
 * Edits ONE action's generated draft. Only that action changes; the campaign is
 * never rebuilt. Nothing is sent or published by this route.
 */
export async function PATCH(request: Request, { params }: { params: Promise<{ id: string; actionId: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  const { id, actionId } = await params;
  if (!UUID_RE.test(id) || !UUID_RE.test(actionId)) {
    return Response.json({ error: "That campaign action was not found." }, { status: 404 });
  }

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: "That edit is not valid." }, { status: 400 });
  }
  const parsed = editSchema.safeParse(body);
  if (!parsed.success || Object.keys(parsed.data).length === 0) {
    return Response.json({ error: "Check the content before saving." }, { status: 400 });
  }

  try {
    const db = await createClient();
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return Response.json({ error: "Campaign editing is not fully configured on the server yet." }, { status: 503 });
    }

    const result = await editCampaignActionContent(admin, user.id, id, actionId, parsed.data);
    if (!result.ok) {
      return Response.json({ error: (result.blockers ?? []).join(" ") || "That draft couldn't be saved." }, { status: 409 });
    }

    const automated = await readAutomatedCampaign(db, user.id, id);
    return Response.json({ message: "Draft saved. Nothing has been sent or published.", automated });
  } catch {
    return Response.json({ error: "Voom couldn't save that draft. Please retry." }, { status: 503 });
  }
}
