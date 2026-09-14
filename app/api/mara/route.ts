import { createAiProvider, AiError, type AiMessage, type AiToolMessage } from "@/lib/ai";
import { buildMaraSystemPrompt, inferRequestedDraftKind } from "@/lib/mara/prompt";
import { parseMaraResult } from "@/lib/mara/result";
import type { MaraAiResult, MaraDraftKind, MaraDraftRecord, MaraMessageRecord } from "@/lib/mara/types";
import type { MaraPendingActionRecord } from "@/lib/mara/tool-types";
import { executeMaraTool, maraToolDefinitions } from "@/lib/mara/tools";
import { inferMediaRequest, MEDIA_SELECT, toMediaView } from "@/lib/media/data";
import { estimateMediaCostUsd } from "@/lib/mara/media-spend";
import type { MediaGenerationRecord } from "@/lib/media/types";
import { getBusinessRecord, getCurrentUser, getProfileRecord } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

const MAX_INPUT_LENGTH = 4000;
const MAX_HISTORY_MESSAGES = 20;
const RATE_LIMIT_PER_MINUTE = 12;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const supabase = await createClient();
  const { data: conversation, error: conversationError } = await supabase
    .from("mara_conversations")
    .select("id,title,created_at,updated_at")
    .eq("owner_user_id", user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (conversationError) return databaseUnavailable();
  if (!conversation) return Response.json({ conversation: null, messages: [], drafts: [] });

  const admin = createAdminClient();
  const [{ data: messages, error: messageError }, { data: drafts, error: draftError }, { data: pendingActions, error: pendingError }, { data: media, error: mediaError }] = await Promise.all([
    supabase
      .from("mara_messages")
      .select("id,conversation_id,role,content,created_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: true }),
    supabase
      .from("mara_drafts")
      .select("id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at")
      .eq("conversation_id", conversation.id)
      .order("created_at", { ascending: false }),
    supabase.from("mara_pending_actions")
      .select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at")
      .eq("conversation_id", conversation.id).order("created_at", { ascending: true }),
    admin.from("mara_media_generations")
      .select(MEDIA_SELECT)
      .eq("owner_user_id", user.id).eq("conversation_id", conversation.id).order("created_at", { ascending: true }),
  ]);

  if (messageError || draftError || pendingError || mediaError) return databaseUnavailable();
  const mediaViews = await Promise.all((media ?? []).map((item) => toMediaView(admin, item as Record<string, unknown>)));
  return Response.json({ conversation, messages: messages ?? [], drafts: drafts ?? [], pendingActions: pendingActions ?? [], media: mediaViews });
}

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const body = await readBody(request);
  if (!body) return Response.json({ error: "That request was not valid." }, { status: 400 });
  const message = typeof body.message === "string" ? body.message.trim() : "";
  const conversationId = typeof body.conversationId === "string" ? body.conversationId : null;
  const requestId = typeof body.requestId === "string" && UUID_RE.test(body.requestId) ? body.requestId : crypto.randomUUID();
  if (!message) return Response.json({ error: "Write a message for MARA first." }, { status: 400 });
  if (message.length > MAX_INPUT_LENGTH) {
    return Response.json({ error: `Keep messages under ${MAX_INPUT_LENGTH.toLocaleString()} characters.` }, { status: 413 });
  }
  if (conversationId && !UUID_RE.test(conversationId)) {
    return Response.json({ error: "That conversation is not valid." }, { status: 400 });
  }

  const [business, profile] = await Promise.all([getBusinessRecord(), getProfileRecord()]);
  if (!business) return Response.json({ error: "Complete your brand profile before using MARA." }, { status: 409 });

  const supabase = await createClient();
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count, error: rateError } = await supabase
    .from("mara_messages")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", user.id)
    .eq("role", "user")
    .gte("created_at", since);
  if (rateError) return databaseUnavailable();
  if ((count ?? 0) >= RATE_LIMIT_PER_MINUTE) {
    return Response.json({ error: "MARA is receiving messages too quickly. Try again in a minute." }, { status: 429 });
  }

  const conversation = await resolveConversation(supabase, user.id, conversationId, message);
  if (!conversation) return databaseUnavailable();

  const { data: userMessage, error: insertError } = await supabase
    .from("mara_messages")
    .insert({ conversation_id: conversation.id, owner_user_id: user.id, role: "user", content: message })
    .select("id,conversation_id,role,content,created_at")
    .single();
  if (insertError) return databaseUnavailable();

  const { data: history, error: historyError } = await supabase
    .from("mara_messages")
    .select("role,content")
    .eq("conversation_id", conversation.id)
    .order("created_at", { ascending: false })
    .limit(MAX_HISTORY_MESSAGES);
  if (historyError) return databaseUnavailable();

  const aiMessages: AiMessage[] = [
    { role: "system", content: buildMaraSystemPrompt(profile, business) },
    ...(history ?? []).reverse().map((item) => ({ role: item.role as "user" | "assistant", content: item.content })),
  ];
  const expectedDraftKind = inferRequestedDraftKind(message);
  const mediaRequest = inferMediaRequest(message);
  if (mediaRequest) {
    const result = await createMediaRequest({ userId: user.id, conversationId: conversation.id, requestId, message, mediaRequest, business });
    if (result instanceof Response) return result;
    await supabase.from("mara_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
    return streamResult(conversation.id, userMessage as MaraMessageRecord, result.assistantMessage, null, [], result.media);
  }
  const operational = shouldUseTools(message, expectedDraftKind);
  if (expectedDraftKind && !operational) {
    aiMessages.push({
      role: "system",
      content: `This is a content-creation request. Return a non-null draft with kind exactly "${expectedDraftKind}" and put the complete deliverable in draft.content.`,
    });
  }

  try {
    const toolResult = operational ? await runToolLoop({
      messages: aiMessages,
      db: supabase,
      ownerId: user.id,
      conversationId: conversation.id,
      profile,
      business,
      requestId,
      userRequest: message,
    }) : null;
    const result = toolResult ? { response: toolResult.response, draft: null } : await generateMaraResult(aiMessages, expectedDraftKind);
    const { data: assistantMessage, error: assistantError } = await supabase
      .from("mara_messages")
      .insert({ conversation_id: conversation.id, owner_user_id: user.id, role: "assistant", content: result.response })
      .select("id,conversation_id,role,content,created_at")
      .single();
    if (assistantError) return databaseUnavailable();

    if (toolResult) {
      const updates = [];
      if (toolResult.pendingActionIds.length) updates.push(supabase.from("mara_pending_actions").update({ message_id: assistantMessage.id }).eq("owner_user_id", user.id).in("id", toolResult.pendingActionIds));
      if (toolResult.runIds.length) updates.push(supabase.from("mara_tool_runs").update({ message_id: assistantMessage.id }).eq("owner_user_id", user.id).in("id", toolResult.runIds));
      await Promise.all(updates);
    }

    let draft: MaraDraftRecord | null = null;
    if (result.draft) {
      const { data, error } = await supabase
        .from("mara_drafts")
        .insert({
          conversation_id: conversation.id,
          message_id: assistantMessage.id,
          owner_user_id: user.id,
          kind: result.draft.kind,
          channel: result.draft.channel,
          title: result.draft.title,
          content: result.draft.content,
          proposed_publish_at: result.draft.proposedPublishAt,
        })
        .select("id,conversation_id,message_id,kind,channel,title,content,proposed_publish_at,status,created_at,updated_at")
        .single();
      if (error) return databaseUnavailable();
      draft = data as MaraDraftRecord;
    }

    await supabase.from("mara_conversations").update({ updated_at: new Date().toISOString() }).eq("id", conversation.id);
    let pendingActions: MaraPendingActionRecord[] = [];
    if (toolResult) {
      const { data } = toolResult.pendingActionIds.length ? await supabase.from("mara_pending_actions").select("id,conversation_id,message_id,tool_name,summary,old_value,new_value,status,result_summary,error_summary,created_at,updated_at,executed_at")
        .eq("owner_user_id", user.id).in("id", toolResult.pendingActionIds).order("created_at", { ascending: true }) : { data: [] };
      pendingActions = (data ?? []) as MaraPendingActionRecord[];
    }
    return streamResult(conversation.id, userMessage as MaraMessageRecord, assistantMessage as MaraMessageRecord, draft, pendingActions);
  } catch (error) {
    return aiFailure(error);
  }
}

