/**
 * Branded Email Engine — safe personalization.
 *
 * Voom owns exactly two tokens, and both are replaced with data it already
 * has for the recipient/business. There is no template language, no
 * expressions and no code execution: a token is a literal string, a missing
 * value falls back to neutral wording, and anything that still looks like an
 * unresolved token is scrubbed so a raw `{firstName}` can never reach a
 * recipient.
 *
 * Pure: no I/O, no server-only import — the Node suite executes it for real.
 */

/** Tokens the engine understands. Deliberately tiny and fixed. */
export const EMAIL_PERSONALIZATION_TOKENS = ["firstName", "businessName"] as const;
export type EmailPersonalizationToken = (typeof EMAIL_PERSONALIZATION_TOKENS)[number];

export interface PersonalizationValues {
  /** Contact first name, or null when the business does not have one. */
  firstName?: string | null;
  /** Business display name (falls back to a generic word when empty). */
  businessName?: string | null;
}

/** What a missing first name falls back to in a greeting. */
export const FIRST_NAME_FALLBACK = "there";
/** What a missing business name falls back to. */
export const BUSINESS_NAME_FALLBACK = "this business";

/**
 * Replaces the two supported tokens with real values.
 *
 * `{firstName}` → the contact's first name, or "there" when the business has
 * none, so "Hi {firstName}," never renders as "Hi ,".
 * `{businessName}` → the business name, or a neutral phrase.
 */
export function applyPersonalization(text: string, values: PersonalizationValues = {}): string {
  const firstName = (values.firstName ?? "").trim();
  const businessName = (values.businessName ?? "").trim();
  return text
    .replace(/\{firstName\}/g, firstName || FIRST_NAME_FALLBACK)
    .replace(/\{businessName\}/g, businessName || BUSINESS_NAME_FALLBACK);
}

/** A token-shaped fragment that survived personalization, e.g. `{firstName}`. */
const UNRESOLVED_TOKEN_RE = /\{\{?[\w.\- ]{1,64}\}?\}/g;

/**
 * The unresolved tokens present in a string, for diagnostics. An empty array
 * means the text is safe to hand to a provider.
 */
export function findUnresolvedTokens(text: string): string[] {
  const found = text.match(UNRESOLVED_TOKEN_RE) ?? [];
  return [...new Set(found.map((token) => token.trim()))];
}

/**
 * Removes any token-shaped fragment that personalization left behind. This is
 * the last line of defence — the quality guard rejects text that reaches it,
 * but if a non-marketing surface ever calls the renderer directly, the output
 * still never leaks a raw template token to a recipient.
 */
export function scrubUnresolvedTokens(text: string): string {
  return text
    .replace(UNRESOLVED_TOKEN_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
