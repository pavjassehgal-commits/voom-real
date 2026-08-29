import { z } from "zod";

export const REEL_SCENE_COPY_LIMITS = {
  hook: { words: 8, chars: 52 },
  message: { words: 10, chars: 76 },
  value: { words: 10, chars: 76 },
  cta: { words: 6, chars: 46 },
} as const;

export type ReelSceneCopyRole = keyof typeof REEL_SCENE_COPY_LIMITS;

export interface ViewerReelCopy {
  hook: string;
  message: string;
  value: string;
  cta: string;
}

export interface ViewerCopyContext {
  concept: string;
  caption: string;
  brandName: string;
}

export const viewerCopySchema = z.object({
  hook: z.string().min(1).max(140),
  message: z.string().min(1).max(180),
  value: z.string().min(1).max(180),
  cta: z.string().min(1).max(140),
}).strict();

/**
 * Internal production-direction language that must never appear in
 * viewer-facing Reel copy. Sentences that match are dropped completely.
 */
const DIRECTION_PATTERNS: RegExp[] = [
  /\bopening shot\b/i,
  /\bopening scene\b/i,
  /\bquick cuts?\b/i,
  /\bclose[- ]?ups?\b/i,
  /\bend frame\b/i,
  /\bend card\b/i,
  /\bb[- ]?roll\b/i,
  /\bwide shot\b/i,
  /\bover[- ]?the[- ]?shoulder\b/i,
  /\bestablishing shot\b/i,
  /\bcutaway\b/i,
  /\btracking shot\b/i,
  /\baerial shot\b/i,
  /\bdrone shot\b/i,
  /\bshot list\b/i,
  /\bscene transition\b/i,
  /\bvoice[- ]?over\b/i,
  /\bvoiceover\b/i,
  /\bnarration\b/i,
  /\bcall to action\b/i,
  /\bpayoff shot\b/i,
  /\bproduct shot\b/i,
  /\binsert shot\b/i,
  /\bcamera\b/i,
  /\btilt\b/i,
  /\bzoom\s+(?:in|out)\b/i,
  /\bpan\s+(?:left|right|up|down)\b/i,
  /\b(?:then|next)\s+(?:cut|show|reveal|zoom|pan)\b/i,
  /\bshot\s+(?:of|with|in|at|on|from|where|shows?|showing)\b/i,
  /\bscene\s+(?:of|with|in|where|shows?|showing)\b/i,
  /\bframe\s+(?:with|shows?|of)\b/i,
  /\b(?:cuts?|cutting|transition)\s+(?:to|of|between|into)\b/i,
  /\bshow(?:s|ing)?\s+(?:the|us|our|a|an|viewers?)\b/i,
  /\b(?:viewers?|audience)\s+(?:see|watch|follow)\b/i,
  /(^|\W)cta($|\W)/i,
];

export function isInternalDirection(text: string): boolean {
  return DIRECTION_PATTERNS.some((pattern) => pattern.test(text));
}

