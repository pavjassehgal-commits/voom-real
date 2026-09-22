/** Decisions shared by server boundaries and mock-only auth tests. */
export type AuthUser = { id: string; email?: string | null; email_confirmed_at?: string | null; is_anonymous?: boolean };

export function isVerifiedUser(user: AuthUser | null | undefined): user is AuthUser {
  return Boolean(user?.id && user.email && user.email_confirmed_at && !user.is_anonymous);
}

// Exact destinations, never prefix matching, decoded URLs, or user-supplied origins.
const DESTINATIONS = new Set(["/app", "/app/onboarding", "/app/settings", "/app/connections", "/app/plan"]);
export function safeNext(value: unknown): string {
  return typeof value === "string" && DESTINATIONS.has(value) ? value : "/app";
}

export function normalizeEmail(value: unknown): string {
  // Do not remove dots, plus suffixes, or otherwise rewrite mailbox identity.
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}
export function validEmail(value: string): boolean {
  return value.length <= 254 && /^[^\s@\x00-\x1f\x7f]+@[^\s@\x00-\x1f\x7f]+\.[^\s@\x00-\x1f\x7f]+$/.test(value);
}
export function passwordError(password: string): string | undefined {
  if (password.length < 12 || password.length > 128) return "Use a password between 12 and 128 characters. A long, unique passphrase works well.";
}
export function validCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,2048}$/.test(value);
}
export function validFlowId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
}
