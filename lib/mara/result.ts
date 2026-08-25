import { AiError } from "@/lib/ai";
import { DRAFT_KINDS, type MaraAiResult, type MaraDraftInput, type MaraDraftKind } from "./types";

const kindSet = new Set<string>(DRAFT_KINDS);

export function parseMaraResult(value: unknown, expectedKind: MaraDraftKind | null = null): MaraAiResult {
  if (!isRecord(value) || typeof value.response !== "string" || !value.response.trim()) {
    throw new AiError("malformed_response", "MARA returned an invalid response.");
  }
  if (value.draft == null) {
    if (expectedKind) throw new AiError("malformed_response", "MARA omitted the requested draft.");
    return { response: value.response.trim(), draft: null };
  }
  if (!isRecord(value.draft)) throw new AiError("malformed_response", "MARA returned an invalid draft.");

  const draft = value.draft;
  if (
    typeof draft.kind !== "string" ||
    !kindSet.has(draft.kind) ||
    typeof draft.channel !== "string" ||
    typeof draft.title !== "string" ||
    typeof draft.content !== "string" ||
    !draft.channel.trim() ||
    !draft.title.trim() ||
    !draft.content.trim()
  ) {
    throw new AiError("malformed_response", "MARA returned an invalid draft.");
  }
  if (expectedKind && draft.kind !== expectedKind) {
    throw new AiError("malformed_response", "MARA returned the wrong draft type.");
  }

  let proposedPublishAt: string | null = null;
  if (typeof draft.proposedPublishAt === "string" && !Number.isNaN(Date.parse(draft.proposedPublishAt))) {
    proposedPublishAt = new Date(draft.proposedPublishAt).toISOString();
  }

  return {
    response: value.response.trim(),
    draft: {
      kind: draft.kind as MaraDraftInput["kind"],
      channel: draft.channel.trim().slice(0, 60),
      title: draft.title.trim().slice(0, 160),
      content: draft.content.trim().slice(0, 12000),
      proposedPublishAt,
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
