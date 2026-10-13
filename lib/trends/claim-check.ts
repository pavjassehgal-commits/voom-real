/**
 * Trend Intelligence — unsupported-claim check for MARA output grounded in
 * trend evidence.
 *
 * Deterministic and pure. Compares generated text against what MARA was
 * allowed to use: the verified trend facts and the business's own context.
 * It flags, rather than silently fixes:
 *   - numbers (and dates) that appear in neither the facts nor the business
 *     context;
 *   - prices, currencies, discounts and percentages not in the allowed text;
 *   - partnership / sponsorship / "official" claims about the trend topic;
 *   - links (MARA is told never to invent links);
 *   - guarantees and results claims ("guaranteed", "proven", "#1", ...);
 *   - popularity claims ("trending", "viral", "popular on TikTok/Instagram")
 *     that the stored facts do not state: no current source measures social
 *     or search popularity, so attention on Wikipedia can never be presented
 *     as an Instagram, TikTok, YouTube or search trend.
 * It is a screen for review, not proof of truth: a clean result means no
 * known pattern of unsupported claim was found.
 */

import type { TrendPromptContext } from "./opportunity";

export type ClaimFinding = {
  kind: "unsupported_number" | "price_or_discount" | "partnership_claim" | "link" | "guarantee_or_result" | "popularity_claim";
  text: string;
  field: string;
};

export type ClaimCheckResult = { clean: boolean; findings: ClaimFinding[]; checkedFields: string[] };

export type TrendUsageResult = {
  grounded: boolean;
  code: "trend_referenced" | "trend_not_referenced";
  checkedFields: string[];
};

export type CheckableContent = {
  concept: string;
  hook: string;
  caption: string;
  cta: string;
  hashtags: string[];
  description: string;
  script: string[];
  visualBrief: string;
};

/** Numbers as written, plus day/month/year parts of any date-like token. */
function numbersIn(text: string): string[] {
  return [...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(/,/g, ""));
}

function allowedNumbers(context: TrendPromptContext, businessText: string): Set<string> {
  const allowed = new Set<string>();
  const add = (text: string) => numbersIn(text).forEach((n) => {
    allowed.add(n);
    allowed.add(String(Number(n)));
  });
  for (const fact of context.facts) add(fact.statement);
  add(context.topic);
  add(businessText);
  if (context.eventWindow) {
    for (const date of [context.eventWindow.start, context.eventWindow.end]) {
      const [year, month, day] = date.split("-");
      [year, month, day, String(Number(month)), String(Number(day))].forEach((n) => allowed.add(n));
    }
  }
  return allowed;
}

