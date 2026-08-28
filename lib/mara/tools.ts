import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { BusinessRecord, ProfileRecord } from "@/lib/voom/types";
import type { ServerSupabase } from "./internal-data";
import { resolveRelativeDateTime } from "./relative-date";
import { readInstagramConfig } from "@/lib/instagram/config";
import { getInstagramConnection } from "@/lib/instagram/data";
import {
  createCalendarItem, createCampaign, deleteCalendarItem, getBrandProfile, getCalendarItem, getCampaign,
  getDraft, listCalendarItems, listCampaigns, listDrafts, updateCalendarItem, updateCampaign,
} from "./internal-data";

const uuid = z.string().uuid();
const isoDate = z.string().datetime({ offset: true });
const channel = z.enum(["Instagram", "Reel", "Feed", "Email", "SMS"]);
const empty = z.object({}).strict();

const schemas = {
  get_brand_profile: empty,
  list_content_calendar: z.object({ start: isoDate, end: isoDate, channel: channel.optional() }).strict(),
  get_calendar_item: z.object({ itemId: uuid }).strict(),
  list_drafts: z.object({ status: z.enum(["draft", "approved", "rejected"]).optional() }).strict(),
  get_draft: z.object({ draftId: uuid }).strict(),
  list_campaigns: z.object({ kind: z.enum(["email", "sms"]).optional() }).strict(),
  get_campaign: z.object({ campaignId: uuid }).strict(),
  get_connected_channels: empty,
  get_instagram_connection_status: empty,
  get_subscription_and_feature_limits: empty,
  create_content_draft: z.object({ kind: z.enum(["instagram_caption", "reel", "email", "sms", "campaign_plan", "weekly_calendar"]), channel: z.string().min(1).max(60), title: z.string().min(1).max(160), content: z.string().min(1).max(12000), proposedPublishAt: isoDate.nullable().optional() }).strict(),
  update_content_draft: z.object({ draftId: uuid, title: z.string().min(1).max(160).optional(), content: z.string().min(1).max(12000).optional(), proposedPublishAt: isoDate.nullable().optional() }).strict(),
  approve_draft: z.object({ draftId: uuid }).strict(),
  reject_draft: z.object({ draftId: uuid }).strict(),
  propose_calendar_item: z.object({ title: z.string().min(1).max(160), channel, content: z.string().max(12000).default(""), topic: z.string().max(500).default(""), publishAt: isoDate, sourceDraftId: uuid.nullable().optional(), reason: z.string().min(1).max(800).optional() }).strict(),
  update_calendar_item: z.object({ itemId: uuid, title: z.string().min(1).max(160).optional(), channel: channel.optional(), content: z.string().max(12000).optional(), topic: z.string().max(500).optional(), publishAt: isoDate.optional() }).strict(),
  delete_calendar_item: z.object({ itemIds: z.array(uuid).min(1).max(25) }).strict(),
  create_campaign_draft: z.object({ kind: z.enum(["email", "sms"]), name: z.string().min(1).max(160), objective: z.string().max(1000).default(""), audience: z.string().max(1000).default(""), subject: z.string().max(300).nullable().optional(), previewText: z.string().max(500).nullable().optional(), content: z.string().max(12000).default(""), proposedSendAt: isoDate.nullable().optional() }).strict(),
  update_campaign_draft: z.object({ campaignId: uuid, name: z.string().min(1).max(160).optional(), objective: z.string().max(1000).optional(), audience: z.string().max(1000).optional(), subject: z.string().max(300).nullable().optional(), previewText: z.string().max(500).nullable().optional(), content: z.string().max(12000).optional(), proposedSendAt: isoDate.nullable().optional() }).strict(),
} satisfies Record<string, z.ZodType>;

export type MaraToolName = keyof typeof schemas;