function splitSentences(text: string): string[] {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function cleanSentence(raw: string): string {
  let text = String(raw ?? "")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#@]\S+/g, " ")
    .replace(/&[a-z0-9#]+;/gi, " ")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, "\"")
    .replace(/[ \t]+/g, " ")
    .trim();
  text = splitSentences(text)
    .filter((sentence) => !isInternalDirection(sentence))
    .join(" ");
  text = text
    .replace(/\b(?:opening shot|opening scene|quick cuts?|close[- ]?ups?|end frame|end card|b[- ]?roll|wide shot|over[- ]?the[- ]?shoulder|establishing shot|cutaway|tracking shot|aerial shot|drone shot|shot list|scene transition|voice[- ]?over|voiceover|narration|call to action|payoff shot|product shot|insert shot|camera|tilt)\b/gi, " ")
    .replace(/\b(?:shot|scene|frame|cut|angle|sequence)\s+(?:of|with|in|at|on|from|to|where)\b/gi, " ")
    .replace(/\b(?:then|next)\s+(?:cut|show|reveal|zoom|pan)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text;
}

function countWords(text: string): number {
  return text.split(/\s+/).filter(Boolean).length;
}

export function fitLine(raw: string, role: ReelSceneCopyRole): string {
  const limits = REEL_SCENE_COPY_LIMITS[role];
  const clean = cleanSentence(raw);
  if (!clean) return "";
  let capped = clean.split(/\s+/).slice(0, limits.words).join(" ");
  if (capped.length > limits.chars) capped = capped.slice(0, limits.chars).replace(/\s+\S*$/, "").trim();
  return capped.trim();
}

function cleanConcept(raw: string): string {
  let text = String(raw ?? "").replace(/https?:\/\/\S+/gi, " ").replace(/[#@]\S+/g, " ").replace(/\s+/g, " ").trim();
  text = text
    .replace(/^(?:create|make|produce|film)\s+(?:a|an|the|this)?\s*(?:reel|short|video)\s*(?:about|for|on|showing|to)?/i, " ")
    .replace(/\breel\s+(?:about|for|on)\b/i, " ")
    .replace(/^(?:about|for|on)\b/i, " ");
  text = splitSentences(text).filter((sentence) => !isInternalDirection(sentence)).join(" ");
  text = text.replace(/\b(?:opening shot|quick cuts?|close[- ]?ups?|end frame|end card|shot list|camera|voice[- ]?over|call to action)\b/gi, " ").replace(/\s+/g, " ").trim();
  return text;
}

function cleanBrand(raw: string): string {
  const brand = cleanSentence(String(raw ?? "")).slice(0, 40).trim();
  return brand && !isInternalDirection(brand) ? brand : "our business";
}

function isCta(sentence: string): boolean {
  return /(^|\W)(get (?:yours|yours now|the offer)|shop|dm (?:us|the team|to order)|book|visit|find your|follow us|follow\b|learn (?:more|how)|try (?:it|us)|order|message us|call us|link in bio|see more|tap the link|swipe up)(\W|$)/i.test(sentence);
}

/**
 * Deterministic, truthful viewer-facing copy derived from the concept,
 * the existing caption, and the business name. Never uses the internal
 * production script or shot instructions.
 */
export function fallbackViewerCopy(context: ViewerCopyContext): ViewerReelCopy {
  const brand = cleanBrand(context.brandName);
  const concept = cleanConcept(context.concept);
  const sentences = splitSentences(context.caption).map(cleanSentence).filter((sentence) => countWords(sentence) >= 3);
  const conceptShort = fitLine(concept, "hook") || "Something worth sharing";

  const ctaSentence = sentences.find(isCta) ?? "";
  const body = sentences.filter((sentence) => !isCta(sentence));

  let hook = "";
  let message = "";
  let value = "";
  if (body.length >= 3) {
    [hook, message, value] = body;
  } else if (body.length === 2) {
    [hook, message] = body;
    value = fitLine(concept, "value") || `More from ${brand}`;
  } else {
    hook = body[0] || conceptShort;
    message = `From ${brand}`;
    value = `More from ${brand}`;
  }

  const cta = ctaSentence ? fitLine(ctaSentence, "cta") || `Follow ${brand}` : `Follow ${brand}`;
  const copy: ViewerReelCopy = {
    hook: fitLine(hook, "hook") || conceptShort,
    message: fitLine(message, "message") || `More from ${brand}`,
    value: fitLine(value, "value") || `More from ${brand}`,
    cta: fitLine(cta, "cta") || `Follow ${brand}`,
  };
  return copy;
}

/**
 * Validates and sanitizes AI-generated viewer copy. Any line that is empty,
 * malformed, or still contains internal production direction is replaced
 * through the deterministic fallback so a produced Reel is never polluted
 * with internal instructions.
 */
export function enforceViewerCopy(value: unknown, context: ViewerCopyContext): ViewerReelCopy {
  const parsed = viewerCopySchema.safeParse(value);
  const source = parsed.success ? parsed.data : null;
  const copy: ViewerReelCopy = {
    hook: source ? fitLine(source.hook, "hook") : "",
    message: source ? fitLine(source.message, "message") : "",
    value: source ? fitLine(source.value, "value") : "",
    cta: source ? fitLine(source.cta, "cta") : "",
  };
  const safe = Boolean(copy.hook && copy.message && copy.value && copy.cta)
    && !isInternalDirection(copy.hook) && !isInternalDirection(copy.message) && !isInternalDirection(copy.value) && !isInternalDirection(copy.cta)
    && countWords(copy.hook) <= REEL_SCENE_COPY_LIMITS.hook.words
    && countWords(copy.message) <= REEL_SCENE_COPY_LIMITS.message.words
    && countWords(copy.value) <= REEL_SCENE_COPY_LIMITS.value.words
    && countWords(copy.cta) <= REEL_SCENE_COPY_LIMITS.cta.words;
  return safe ? copy : fallbackViewerCopy(context);
}
