import "server-only";
import { z } from "zod";

export const LINKEDIN_STATE_COOKIE = "voom_linkedin_oauth_state";
export const UUID = z.string().uuid();
export function sameOrigin(request: Request): boolean {
  return request.headers.get("origin") === new URL(request.url).origin;
}
export function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
export const draftInput = z.object({ id: UUID, text: z.string().trim().min(1).max(3000) }).strict();
export const oneShotInput = z.object({
  queueId: UUID, version: z.number().int().positive().safe(), connectionId: UUID,
  memberSub: z.string().min(1).max(200), confirmed: z.literal(true), visibility: z.literal("PUBLIC"),
}).strict();
export const draftChange = z.discriminatedUnion("action", [
  z.object({ action: z.enum(["save","reject"]), version: z.number().int().positive().safe(),
    text: z.string().trim().min(1).max(3000), scheduledAt: z.string().datetime({offset:true}).nullable() }).strict(),
  z.object({ action: z.literal("approve"), version: z.number().int().positive().safe(), confirmed: z.literal(true),
    connectionId: UUID, memberSub: z.string().min(1).max(200), scheduledAt: z.string().datetime({offset:true}).nullable() }).strict(),
]);
export const LINKEDIN_MESSAGES: Record<string,string> = {
  invalid_state: "This connection request expired or was already used. Start Connect LinkedIn again.",
  cancelled: "LinkedIn authorization was cancelled. Nothing was connected.",
  linkedin_already_linked: "This LinkedIn profile is connected to another VOOM account. Disconnect it there before reconnecting here.",
  linkedin_save_failed: "The LinkedIn connection could not be saved. No other account was changed.",
  linkedin_draft_changed: "This draft changed. Refresh it and review the latest text before approving.",
  linkedin_provider_owned: "This post is claimed, submitted, published or awaiting verification. It cannot safely be edited or retried.",
  linkedin_reconnect: "Reconnect LinkedIn before approving this post.",
  linkedin_schedule_invalid: "Choose a future date, or select Post now.",
  reconnect: "LinkedIn authorization expired or is unavailable. Reconnect and explicitly approve again.",
  rate_limited: "LinkedIn rate-limited this request. A bounded retry is scheduled, unless the attempt limit was reached.",
  rejected: "LinkedIn rejected this post. Review its text and connection before approving again.",
  uncertain: "LinkedIn may have received this post. Check your LinkedIn profile before taking further action; VOOM will not resend it automatically.",
  unavailable: "The connection could not be checked. A bounded pre-submission retry is scheduled.",
  submission_unconfirmed: "The submission result is unknown. Check LinkedIn; VOOM will not resend automatically.",
  approval_changed: "Approval no longer covers this draft. Review it and approve again.",
  disconnected: "The LinkedIn connection was disconnected. This unsubmitted job was cancelled.",
};