const descriptions: Record<MaraToolName, string> = {
  get_brand_profile: "Read the authenticated user's saved Voom brand profile.",
  list_content_calendar: "List the authenticated user's real saved calendar items in an ISO date range, optionally filtered by channel.",
  get_calendar_item: "Read one owned calendar item by ID.",
  list_drafts: "List the user's MARA content drafts.", get_draft: "Read one owned content draft.",
  list_campaigns: "List the user's real email or SMS campaign drafts.", get_campaign: "Read one owned campaign draft.",
  get_connected_channels: "Read saved channel preferences and actual integration availability.",
  get_instagram_connection_status: "Check whether real Instagram execution is available.",
  get_subscription_and_feature_limits: "Read the current Voom plan and safe feature limits.",
  create_content_draft: "Create an unscheduled content draft. This never publishes or schedules.",
  update_content_draft: "Update an owned unscheduled content draft.", approve_draft: "Propose approving a draft; requires user confirmation before change.",
  reject_draft: "Reject an owned content draft without publishing.", propose_calendar_item: "Propose a calendar addition; always requires confirmation.",
  update_calendar_item: "Propose changing an owned calendar item; always requires confirmation.",
  delete_calendar_item: "Propose deleting the exact owned calendar items; always requires confirmation.",
  create_campaign_draft: "Create an email or SMS campaign draft only. Never sends it.", update_campaign_draft: "Update an owned campaign draft only. Never sends it.",
};

export const maraToolDefinitions = (Object.keys(schemas) as MaraToolName[]).map((name) => ({
  type: "function" as const,
  function: { name, description: descriptions[name], parameters: z.toJSONSchema(schemas[name], { target: "draft-7" }) },
}));

export interface ToolContext {
  db: ServerSupabase; ownerId: string; conversationId: string;
  profile: ProfileRecord | null; business: BusinessRecord;
  requestKey?: string;
  userRequest?: string;
}

export interface MaraToolExecutionResult { ok: boolean; status?: string; summary: string; data?: unknown; pendingActionId?: string | null; runId?: string | null }

export async function executeMaraTool(context: ToolContext, nameValue: string, rawArguments: string): Promise<MaraToolExecutionResult> {
  if (!(nameValue in schemas)) return rejectedTool(context);
  const name = nameValue as MaraToolName;
  let parsedJson: unknown;
  try { parsedJson = rawArguments ? JSON.parse(rawArguments) : {}; } catch { return failedTool(context, name, {}, "invalid_arguments"); }
  if (name === "propose_calendar_item" && parsedJson && typeof parsedJson === "object" && context.userRequest) {
    const resolved = resolveRelativeDateTime(context.userRequest);
    if (resolved) (parsedJson as Record<string, unknown>).publishAt = resolved;
  }
  const parsed = schemas[name].safeParse(parsedJson);
  if (!parsed.success) return failedTool(context, name, {}, "invalid_arguments");
  const args = parsed.data as Record<string, unknown>;
  const mutation = !name.startsWith("get_") && !name.startsWith("list_");
  const key = mutation ? idempotencyKey(context, name, args) : null;

  if (key) {
    const { data: prior } = await context.db.from("mara_tool_runs").select("status,result_summary,pending_action_id")
      .eq("owner_user_id", context.ownerId).eq("idempotency_key", key).maybeSingle();
    if (prior) return { ok: true, status: prior.status, summary: prior.result_summary ?? "This exact request was already handled.", pendingActionId: prior.pending_action_id };
  }

  const { data: run, error: runError } = await context.db.from("mara_tool_runs").insert({ owner_user_id: context.ownerId, conversation_id: context.conversationId, tool_name: name, sanitized_arguments: args, status: "started", idempotency_key: key }).select("id").single();
  if (runError) return { ok: false, summary: "Voom could not safely start that action." };
  try {
    const result = await runTool(context, name, args, key);
    await context.db.from("mara_tool_runs").update({ status: result.status, result_summary: result.summary.slice(0, 1000), pending_action_id: result.pendingActionId ?? null, completed_at: new Date().toISOString() }).eq("id", run.id).eq("owner_user_id", context.ownerId);
    return { ...result, runId: run.id };
  } catch {
    await context.db.from("mara_tool_runs").update({ status: "failed", error_summary: "The Voom operation failed safely.", completed_at: new Date().toISOString() }).eq("id", run.id).eq("owner_user_id", context.ownerId);
    return { ok: false, status: "failed", summary: "Voom could not complete that operation. Nothing unsafe was changed." };
  }
}

