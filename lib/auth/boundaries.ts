// Machine/public routes retain their OWN secret/signature/token authorization.
// Provider OAuth callbacks intentionally are NOT exceptions: they bind to the
// currently signed-in, verified owner before exchanging provider credentials.
export const NON_SESSION_APIS = new Set([
  "/api/admin/instagram/rotate-token-key",
  "/api/cron/email-flows", "/api/cron/instagram-performance", "/api/cron/instagram-publish",
  "/api/cron/media-generation", "/api/cron/tiktok-publish", "/api/cron/tiktok-reconcile",
  "/api/cron/weekly-plans", "/api/cron/youtube-performance", "/api/cron/youtube-publish",
  "/api/cron/youtube-reconcile", "/api/unsubscribe", "/api/webhooks/resend",
  "/api/mara", // deprecated 410-only endpoint
]);
export function authBoundary(path: string): "app" | "api" | null {
  const normalized = path.replace(/\/$/, "");
  if (normalized === "/app" || normalized.startsWith("/app/")) return "app";
  if (normalized.startsWith("/api/") && !NON_SESSION_APIS.has(normalized)) return "api";
  return null;
}
export function unsafeBrowserMutation(method: string, origin: string | null, host: string, fetchSite: string | null): boolean {
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return false;
  if (fetchSite === "cross-site") return true;
  if (!origin) return false; // non-browser callers still need an authenticated session
  try { return new URL(origin).host !== host; } catch { return true; }
}