async function resolveConversation(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
  conversationId: string | null,
  firstMessage: string,
) {
  if (conversationId) {
    const { data } = await supabase
      .from("mara_conversations")
      .select("id")
      .eq("id", conversationId)
      .eq("owner_user_id", userId)
      .maybeSingle();
    return data;
  }
  const { data } = await supabase
    .from("mara_conversations")
    .insert({ owner_user_id: userId, title: firstMessage.slice(0, 80) })
    .select("id")
    .single();
  return data;
}

function streamResult(conversationId: string, userMessage: MaraMessageRecord, assistantMessage: MaraMessageRecord, draft: MaraDraftRecord | null, pendingActions: MaraPendingActionRecord[] = [], media: MediaGenerationRecord | null = null) {
  const encoder = new TextEncoder();
  const chunks = assistantMessage.content.match(/.{1,48}(?:\s|$)/g) ?? [assistantMessage.content];
  const stream = new ReadableStream({
    async start(controller) {
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: "start", conversationId, userMessage })}\n`));
      for (const content of chunks) {
        controller.enqueue(encoder.encode(`${JSON.stringify({ type: "delta", content })}\n`));
        await new Promise((resolve) => setTimeout(resolve, 12));
      }
      controller.enqueue(encoder.encode(`${JSON.stringify({ type: "done", assistantMessage, draft, pendingActions, media })}\n`));
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" } });
}

async function createMediaRequest(input: {
  userId: string;
  conversationId: string;
  requestId: string;
  message: string;
  mediaRequest: NonNullable<ReturnType<typeof inferMediaRequest>>;
  business: NonNullable<Awaited<ReturnType<typeof getBusinessRecord>>>;
}) {
  const admin = createAdminClient();
  const brand = input.business as unknown as Record<string, unknown>;
  const brandContext = [
    `Brand: ${String(brand.brand_name ?? "the user's brand")}`,
    brand.brand_description ? `Description: ${String(brand.brand_description)}` : "",
    brand.industry ? `Industry: ${String(brand.industry)}` : "",
    Array.isArray(brand.brand_personality) ? `Visual personality: ${brand.brand_personality.join(", ")}` : "",
  ].filter(Boolean).join("\n");
  const prompt = `${input.message}\n\nCreate polished marketing media for this saved Voom brand.\n${brandContext}\nDo not add logos, claims, prices, or written text unless the request explicitly asks for them.`.slice(0, 4000);
  const isVideo = input.mediaRequest.mediaType === "video";
  const assistantText = isVideo
    ? "I prepared your video generation request. Review the format and estimated cost below, then press Confirm generation. Nothing will be published."
    : "I’m creating your image now. The finished visual will appear in the card below and remain saved here after refresh.";
  const idempotencyKey = `mara-media:${input.requestId}`;
  const { data: existing } = await admin.from("mara_media_generations").select(MEDIA_SELECT).eq("owner_user_id", input.userId).eq("idempotency_key", idempotencyKey).maybeSingle();
  if (existing?.message_id) {
    const { data: existingMessage } = await admin.from("mara_messages").select("id,conversation_id,role,content,created_at").eq("id", existing.message_id).eq("owner_user_id", input.userId).maybeSingle();
    if (existingMessage) return { assistantMessage: existingMessage as MaraMessageRecord, media: await toMediaView(admin, existing as Record<string, unknown>) };
  }
  const { data: assistantMessage, error: assistantError } = await admin.from("mara_messages").insert({ conversation_id: input.conversationId, owner_user_id: input.userId, role: "assistant", content: assistantText }).select("id,conversation_id,role,content,created_at").single();
  if (assistantError) return databaseUnavailable();
  const { data: media, error } = await admin.from("mara_media_generations").upsert({
    owner_user_id: input.userId, conversation_id: input.conversationId, message_id: assistantMessage.id,
    media_type: input.mediaRequest.mediaType, prompt, aspect_ratio: input.mediaRequest.aspectRatio,
    duration_seconds: input.mediaRequest.durationSeconds, status: isVideo ? "pending_confirmation" : "queued",
    // Both estimates come from the ONE centralized model, and the audited
    // source is recorded: this endpoint only ever runs because the owner asked
    // for that exact media in chat.
    estimated_cost_usd: isVideo
      ? estimateVideoCost(input.mediaRequest.durationSeconds ?? 8)
      : estimateMediaCostUsd({ mediaType: "image" }),
    spend_source: "user_request",
    idempotency_key: idempotencyKey,
  }, { onConflict: "owner_user_id,idempotency_key" }).select(MEDIA_SELECT).single();
  if (error) return databaseUnavailable();
  return { assistantMessage: assistantMessage as MaraMessageRecord, media: await toMediaView(admin, media as Record<string, unknown>) };
}

/**
 * The confirmation estimate shown before a video generation. Delegates to the
 * ONE centralized cost model (lib/mara/media-spend.ts) — this route keeps no
 * cost constant of its own.
 */
function estimateVideoCost(seconds: number) {
  return estimateMediaCostUsd({ mediaType: "video", durationSeconds: seconds });
}

function shouldUseTools(message: string, expectedKind: MaraDraftKind | null) {
  const readsCalendar = /\b(what(?:'s| is)?|show|list|check|get|anything)\b[^?]{0,80}\b(?:on|in)?\s*(?:my\s+)?calendar\b/i.test(message)
    || /\bwhat(?:'s| is)?\s+on\s+my\s+calendar\b/i.test(message);
  const changesVoom = /\b(add|schedule|reschedule|move|delete|remove|approve|reject|update)\b[^?]{0,100}\b(calendar|post|draft|campaign)\b/i.test(message)
    || /\bpublish\b[^?]{0,80}\binstagram\b/i.test(message);
  if (readsCalendar || changesVoom) return true;
  if (expectedKind && !/\b(create|build|draft)\b.*\bemail\b.*\bcampaign\b/i.test(message)) return false;
  return /\b(calendar|schedule|reschedule|move|delete|campaign|drafts?|brand profile|connected|instagram|subscription|feature limit|approve|reject|publish)\b/i.test(message);
}

async function runToolLoop(input: {
  messages: AiMessage[];
  db: Awaited<ReturnType<typeof createClient>>;
  ownerId: string;
  conversationId: string;
  profile: Awaited<ReturnType<typeof getProfileRecord>>;
  business: NonNullable<Awaited<ReturnType<typeof getBusinessRecord>>>;
  requestId: string;
  userRequest: string;
}) {
  const provider = createAiProvider();
  const messages: AiToolMessage[] = input.messages.map((item) => ({ role: item.role, content: item.content }));
  messages[0] = { role: "system", content: `${messages[0]?.content ?? ""}\n\nYou can inspect and operate Voom only through the supplied tools. Today is ${new Date().toISOString()} and the user's timezone is Asia/Dubai. Never invent IDs or results. Reads can run automatically. Calendar additions, changes, deletions, and draft approval return a pending confirmation; clearly say no change happened yet. Never claim publishing, sending, Instagram execution, or ad spending succeeded because those capabilities are unavailable. Use create_campaign_draft for a requested single email campaign and do not send it. SMS is not available. Do not expose tool names, raw JSON, IDs unless needed for a view link, or internal errors. After tool results, answer naturally and concisely.` };
  let calls = 0;
  const pendingSummaries: string[] = [];
  const pendingActionIds: string[] = [];
  const runIds: string[] = [];
  const tools = selectRelevantTools(messages.at(-1)?.content ?? "");
  for (let iteration = 0; iteration < 4; iteration++) {
    let decision;
    try { decision = await provider.decideTools({ messages, tools, maxTokens: 1400 }); }
    catch (error) {
      if (pendingSummaries.length) return { response: `${pendingSummaries.join(" ")} Review the confirmation card below. Nothing has changed yet.`, pendingActionIds, runIds };
      throw error;
    }
    messages.push(decision.assistantMessage);
    if (!decision.toolCalls.length) return {
      response: blockedExternalActionResponse(input.userRequest) ?? normalizeToolResponse(decision.content),
      pendingActionIds,
      runIds,
    };
    if (calls + decision.toolCalls.length > 8) throw new AiError("malformed_response", "MARA requested too many internal operations.");
    for (const call of decision.toolCalls) {
      calls++;
      const result = await executeMaraTool({ db: input.db, ownerId: input.ownerId, conversationId: input.conversationId, profile: input.profile, business: input.business, requestKey: input.requestId, userRequest: input.userRequest }, call.name, call.arguments);
      if (result.status === "pending_confirmation") pendingSummaries.push(result.summary);
      if (result.pendingActionId) pendingActionIds.push(result.pendingActionId);
      if (result.runId) runIds.push(result.runId);
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result).slice(0, 12000) });
    }
  }
  throw new AiError("malformed_response", "MARA's internal operation loop reached its safe limit.");
}