async function runTool(c: ToolContext, name: MaraToolName, a: Record<string, unknown>, key: string | null): Promise<{ ok: boolean; status: string; summary: string; data?: unknown; pendingActionId?: string }> {
  if (name === "get_brand_profile") return success(await getBrandProfile(c.db, c.ownerId), "Loaded the saved brand profile.");
  if (name === "list_content_calendar") { const data = await listCalendarItems(c.db, c.ownerId, a as { start: string; end: string; channel?: string }); return success(data, `Found ${data.length} saved calendar item${data.length === 1 ? "" : "s"}.`); }
  if (name === "get_calendar_item") { const data = await getCalendarItem(c.db, c.ownerId, a.itemId as string); return success(data, data ? "Loaded the calendar item." : "That calendar item was not found."); }
  if (name === "list_drafts") { const data = await listDrafts(c.db, c.ownerId, a.status as string | undefined); return success(data, `Found ${data.length} draft${data.length === 1 ? "" : "s"}.`); }
  if (name === "get_draft") { const data = await getDraft(c.db, c.ownerId, a.draftId as string); return success(data, data ? "Loaded the draft." : "That draft was not found."); }
  if (name === "list_campaigns") { const data = await listCampaigns(c.db, c.ownerId, a.kind as string | undefined); return success(data, `Found ${data.length} campaign draft${data.length === 1 ? "" : "s"}.`); }
  if (name === "get_campaign") { const data = await getCampaign(c.db, c.ownerId, a.campaignId as string); return success(data, data ? "Loaded the campaign draft." : "That campaign was not found."); }
  if (name === "get_connected_channels") {
    const instagram = await getInstagramConnection(c.db, c.ownerId, Boolean(readInstagramConfig()));
    return success({ selectedChannels: c.business.preferred_channels, integrations: { instagram: instagram.connected, email: false, sms: false }, note: instagram.connected ? "Instagram is connected. Publishing still requires the separate confirmed execution flow." : "Instagram is not connected." }, "Checked channel availability.");
  }
  if (name === "get_instagram_connection_status") {
    const instagram = await getInstagramConnection(c.db, c.ownerId, Boolean(readInstagramConfig()));
    return success({ connected: instagram.connected, configured: instagram.configured, username: instagram.username, accountType: instagram.accountType, publishingAvailable: false, reason: instagram.connected ? "The account is connected, but publishing remains unavailable until the confirmed execution flow is implemented and approved." : "Instagram is not connected." }, instagram.connected ? "Checked the Instagram connection." : "Instagram publishing is unavailable.");
  }
  if (name === "get_subscription_and_feature_limits") return success({ plan: "free", maraMessagesPerMinute: 12, publishingAvailable: false, sendingAvailable: false, adSpendAvailable: false }, "Loaded the current feature limits.");
  if (name === "create_content_draft") {
    const { data, error } = await c.db.from("mara_drafts").insert({ owner_user_id: c.ownerId, conversation_id: c.conversationId, kind: a.kind, channel: a.channel, title: a.title, content: a.content, proposed_publish_at: a.proposedPublishAt ?? null }).select("id,title,status").single();
    if (error) throw new Error("draft_create_failed"); return success(data, `Created unscheduled draft “${data.title}” (${data.id}).`);
  }
  if (name === "update_content_draft") { const draftId = a.draftId as string; const patch = compact({ title: a.title, content: a.content, proposed_publish_at: a.proposedPublishAt }); const { data, error } = await c.db.from("mara_drafts").update(patch).eq("owner_user_id", c.ownerId).eq("id", draftId).select("id,title,status").maybeSingle(); if (error) throw new Error("draft_update_failed"); return success(data, data ? `Updated draft “${data.title}”.` : "That draft was not found."); }
  if (name === "reject_draft") { const { data, error } = await c.db.from("mara_drafts").update({ status: "rejected" }).eq("owner_user_id", c.ownerId).eq("id", a.draftId as string).select("id,title,status").maybeSingle(); if (error) throw new Error("draft_reject_failed"); return success(data, data ? `Rejected draft “${data.title}”. Nothing was published.` : "That draft was not found."); }
  if (name === "create_campaign_draft") { const data = await createCampaign(c.db, c.ownerId, campaignPatch(a)); return success(data, `Created email/SMS campaign draft “${data.name}” (${data.id}). It was not sent.`); }
  if (name === "update_campaign_draft") { const data = await updateCampaign(c.db, c.ownerId, a.campaignId as string, campaignPatch(a)); return success(data, data ? `Updated campaign draft “${data.name}”. It was not sent.` : "That campaign was not found."); }

  if (name === "approve_draft") {
    const old = await getDraft(c.db, c.ownerId, a.draftId as string); if (!old) return success(null, "That draft was not found.");
    return pending(c, name, a, key!, `Approve draft “${old.title}”. This saves approval only and does not publish.`, { status: old.status }, { status: "approved", draftId: old.id });
  }
  if (name === "propose_calendar_item") return pending(c, name, a, key!, `Add “${a.title}” to the ${a.channel} calendar for ${new Date(a.publishAt as string).toLocaleString("en-US", { timeZone: "Asia/Dubai" })}.`, null, a);
  if (name === "update_calendar_item") { const old = await getCalendarItem(c.db, c.ownerId, a.itemId as string); if (!old) return success(null, "That calendar item was not found."); const resolved = c.userRequest ? resolveRelativeDateTime(c.userRequest, old.publish_at) : null; const nextArgs = resolved ? { ...a, publishAt: resolved } : a; return pending(c, name, nextArgs, key!, `Update calendar item “${old.title}”.`, old, { ...old, ...nextArgs }); }
  if (name === "delete_calendar_item") { const items = (await Promise.all((a.itemIds as string[]).map((id) => getCalendarItem(c.db, c.ownerId, id)))).filter(Boolean); if (!items.length) return success([], "No owned calendar items matched."); return pending(c, name, { itemIds: items.map((item) => item!.id) }, key!, `Delete ${items.length} calendar item${items.length === 1 ? "" : "s"}: ${items.map((item) => `“${item!.title}”`).join(", ")}.`, { items }, { deleted: items.map((item) => item!.id) }); }
  throw new Error("not_allowlisted");
}

