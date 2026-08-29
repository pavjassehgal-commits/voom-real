import "server-only";

import { executeMaraTool } from "@/lib/mara/tools";
import type { MarketingPlan } from "@/lib/mara/planning";
import type { ServerSupabase } from "@/lib/mara/internal-data";
import type { BusinessRecord, ProfileRecord } from "@/lib/voom/types";

const WORKFLOW_TITLE = "Voom planning workflow";

export async function prepareInstagramPlanWorkflow(db: ServerSupabase, ownerId: string, planId: string, plan: MarketingPlan) {
  const posts = plan.plannedPosts.filter((item) => item.channel.toLowerCase() === "instagram");
  if (posts.length !== 3) throw new Error("instagram_recommendations_missing");

  const [{ data: profile }, { data: business }] = await Promise.all([
    db.from("profiles").select("*").eq("user_id", ownerId).maybeSingle(),
    db.from("businesses").select("*").eq("owner_user_id", ownerId).single(),
  ]);
  if (!business) throw new Error("business_not_found");

  let { data: conversation } = await db.from("mara_conversations").select("id")
    .eq("owner_user_id", ownerId).eq("title", WORKFLOW_TITLE).limit(1).maybeSingle();
  if (!conversation) {
    const created = await db.from("mara_conversations").insert({ owner_user_id: ownerId, title: WORKFLOW_TITLE }).select("id").single();
    if (created.error || !created.data) throw new Error("workflow_conversation_failed");
    conversation = created.data;
  }

  const draftRows = posts.map((post, index) => ({
    owner_user_id: ownerId, conversation_id: conversation.id, source_plan_id: planId,
    source_plan_item_key: String(index), kind: post.contentType === "reel" ? "reel" : "instagram_caption",
    channel: post.contentType === "reel" ? "Reel" : "Instagram",
    title: post.title, content: post.content, proposed_publish_at: post.proposedPublishAt, status: "draft",
  }));
  const draftResult = await db.from("mara_drafts").upsert(draftRows, {
    onConflict: "owner_user_id,source_plan_id,source_plan_item_key", ignoreDuplicates: true,
  }).select("id,title,content,proposed_publish_at,status,source_plan_item_key");
  if (draftResult.error || draftResult.data?.length !== 3) {
    const existing = await db.from("mara_drafts").select("id,title,content,proposed_publish_at,status,source_plan_item_key")
      .eq("owner_user_id", ownerId).eq("source_plan_id", planId).order("source_plan_item_key");
    if (existing.error || existing.data?.length !== 3) throw new Error("workflow_drafts_failed");
    draftResult.data = existing.data;
  }
  const draftsByKey = new Map(draftResult.data.map((draft) => [draft.source_plan_item_key, draft]));

  const actions = await Promise.all(posts.map((post, index) => {
    const draft = draftsByKey.get(String(index));
    if (!draft) throw new Error("workflow_draft_missing");
    const context = {
      db, ownerId, conversationId: conversation.id,
      profile: profile as ProfileRecord | null, business: business as BusinessRecord,
      requestKey: `marketing-plan:${planId}:item:${index}`,
    };
    if (post.contentType === "reel") {
      return executeMaraTool(context, "choose_reel_production", JSON.stringify({
        draftId: draft.id, concept: post.topic, script: post.script ?? post.content,
        shotInstructions: post.shotInstructions,
      }));
    }
    return executeMaraTool(context, "propose_calendar_item", JSON.stringify({
      title: post.title, channel: "Instagram", content: post.content, topic: post.topic,
      publishAt: post.proposedPublishAt, sourceDraftId: draft.id, reason: post.recommendationReason,
    }));
  }));
  if (actions.some((action) => !action.ok || !action.pendingActionId)) throw new Error("workflow_approvals_failed");

  // Persist any email/SMS planned campaigns as real, editable Voom campaign drafts.
  // Campaigns are never sent: the user reviews and approves them before any provider is connected.
  const campaignIds: string[] = [];
  for (const [index, campaign] of plan.plannedCampaigns.entries()) {
    const kind = campaign.channel.trim().toLowerCase() === "sms" ? "sms" : campaign.channel.trim().toLowerCase() === "email" ? "email" : null;
    if (!kind) continue;
    try {
      const result = await executeMaraTool(
        { db, ownerId, conversationId: conversation.id, profile: profile as ProfileRecord | null, business: business as BusinessRecord, requestKey: `marketing-plan:${planId}:campaign:${index}` },
        "create_campaign_draft",
        JSON.stringify({
          kind,
          name: campaign.name,
          objective: campaign.objective,
          audience: "",
          subject: kind === "email" ? campaign.objective.slice(0, 300) : null,
          previewText: kind === "email" ? "" : null,
          content: campaign.actions.join("\n\n"),
          proposedSendAt: null,
        }),
      );
      const created = result.data && typeof result.data === "object" && "id" in result.data ? String(result.data.id) : null;
      if (result.ok && created) campaignIds.push(created);
    } catch {
      // Campaign draft persistence must never block the plan itself; the Campaigns
      // screen remains the authoritative place to create campaign work manually.
    }
  }
  return { drafts: [...draftsByKey.values()], pendingActionIds: actions.map((action) => action.pendingActionId as string), campaignIds };
}
