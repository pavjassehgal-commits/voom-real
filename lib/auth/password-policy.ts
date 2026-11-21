/**
 * Voom's password rule, shared by signup and password reset.
 *
 * The rule matches Supabase Auth's own checks, so a password the form
 * accepts is never rejected later with an unexplained error:
 *   - at least 8 characters, counted as Unicode characters the way Supabase
 *     counts them (an emoji is one character, not two UTF-16 units);
 *   - at most 72 BYTES. Supabase rejects anything longer (bcrypt's limit) with
 *     `validation_failed`, so accented letters and emoji leave room for fewer
 *     characters.
 * There are deliberately no character-class rules. Supabase may additionally
 * reject a password as weak, for example one found in a known breach when
 * leaked-password protection is on. That comes back as `weak_password` and is
 * shown with WEAK_PASSWORD_MESSAGE.
 */
export const PASSWORD_MIN_CHARACTERS = 8;
export const PASSWORD_MAX_BYTES = 72;

export const PASSWORD_TOO_SHORT_MESSAGE = "Password must be at least 8 characters.";
export const PASSWORD_TOO_LONG_MESSAGE =
  "Password is too long. Use a shorter password (maximum 72 bytes). Some characters, including emoji, Arabic and accented letters, use multiple bytes.";
export const WEAK_PASSWORD_MESSAGE =
  "That password is too weak or has appeared in a known data breach. Choose a different one.";

/** The form-level problem with this password, or undefined when it meets the rule. */
export function passwordPolicyError(password: string): string | undefined {
  if ([...password].length < PASSWORD_MIN_CHARACTERS) return PASSWORD_TOO_SHORT_MESSAGE;
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) return PASSWORD_TOO_LONG_MESSAGE;
  return undefined;
}

/** True only for Supabase Auth's stable weak-password code. Provider text is never inspected or shown. */
export function isWeakPasswordError(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "weak_password";
}