async function pending(c: ToolContext, name: MaraToolName, args: Record<string, unknown>, key: string, summary: string, oldValue: unknown, newValue: unknown) {
  const { data, error } = await c.db.from("mara_pending_actions").insert({ owner_user_id: c.ownerId, conversation_id: c.conversationId, tool_name: name, sanitized_arguments: args, summary, old_value: oldValue, new_value: newValue, idempotency_key: key }).select("id").single();
  if (error) throw new Error("pending_create_failed");
  return { ok: true, status: "pending_confirmation", summary: `${summary} Waiting for the user to confirm.`, pendingActionId: data.id };
}

export async function executeConfirmedAction(c: Omit<ToolContext, "profile" | "business">, action: { id: string; tool_name: string; sanitized_arguments: Record<string, unknown>; status: string }) {
  if (action.status !== "executing") return { ok: true, summary: "This action was already handled." };
  const a = action.sanitized_arguments;
  let result: unknown; let summary: string;
  if (action.tool_name === "approve_draft") { const { data, error } = await c.db.from("mara_drafts").update({ status: "approved" }).eq("owner_user_id", c.ownerId).eq("id", a.draftId as string).select("id,title").maybeSingle(); if (error || !data) throw new Error("approval_failed"); result = data; summary = `Approved “${data.title}”. Nothing was published.`; }
  else if (action.tool_name === "propose_calendar_item") {
    result = await createCalendarItem(c.db, c.ownerId, { title: a.title, channel: a.channel, content: a.content, topic: a.topic, publish_at: a.publishAt, status: "approved", source_draft_id: a.sourceDraftId ?? null });
    if (a.sourceDraftId) {
      const { data: draft, error } = await c.db.from("mara_drafts").update({ status: "approved" }).eq("owner_user_id", c.ownerId).eq("id", a.sourceDraftId as string).select("id").maybeSingle();
      if (error || !draft) throw new Error("draft_approval_failed");
    }
    summary = `Approved “${(result as { title: string }).title}” and added it to the Voom calendar. Nothing was published.`;
  }
  else if (action.tool_name === "update_calendar_item") { const id = a.itemId as string; result = await updateCalendarItem(c.db, c.ownerId, id, compact({ title: a.title, channel: a.channel, content: a.content, topic: a.topic, publish_at: a.publishAt })); if (!result) throw new Error("item_missing"); summary = `Updated “${(result as { title: string }).title}” on the calendar.`; }
  else if (action.tool_name === "delete_calendar_item") { const deleted = []; for (const id of a.itemIds as string[]) { const item = await deleteCalendarItem(c.db, c.ownerId, id); if (item) deleted.push(item); } result = deleted; summary = `Deleted ${deleted.length} calendar item${deleted.length === 1 ? "" : "s"}.`; }
  else throw new Error("action_not_confirmable");
  const { data: completed, error: completionError } = await c.db.from("mara_pending_actions").update({ status: "confirmed", result_summary: summary, executed_at: new Date().toISOString() }).eq("id", action.id).eq("owner_user_id", c.ownerId).eq("status", "executing").select("id").maybeSingle();
  if (completionError || !completed) throw new Error("action_completion_failed");
  return { ok: true, summary, result };
}

