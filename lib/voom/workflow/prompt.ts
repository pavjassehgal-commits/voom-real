import { z } from "zod";

import { actionChannelLabel, actionChannelFor, type SocialFormat, type SocialMediaChannel } from "@/lib/social/channels";
import { PERFORMANCE_ADVISORY_RULES, compactPlanContext, type PerformancePlanContext } from "@/lib/performance/plan-context";

/**
 * MARA's strict text-only output for one server-assigned social plan slot.
 * Channel and format intentionally do NOT appear in the response schema: they
 * are immutable server-owned inputs, not model-generated fields.
 */

export const plannedContentSchema = z.object({
  concept: z.string().min(1).max(160),
  hook: z.string().max(300).default(""),
  caption: z.string().min(1).max(4000),
  cta: z.string().max(160).default(""),
  hashtags: z.array(z.string().min(1).max(30)).max(15).default([]),
  description: z.string().max(5000).default(""),
  script: z.array(z.string().min(1).max(400)).max(40).default([]),
  visualBrief: z.string().min(1).max(1200),
}).strict();

export type PlannedContent = z.infer<typeof plannedContentSchema>;

export const plannedContentJsonSchema = {
  name: "voom_planned_social_content",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["concept", "hook", "caption", "cta", "hashtags", "description", "script", "visualBrief"],
    properties: {
      concept: { type: "string", minLength: 1, maxLength: 160 },
      hook: { type: "string", maxLength: 300 },
      caption: { type: "string", minLength: 1, maxLength: 4000 },
      cta: { type: "string", maxLength: 160 },
      hashtags: { type: "array", maxItems: 15, items: { type: "string", minLength: 1, maxLength: 30 } },
      description: { type: "string", maxLength: 5000 },
      script: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 400 } },
      visualBrief: { type: "string", minLength: 1, maxLength: 1200 },
    },
  },
} as const;

export const PLANNED_CONTENT_SYSTEM_PROMPT = `You are MARA, Voom's practical AI marketing manager, writing ONE scheduled social item for the authenticated user's own business.

The user payload contains an assignedSocialSlot. Its channel and format were selected by Voom's server and are immutable. Write content for that exact assignment. Never choose, change, clone, or add another platform or format. The output schema has no channel or format field by design.

Return JSON only, with exactly these keys:
{"concept":"string","hook":"string","caption":"string","cta":"string","hashtags":["string"],"description":"string","script":["string"],"visualBrief":"string"}

Platform guidance (follow only the assignedSocialSlot):
- Instagram Post: write a concise native feed caption and one square-image visual brief. Keep description, hook and script empty.
- Instagram Reel: write a distinct opening hook, concise caption, and a practical vertical-video beat list. Keep description empty.
- Instagram Story: write one short on-screen line and a vertical visual brief; hashtags, description, hook and script may be empty.
- TikTok Video: write a strong first-second hook, conversational short-form caption, 3-5 relevant tags, and a beat-by-beat vertical video script. Keep description empty.
- YouTube Short: write a distinct short-form video title/concept, a searchable description, a concise caption, and a vertical script with a clear hook and payoff.
- YouTube Video: write a clear search-friendly concept, a useful 2-4 sentence description, and a real long-form outline/script with an opening, several sections and a close. Do not return a thin two-line outline.

Rules:
- concept: short internal name, max 12 words; for YouTube it is also the upload title and must be 100 characters or fewer.
- hook: one original opening line when the assigned format is video; otherwise an empty string is acceptable.
- caption: native copy for the assigned platform; never paste a different channel's deliverable. TikTok caption, CTA and tags together must stay within 2200 characters.
- cta: one direct call to action when appropriate; do not invent a link.
- hashtags: use only relevant tags and obey the platform guidance; an empty list is acceptable when inappropriate.
- description: YouTube metadata only; do not fabricate chapters or claims.
- script: short-video beat list or a substantial long-form outline, as appropriate; empty for non-video Instagram Posts/Stories.
- visualBrief: production direction suitable for the assigned native format. For videos, describe footage and sound direction; for static content, describe the single visual. No readable text, logos or watermarks.
- Ground everything ONLY in the supplied business context and marketing goal. Never invent prices, discounts, offers, opening hours, links, awards, reviews, guarantees or statistics.
- Never claim the content was generated, scheduled, sent or published. This is a plan for the user's workflow.
- Plain text only. No markdown.

PERFORMANCE EVIDENCE
The payload may carry recentPerformance only for Instagram slots: real measured results from this business's own already-published Instagram content (or null when Voom has not measured enough yet).
${PERFORMANCE_ADVISORY_RULES.map((rule) => `- ${rule}`).join("\n")}
- Performance evidence is advisory and must never override assignedSocialSlot.
- When recentPerformance is null, plan from the supplied brand context, goal and already-planned concepts only.`;

/** Text-only payload for one planned, server-assigned social slot. */
export function buildPlannedContentPayload(input: {
  business: Record<string, unknown>;
  goal: string;
  cadenceLabel: string;
  channel: SocialMediaChannel;
  format: SocialFormat;
  localDate: string;
  localTime: string;
  timezone: string;
  recentConcepts: string[];
  performance?: PerformancePlanContext | null;
}) {
  const actionChannel = actionChannelFor(input.channel, input.format);
  return {
    business: input.business,
    marketingGoal: input.goal.slice(0, 300),
    postingCadence: input.cadenceLabel,
    // MARA sees the immutable assignment as context but cannot return or edit it.
    assignedSocialSlot: {
      channel: input.channel,
      format: input.format,
      label: actionChannelLabel(actionChannel),
    },
    contentType: actionChannel,
    scheduledFor: { date: input.localDate, localTime: input.localTime, timezone: input.timezone },
    alreadyPlannedConcepts: input.recentConcepts.slice(0, 14),
    recentPerformance: input.channel === "instagram" && input.performance
      ? compactPlanContext(input.performance)
      : null,
  };
}