const PRICE = /(?:\b(?:aed|dhs?|usd|eur|gbp)\b\s*\d|\d+\s*(?:aed|dhs?|usd|eur|gbp)\b|[$€£]\s*\d|\d+\s*%|\b\d+\s*per\s*cent\b|\b(?:discount|% off|off\s+(?:all|your|every)|free\s+(?:smoothie|drink|bowl|coffee|item|gift)|buy\s+one|bogo|promo\s*code|coupon)\b)/i;
const PARTNERSHIP = /\b(?:official\s+(?:partner|sponsor|supplier|venue|hub|cafe|café)|(?:proud(?:ly)?\s+)?sponsor(?:ed|ing|s)?\b|in\s+partnership\s+with|partnered\s+with|endorsed\s+by|affiliated\s+with)/i;
const LINK = /\bhttps?:\/\/\S+|\bwww\.\S+|\b[a-z0-9-]+\.(?:com|ae|net|org|io)\b/i;
/** Claims of social, search or general popularity. Allowed only when the stored facts say the same words. */
const POPULARITY = /\b(trending|trends? on|viral|went viral|going viral|blowing up|everyone(?:'s| is) talking|all over (?:tiktok|instagram|youtube|social)|(?:popular|hot|huge|big) (?:on|across) (?:tiktok|instagram|youtube|social media|google)|most[- ](?:searched|popular|liked|shared)|top (?:trend|search)(?:es|s)?)\b/i;
const GUARANTEE = /\b(?:guarantee[sd]?|proven|clinically|#1|number\s+one|best\s+in\s+(?:dubai|the\s+uae|town)|award[- ]winning|lose\s+\d+)/i;

const normalizeReference = (text: string) => text
  .toLowerCase()
  .normalize("NFKC")
  .replace(/[^\p{L}\p{N}]+/gu, " ")
  .trim();

/**
 * Deterministically requires the supplied trend to appear in the deliverable.
 * An exact normalized topic phrase is accepted, as is the compact form used
 * by hashtags (for example `#DubaiFitnessChallenge`). A generic reference to
 * fitness, seasons or an unnamed event is deliberately not enough.
 */
export function checkTrendUsage(content: CheckableContent, context: TrendPromptContext): TrendUsageResult {
  const fields: [string, string][] = [
    ["concept", content.concept], ["hook", content.hook], ["caption", content.caption], ["cta", content.cta],
    ["hashtags", content.hashtags.join(" ")], ["description", content.description], ["script", content.script.join(" ")],
    ["visualBrief", content.visualBrief],
  ];
  const topic = normalizeReference(context.topic);
  // A trailing edition year is optional in natural copy; the named event is
  // still explicit. No other words are discarded, so generic category copy
  // cannot satisfy this check.
  const aliases = [...new Set([topic, topic.replace(/\s+\d{4}$/, "")])].filter(Boolean);
  const grounded = aliases.length > 0 && fields.some(([, value]) => {
    const normalized = normalizeReference(value);
    const compact = normalized.replaceAll(" ", "");
    return aliases.some((alias) => normalized.includes(alias) || compact.includes(alias.replaceAll(" ", "")));
  });
  return {
    grounded,
    code: grounded ? "trend_referenced" : "trend_not_referenced",
    checkedFields: fields.filter(([, value]) => value.trim().length > 0).map(([field]) => field),
  };
}

export function checkTrendGroundedContent(
  content: CheckableContent,
  context: TrendPromptContext,
  business: { name: string; description: string; industry: string; goal: string; targetCustomer: string[] },
): ClaimCheckResult {
  const businessText = [business.name, business.description, business.industry, business.goal, ...business.targetCustomer].join(" ");
  const allowedText = [businessText, context.topic, ...context.facts.map((f) => f.statement)].join(" ");
  const numbers = allowedNumbers(context, businessText);
  const fields: [string, string][] = [
    ["concept", content.concept], ["hook", content.hook], ["caption", content.caption], ["cta", content.cta],
    ["hashtags", content.hashtags.join(" ")], ["description", content.description], ["script", content.script.join(" ")],
    ["visualBrief", content.visualBrief],
  ];
  const findings: ClaimFinding[] = [];
  for (const [field, text] of fields) {
    if (!text) continue;
    for (const n of numbersIn(text)) {
      if (!numbers.has(n) && !numbers.has(String(Number(n)))) findings.push({ kind: "unsupported_number", text: n, field });
    }
    const price = PRICE.exec(text);
    if (price && !allowedText.toLowerCase().includes(price[0].toLowerCase())) findings.push({ kind: "price_or_discount", text: price[0], field });
    const partner = PARTNERSHIP.exec(text);
    if (partner) findings.push({ kind: "partnership_claim", text: partner[0], field });
    const link = LINK.exec(text);
    if (link) findings.push({ kind: "link", text: link[0], field });
    const guarantee = GUARANTEE.exec(text);
    if (guarantee) findings.push({ kind: "guarantee_or_result", text: guarantee[0], field });
    const popularity = POPULARITY.exec(text);
    if (popularity && !allowedText.toLowerCase().includes(popularity[0].toLowerCase())) findings.push({ kind: "popularity_claim", text: popularity[0], field });
  }
  return { clean: findings.length === 0, findings, checkedFields: fields.filter(([, t]) => t).map(([f]) => f) };
}
