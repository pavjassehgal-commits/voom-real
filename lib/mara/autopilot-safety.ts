export interface AutopilotSafetyInput {
  title: string;
  content: string;
  topic?: string;
  reason?: string;
  publishAt: string;
}

export interface AutopilotSafetyResult {
  safe: boolean;
  checks: string[];
  blockers: string[];
}

const BLOCKED: Array<[string, RegExp]> = [
  ["unsupported_offer", /\b(discount|coupon|promo(?:tion)?|special offer|limited[- ]time offer|deal|save \d+|\d+%\s*off|free (?:gift|item|delivery)|buy one|get one|bogo|complimentary|on the house|on us)\b/i],
  ["unsupported_price", /(?:(?:[$£€¥₹د\.?إ]|\b(?:aed|usd|eur|gbp|dhs?)\b)\s*\d|\d\s*(?:aed|usd|eur|gbp|dhs?)\b|\b(?:only|just)\s+\d+(?:[.,]\d{1,2})?\b)/i],
  ["unsupported_claim", /(?:#\s*1\b|\bnumber one\b|\b(?:the )?best\b|\b100%\b|\binstant results?\b|\bguarantee(?:d|s)?\b|\brisk[- ]free\b|\bproven results?\b)/i],
  ["giveaway_or_contest", /\b(giveaway|contest|sweepstakes|raffle|prize|win(?:ner)?|enter to win)\b/i],
  ["regulated_or_sensitive_claim", /\b(diagnos(?:e|is)|treat(?:ment)?|cure|medical|doctor|health claim|wellness claim|detox|immunity|legal advice|lawyer|financial advice|investment|returns?|election|politic(?:al|s)|vote|safe(?:ty)? guarantee|harmless|zero risk)\b/i],
  ["competitor_attack", /\b(better than|worse than|unlike our competitors?|competitors? (?:lie|fail|cheat)|avoid [\w -]+ because)\b/i],
  ["sensitive_personal_information", /(?:\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b|(?:\+?\d[\s().-]*){8,}|\b(?:card|account|passport|emirates id|ssn)\s*(?:number|no\.?|#)?\s*[:#-]?\s*[A-Z0-9-]{5,})/i],
  ["unverified_external_link", /(?:https?:\/\/|www\.)\S+/i],
  ["paid_advertising", /\b(paid ad(?:vertising)?|sponsored post|boost(?:ed| this)? post|ad spend|media buy|cost per click|cpc|ppc)\b/i],
];

/**
 * The content half of the safety vocabulary, on its own.
 *
 * Some surfaces legitimately schedule further out than the 8-day approval
 * window below — lifecycle email sequences, for instance, wait days or weeks
 * between steps — but the *content* rules are universal. This exports them
 * without the schedule check so one vocabulary is shared instead of copied,
 * and `evaluateAutopilotRecommendation` keeps using exactly this list.
 */
export function evaluateContentSafetyBlockers(text: string): string[] {
  const blockers: string[] = [];
  for (const [name, pattern] of BLOCKED) if (pattern.test(text)) blockers.push(name);
  return blockers;
}

export function evaluateAutopilotRecommendation(input: AutopilotSafetyInput, now = new Date()): AutopilotSafetyResult {
  const content = input.content.trim();
  const title = input.title.trim();
  const text = [title, content, input.topic, input.reason].filter(Boolean).join("\n");
  const blockers: string[] = [];
  if (!title || !content || content.length > 12000) blockers.push("invalid_content");

  const publishAt = Date.parse(input.publishAt);
  const earliest = now.getTime() + 5 * 60_000;
  const latest = now.getTime() + 8 * 24 * 60 * 60_000;
  if (!Number.isFinite(publishAt) || publishAt < earliest || publishAt > latest) blockers.push("invalid_schedule");

  blockers.push(...evaluateContentSafetyBlockers(text));
  return {
    safe: blockers.length === 0,
    checks: ["valid_content", "valid_future_schedule", "no_unsupported_offer_or_price", "no_unsupported_claim", "no_sensitive_or_regulated_content", "no_unverified_link", "no_paid_action"],
    blockers,
  };
}