function campaignPatch(a: Record<string, unknown>) { return compact({ kind: a.kind, name: a.name, objective: a.objective, audience: a.audience, subject: a.subject, preview_text: a.previewText, content: a.content, proposed_send_at: a.proposedSendAt }); }
function compact(value: Record<string, unknown>) { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined)); }
function success(data: unknown, summary: string) { return { ok: true, status: "succeeded", summary, data }; }
function idempotencyKey(c: ToolContext, name: string, args: unknown) { return createHash("sha256").update(`${c.ownerId}:${c.conversationId}:${c.requestKey ?? "legacy"}:${name}:${stable(idempotencyArgs(name, args))}`).digest("hex"); }
function idempotencyArgs(name: string, args: unknown) { if (!args || typeof args !== "object") return args; const value = args as Record<string, unknown>; if (name === "propose_calendar_item") return { channel: value.channel, publishAt: value.publishAt }; if (name === "approve_draft" || name === "reject_draft" || name === "update_content_draft") return { draftId: value.draftId }; if (name === "update_calendar_item") return { itemId: value.itemId, publishAt: value.publishAt }; if (name === "delete_calendar_item") return { itemIds: Array.isArray(value.itemIds) ? [...value.itemIds].sort() : value.itemIds }; return args; }
function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`).join(",")}}`; return JSON.stringify(value); }
async function rejectedTool(c: ToolContext) { await c.db.from("mara_tool_runs").insert({ owner_user_id: c.ownerId, conversation_id: c.conversationId, tool_name: "rejected_unknown_tool", sanitized_arguments: {}, status: "rejected", error_summary: "A non-allowlisted tool was rejected.", completed_at: new Date().toISOString() }); return { ok: false, status: "rejected", summary: `The requested operation is not available in Voom.` }; }
async function failedTool(c: ToolContext, toolName: string, args: object, code: string) { await c.db.from("mara_tool_runs").insert({ owner_user_id: c.ownerId, conversation_id: c.conversationId, tool_name: toolName, sanitized_arguments: args, status: "failed", error_summary: code, completed_at: new Date().toISOString() }); return { ok: false, status: "failed", summary: "Voom rejected invalid tool arguments. Nothing changed." }; }