function normalizeToolResponse(content: string | null) {
  const fallback = "I checked Voom, but I couldn't form a reliable answer. Please retry.";
  const value = content?.trim();
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const response = (parsed as { response?: unknown }).response;
      if (typeof response === "string" && response.trim()) return response.trim();
    }
  } catch {
    // Tool-loop responses are normally prose. Invalid JSON is returned as prose.
  }
  return value;
}

function blockedExternalActionResponse(userRequest: string) {
  if (/\b(publish|post|send)\b[^?]{0,80}\binstagram\b/i.test(userRequest)) {
    return "Instagram publishing is not connected or approved yet, so I did not publish anything. I can still create or update an Instagram draft for you to review.";
  }
  return null;
}

function selectRelevantTools(message: string) {
  const value = message.toLowerCase();
  let names: string[];
  if (/\b(delete|remove)\b/.test(value)) names = ["list_content_calendar", "get_calendar_item", "delete_calendar_item"];
  else if (/\b(move|reschedule|update)\b/.test(value)) names = ["list_content_calendar", "get_calendar_item", "update_calendar_item"];
  else if (/\b(add|schedule)\b/.test(value)) names = ["list_content_calendar", "propose_calendar_item", "get_connected_channels"];
  else if (/calendar|post/.test(value)) names = ["list_content_calendar", "get_calendar_item"];
  else if (/campaign|email/.test(value)) names = ["list_campaigns", "get_campaign", "create_campaign_draft", "update_campaign_draft", "get_brand_profile", "get_connected_channels"];
  else if (/instagram|publish/.test(value)) names = ["get_instagram_connection_status", "get_connected_channels", "get_draft"];
  else if (/draft|approve|reject/.test(value)) names = ["list_drafts", "get_draft", "create_content_draft", "update_content_draft", "approve_draft", "reject_draft"];
  else if (/subscription|limit|plan/.test(value)) names = ["get_subscription_and_feature_limits"];
  else names = ["get_brand_profile", "get_connected_channels"];
  const selected = maraToolDefinitions.filter((tool) => names.includes(tool.function.name));
  return selected.length ? selected : maraToolDefinitions;
}

