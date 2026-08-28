import "server-only";

import { z } from "zod";
import { AiError, createAiProvider } from "@/lib/ai";
import { getBrandProfile, listCalendarItems, listCampaigns } from "@/lib/mara/internal-data";
import { readInstagramConfig } from "@/lib/instagram/config";
import { getInstagramConnection } from "@/lib/instagram/data";
import type { createClient } from "@/utils/supabase/server";

type Db = Awaited<ReturnType<typeof createClient>>;

const plannedPost = z.object({
  title: z.string().min(1).max(160),
  proposedPublishAt: z.string().datetime({ offset: true }),
  channel: z.string().min(1).max(60),
  topic: z.string().min(1).max(300),
  content: z.string().min(1).max(12000),
  recommendationReason: z.string().min(1).max(800),
}).strict();
const plannedCampaign = z.object({
  name: z.string().min(1).max(160), channel: z.string().min(1).max(60),
  objective: z.string().min(1).max(800), schedule: z.string().min(1).max(300),
  actions: z.array(z.string().min(1).max(500)).min(1).max(10),
  recommendationReason: z.string().min(1).max(800),
}).strict();
const recommendation = z.object({
  title: z.string().min(1).max(160), why: z.string().min(1).max(800),
  channel: z.string().min(1).max(60), action: z.string().min(1).max(1000),
  needsApproval: z.boolean(),
}).strict();

export const marketingPlanSchema = z.object({
  businessGoal: z.string().min(1).max(1000),
  weeklyStrategy: z.string().min(1).max(5000),
  selectedChannels: z.array(z.string().min(1).max(60)).max(12),
  contentFrequency: z.string().min(1).max(200),
  plannedPosts: z.array(plannedPost).min(1).max(7),
  plannedCampaigns: z.array(plannedCampaign).max(8),
  recommendations: z.array(recommendation).min(1).max(12),
  validFrom: z.string().date(), validUntil: z.string().date(),
}).strict().refine((plan) => plan.plannedPosts.some((post) => post.channel.toLowerCase() === "instagram"), {
  message: "The MVP plan must contain an Instagram post.", path: ["plannedPosts"],
});

export type MarketingPlan = z.infer<typeof marketingPlanSchema>;

export async function generateMarketingPlan(db: Db, ownerId: string) {
  const now = new Date();
  const horizon = new Date(now.getTime() + 35 * 86400000);
  const [{ data: business }, brand, calendar, campaigns, connection, { data: performance }] = await Promise.all([
    db.from("businesses").select("id").eq("owner_user_id", ownerId).single(),
    getBrandProfile(db, ownerId),
    listCalendarItems(db, ownerId, { start: now.toISOString(), end: horizon.toISOString() }),
    listCampaigns(db, ownerId),
    getInstagramConnection(db, ownerId, Boolean(readInstagramConfig())),
    db.from("instagram_insight_snapshots").select("period_start,period_end,metrics,captured_at").eq("owner_user_id", ownerId).order("captured_at", { ascending: false }).limit(20),
  ]);
  if (!business) throw new Error("business_not_found");

  const safeContext = {
    brand,
    connectedChannels: { selected: brand.preferred_channels, instagram: connection.connected },
    calendar: calendar.slice(0, 20).map((item) => ({ title: item.title, channel: item.channel, topic: item.topic, publishAt: item.publish_at, status: item.status })),
    campaigns: campaigns.slice(0, 10).map((item) => ({ name: item.name, kind: item.kind, objective: item.objective, proposedSendAt: item.proposed_send_at, status: item.status })),
    recentPerformance: (performance ?? []).slice(0, 8),
    currentDate: now.toISOString().slice(0, 10), timezone: "Asia/Dubai",
    safety: "Never claim work is published, sent, deleted, or funded. Recommendations requiring those actions must set needsApproval=true.",
  };
  const provider = createAiProvider();
  const system = `You are Voom's invisible marketing planning engine. Return JSON only: one practical structured plan grounded in the supplied business data. Use exactly this shape and no extra keys:
{"businessGoal":"string","weeklyStrategy":"string","selectedChannels":["string"],"contentFrequency":"string","plannedPosts":[{"title":"string","proposedPublishAt":"ISO 8601 timestamp with explicit offset","channel":"Instagram","topic":"string","content":"complete caption with CTA and hashtags","recommendationReason":"string"}],"plannedCampaigns":[{"name":"string","channel":"string","objective":"string","schedule":"string","actions":["string"],"recommendationReason":"string"}],"recommendations":[{"title":"string","why":"string","channel":"string","action":"string","needsApproval":true}],"validFrom":"YYYY-MM-DD","validUntil":"YYYY-MM-DD"}.
Include at least one Instagram post. plannedCampaigns may be an empty array. Do not write chat, greetings, or claims of completed external actions.`;
  const request = `Create a focused seven-day marketing plan from this sanitized Voom context. Keep the MVP narrow and make the first Instagram recommendation immediately usable as a persisted draft:\n${JSON.stringify(safeContext)}`;
  let plan: MarketingPlan;
  try {
    plan = await structuredPlan(provider, system, request);
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== "malformed_response") throw error;
    plan = await structuredPlan(provider, `${system} Your previous response failed validation. Include every required field exactly, use an offset timestamp such as 2026-09-01T10:00:00+04:00, and return JSON only.`, request);
  }
  return { plan, businessId: business.id, sourceSummary: { calendarItems: calendar.length, campaigns: campaigns.length, performanceItems: (performance ?? []).length, instagramConnected: connection.connected } };
}

function structuredPlan(provider: ReturnType<typeof createAiProvider>, system: string, request: string) {
  return provider.structured({
    messages: [{ role: "system", content: system }, { role: "user", content: request }],
    temperature: 0.2, maxTokens: 2200,
    parse: (value) => marketingPlanSchema.parse(value),
  });
}
