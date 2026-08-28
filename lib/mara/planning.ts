import "server-only";

import { z } from "zod";
import { createAiProvider } from "@/lib/ai";
import { getBrandProfile, listCalendarItems, listCampaigns } from "@/lib/mara/internal-data";
import { readInstagramConfig } from "@/lib/instagram/config";
import { getInstagramConnection } from "@/lib/instagram/data";
import type { createClient } from "@/utils/supabase/server";

type Db = Awaited<ReturnType<typeof createClient>>;

const plannedPost = z.object({
  date: z.string().min(10).max(40), channel: z.string().min(1).max(60),
  topic: z.string().min(1).max(300), contentIdea: z.string().min(1).max(1500),
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
  plannedPosts: z.array(plannedPost).max(21),
  plannedCampaigns: z.array(plannedCampaign).max(8),
  recommendations: z.array(recommendation).min(1).max(12),
  validFrom: z.string().date(), validUntil: z.string().date(),
}).strict();

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
    calendar, campaigns,
    recentPerformance: performance ?? [],
    currentDate: now.toISOString().slice(0, 10), timezone: "Asia/Dubai",
    safety: "Never claim work is published, sent, deleted, or funded. Recommendations requiring those actions must set needsApproval=true.",
  };
  const provider = createAiProvider();
  const plan = await provider.structured({
    messages: [
      { role: "system", content: "You are Voom's invisible marketing planning engine. Return only a practical structured plan grounded in the supplied business data. Do not write chat, greetings, or claims of completed external actions." },
      { role: "user", content: `Create a focused seven-day marketing plan from this sanitized Voom context:\n${JSON.stringify(safeContext)}` },
    ],
    temperature: 0.25, maxTokens: 4000,
    parse: (value) => marketingPlanSchema.parse(value),
  });
  return { plan, businessId: business.id, sourceSummary: { calendarItems: calendar.length, campaigns: campaigns.length, performanceItems: (performance ?? []).length, instagramConnected: connection.connected } };
}
