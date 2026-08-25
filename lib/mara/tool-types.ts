export interface MaraPendingActionRecord {
  id: string;
  conversation_id: string;
  message_id: string | null;
  tool_name: string;
  summary: string;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  status: "pending" | "executing" | "confirmed" | "cancelled" | "failed";
  result_summary: string | null;
  error_summary: string | null;
  created_at: string;
  updated_at: string;
  executed_at: string | null;
}

export interface MaraToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface MaraToolDecision {
  content: string | null;
  toolCalls: MaraToolCall[];
}
