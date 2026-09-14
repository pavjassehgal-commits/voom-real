// SMS was removed from the active Voom product and is intentionally absent
// here: MARA can no longer produce SMS drafts. ("sms" still exists in the DB
// constraint so historical SMS rows keep loading.)
export const DRAFT_KINDS = ["instagram_caption", "instagram_post", "story", "reel", "email", "campaign_plan", "weekly_calendar"] as const;
export type MaraDraftKind = (typeof DRAFT_KINDS)[number];
export type MaraDraftStatus = "draft" | "approved" | "rejected";

export interface MaraDraftInput {
  kind: MaraDraftKind;
  channel: string;
  title: string;
  content: string;
  proposedPublishAt: string | null;
}

export interface MaraAiResult {
  response: string;
  draft: MaraDraftInput | null;
}

export interface MaraMessageRecord {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  created_at: string;
}

export interface MaraDraftRecord {
  id: string;
  conversation_id: string;
  message_id: string | null;
  kind: MaraDraftKind;
  channel: string;
  title: string;
  content: string;
  proposed_publish_at: string | null;
  status: MaraDraftStatus;
  created_at: string;
  updated_at: string;
}