function aiFailure(error: unknown) {
  if (error instanceof AiError) {
    if (error.code === "not_configured") return Response.json({ error: "MARA is almost ready. Add the AI provider settings, then retry." }, { status: 503 });
    if (error.code === "rate_limited") return Response.json({ error: "MARA is busy right now. Wait a moment and retry." }, { status: 429 });
    if (error.code === "malformed_response") return Response.json({ error: "MARA couldn't generate the complete deliverable. Please try again." }, { status: 502 });
  }
  return Response.json({ error: "MARA couldn't answer just now. Your message is saved—please retry." }, { status: 503 });
}

async function generateMaraResult(messages: AiMessage[], expectedKind: MaraDraftKind | null): Promise<MaraAiResult> {
  const provider = createAiProvider();
  const request = (attemptMessages: AiMessage[]) => provider.structured({
    messages: attemptMessages,
    parse: (value) => parseMaraResult(value, expectedKind),
    maxTokens: expectedKind === "weekly_calendar" ? 3600 : 2200,
  });

  try {
    return await request(messages);
  } catch (error) {
    if (!(error instanceof AiError) || error.code !== "malformed_response" || !expectedKind) throw error;
    return request([
      ...messages,
      {
        role: "system",
        content: `Your previous output was incomplete or invalid. Try once more. Return valid JSON with a non-null "${expectedKind}" draft containing every required section in draft.content. Do not return only a summary.`,
      },
    ]);
  }
}

function databaseUnavailable() {
  return Response.json({ error: "MARA's conversation storage is not ready. Please retry shortly." }, { status: 503 });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const value = await request.json();
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}
