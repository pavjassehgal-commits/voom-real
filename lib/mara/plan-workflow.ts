import "server-only";

import { executeMaraTool } from "@/lib/mara/tools";
import type { MarketingPlan } from "@/lib/mara/planning";
import type { ServerSupabase } from "@/lib/mara/internal-data";
import type { BusinessRecord, ProfileRecord } from "@/lib/voom/types";

const WORKFLOW_TITLE = "Voom planning workflow";

export async function prepareInstagramPlanWorkflow(db: ServerSupabase, ownerId: string, planId: string, plan: MarketingPlan) {
  const post = plan.plannedPosts.find((item) => item.channel.toLowerCase() === "instagram");
  if (!post) throw new Error("instagram_recommendation_missing");

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

  const draftResult = await db.from("mara_drafts").upsert({
    owner_user_id: ownerId,
    conversation_id: conversation.id,
    source_plan_id: planId,
    kind: "instagram_caption",
    channel: "Instagram",
    title: post.title,
    content: post.content,
    proposed_publish_at: post.proposedPublishAt,
    status: "draft",
  }, { onConflict: "owner_user_id,source_plan_id" }).select("id,title,content,proposed_publish_at,status").single();
  if (draftResult.error || !draftResult.data) throw new Error("workflow_draft_failed");

  const action = await executeMaraTool({
    db,
    ownerId,
    conversationId: conversation.id,
    profile: profile as ProfileRecord | null,
    business: business as BusinessRecord,
    requestKey: `marketing-plan:${planId}`,
  }, "propose_calendar_item", JSON.stringify({
    title: post.title,
    channel: "Instagram",
    content: post.content,
    topic: post.topic,
    publishAt: post.proposedPublishAt,
    sourceDraftId: draftResult.data.id,
    reason: post.recommendationReason,
  }));
  if (!action.ok || !action.pendingActionId) throw new Error("workflow_approval_failed");
  return { draft: draftResult.data, pendingActionId: action.pendingActionId };
}
