/**
 * Deterministic, explainable classification of ALREADY-STORED content text.
 *
 * Voom does not store a "purpose" or "theme" column today, and this feature
 * must not invent one or call a model to guess. Instead the purpose and the
 * topic/theme of a published item are derived from the words Voom itself
 * stored for it (draft title + caption), with fixed, readable rules. The same
 * input always produces the same output, every rule can be pointed at in the
 * UI, and nothing is claimed that the stored text does not support.
 *
 * Pure module: no I/O, no model calls, directly unit tested.
 */

export const CONTENT_PURPOSES = ["promotional", "educational", "trust", "community", "general"] as const;
export type ContentPurpose = (typeof CONTENT_PURPOSES)[number];

export const CONTENT_PURPOSE_LABELS: Record<ContentPurpose, string> = {
  promotional: "Promotional",
  educational: "Educational",
  trust: "Trust-building",
  community: "Community",
  general: "General",
};

/** Fixed keyword rules. First matching category wins by score, then by order. */
const PURPOSE_RULES: { purpose: ContentPurpose; pattern: RegExp }[] = [
  { purpose: "promotional", pattern: /\b(offer|discount|deal|sale|price|pricing|save|saving|savings|limited|launch|pre[- ]?order|book now|order now|shop now|sign ?up|free trial|voucher|promo|coupon|special|exclusive)\b|\d{1,3}\s*%\s*off|\bpercent off\b/i },
  { purpose: "educational", pattern: /\b(how to|how our|guide|tips?|learn|explain|explained|what is|why|steps?|checklist|mistake|understand|breakdown|walkthrough|tutorial)\b/i },
  { purpose: "trust", pattern: /\b(review|reviews|customer|customers|testimonial|trusted|certified|licensed|secure|security|compliance|reliable|proven|guarantee|case study|award|accredited)\b/i },
  { purpose: "community", pattern: /\b(team|behind the scenes|welcome|thank you|thanks|grateful|community|introducing|meet the|celebrating|festive)\b/i },
];

/** Derives the purpose of one stored item from its own title + caption. */
export function classifyPurpose(...text: (string | null | undefined)[]): ContentPurpose {
  const haystack = text.filter((value): value is string => typeof value === "string").join(" ");
  if (!haystack.trim()) return "general";
  let best: { purpose: ContentPurpose; score: number } | null = null;
  for (const rule of PURPOSE_RULES) {
    const matches = haystack.match(new RegExp(rule.pattern.source, `${rule.pattern.flags.replace("g", "")}g`));
    const score = matches?.length ?? 0;
    if (score > 0 && (!best || score > best.score)) best = { purpose: rule.purpose, score };
  }
  return best?.purpose ?? "general";
}

/** Short label for a derived topic inside a sentence: “payment speed”. */
export function topicLabel(topic: string): string {
  return `“${topic}”`;
}

/** Words that never identify a topic, so they never become a theme. */
const STOP_WORDS = new Set([
  "about", "after", "again", "against", "almost", "along", "already", "also", "always", "among", "another",
  "because", "become", "been", "before", "behind", "being", "below", "beside", "better", "between", "beyond",
  "brand", "business", "could", "didn", "does", "doesn", "doing", "done", "down", "during", "each", "every",
  "everything", "first", "from", "further", "give", "goes", "going", "good", "great", "have", "having", "here",
  "into", "isn", "it", "its", "just", "know", "last", "less", "like", "little", "made", "make", "makes", "many",
  "maybe", "more", "most", "much", "must", "need", "never", "next", "nothing", "often", "only", "other",
  "others", "over", "really", "right", "same", "should", "since", "some", "something", "still", "such", "sure",
  "than", "that", "their", "them", "then", "there", "these", "they", "thing", "things", "this", "those",
  "through", "today", "together", "under", "until", "very", "want", "week", "well", "were", "what", "when",
  "where", "which", "while", "with", "without", "would", "your", "yours", "you", "our", "ours", "them", "we",
  "get", "got", "let", "lets", "new", "now", "out", "the", "and", "for", "are", "but", "not", "all", "any",
  "can", "day", "days", "time", "times", "one", "two", "how", "who", "why", "use", "using", "used", "see",
  "look", "looking", "come", "coming", "take", "taking", "give", "giving", "even", "back", "off", "own",
]);

/** Strips hashtags, mentions and URLs so they never masquerade as a topic. */
export function normalizeContentText(text: string): string {
  return text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/[#@]\S+/g, " ")
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Meaningful words, in order, deduplicated. */
export function contentWords(text: string): string[] {
  const words = normalizeContentText(text).split(" ").filter((word) => word.length >= 4 && !STOP_WORDS.has(word));
  return [...new Set(words)];
}

/** Candidate themes for one item: adjacent word pairs, then single words. */
export function contentPhrases(text: string): string[] {
  const words = normalizeContentText(text).split(" ").filter(Boolean);
  const pairs: string[] = [];
  for (let index = 0; index < words.length - 1; index += 1) {
    const first = words[index];
    const second = words[index + 1];
    if (first.length < 4 || second.length < 4) continue;
    if (STOP_WORDS.has(first) || STOP_WORDS.has(second)) continue;
    pairs.push(`${first} ${second}`);
  }
  return [...new Set([...pairs, ...contentWords(text)])];
}

export interface TopicCandidate {
  topic: string;
  /** How many distinct items contain this phrase. */
  count: number;
}

/**
 * Finds the themes that MORE THAN ONE item shares — a single post is never a
 * "theme". Ranked by how many items share them, then by specificity (a longer
 * phrase beats a single word), then alphabetically so the result is stable.
 */
export function sharedTopics(textPerItem: (string | null | undefined)[], minimumItems = 2): TopicCandidate[] {
  const counts = new Map<string, number>();
  for (const text of textPerItem) {
    if (!text?.trim()) continue;
    for (const phrase of contentPhrases(text)) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= minimumItems)
    .map(([topic, count]) => ({ topic, count }))
    .sort((a, b) => b.count - a.count
      || b.topic.split(" ").length - a.topic.split(" ").length
      || a.topic.localeCompare(b.topic));
}

/**
 * The single best theme for one item: the highest-ranked shared theme its own
 * stored text contains. Items that share no theme with any other item get null
 * — they are real content, just not part of a measurable pattern.
 */
export function topicForItem(text: string, candidates: TopicCandidate[], claimed = new Map<string, number>()): string | null {
  const normalized = ` ${normalizeContentText(text)} `;
  for (const candidate of candidates) {
    if (!normalized.includes(` ${candidate.topic} `)) continue;
    const used = claimed.get(candidate.topic) ?? 0;
    // Never let a broader phrase shadow a theme more items still need: a
    // theme is claimed at most as often as it was measured.
    if (used >= candidate.count) continue;
    claimed.set(candidate.topic, used + 1);
    return candidate.topic;
  }
  return null;
}

/** Assigns one theme (or null) per item, consistently across the set. */
export function assignTopics(items: { key: string; text: string }[]): Map<string, string | null> {
  const candidates = sharedTopics(items.map((item) => item.text));
  const claimed = new Map<string, number>();
  const assigned = new Map<string, string | null>();
  for (const item of items) assigned.set(item.key, topicForItem(item.text, candidates, claimed));
  return assigned;
}
