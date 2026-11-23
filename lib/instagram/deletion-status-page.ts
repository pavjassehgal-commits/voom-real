/**
 * Public page for Meta's data-deletion status URL (/data-deletion/status?code=...).
 * Shows only what has actually happened. No account identity is ever shown.
 */
import type { DeletionStatus } from "./callback-store";

const HEADERS = {
  "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", "X-Robots-Tag": "noindex, nofollow",
};
const day = (iso: string) => new Date(iso).toISOString().slice(0, 10);

export function deletionStatusMessage(s: DeletionStatus): string {
  const received = `We received this request on ${day(s.receivedAt)}.`;
  if (s.status === "completed" && s.completedAt) {
    return `${received} Deletion was completed on ${day(s.completedAt)}: the Instagram data Voom held for this request has been removed from Voom's systems and the remaining records were reviewed.`
      + (s.backupsClearBy ? ` Encrypted backups that may still hold an older copy are overwritten automatically by ${day(s.backupsClearBy)}.` : "");
  }
  if (s.status === "awaiting_review") {
    return `${received} The Instagram data in Voom's active systems has been removed. We are now verifying the remaining records (publishing history, service providers and backups). The request is not complete yet; this page will say so when it is.`;
  }
  return `${received} It is being processed: Voom's access to the Instagram account is revoked where we could match it, and removal of the Instagram data Voom holds is in progress. The request is not complete yet; this page will say so when it is.`;
}

function page(status: number, body: string) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Voom data deletion request</title></head><body style="font:16px/1.5 system-ui,sans-serif;max-width:560px;margin:10vh auto;padding:0 20px"><h1 style="font-size:22px">Data deletion request</h1>${body}<p style="font-size:14px;color:#555">Questions: see <a href="/data-deletion">Voom data deletion</a>.</p></body></html>`, { status, headers: HEADERS });
}

export async function renderDeletionStatus(code: string, enabled: boolean, lookup: (code: string) => Promise<DeletionStatus | null>): Promise<Response> {
  if (!enabled) return page(503, "<p>This page is temporarily unavailable. Please try again later.</p>");
  if (!/^[a-f0-9]{32}$/.test(code)) return page(404, "<p>We could not find a request with this code.</p>");
  try {
    const status = await lookup(code);
    if (!status) return page(404, "<p>We could not find a request with this code.</p>");
    return page(200, `<p>Confirmation code: <code>${code}</code></p><p>${deletionStatusMessage(status)}</p>`);
  } catch {
    return page(503, "<p>We could not load the status right now. Please try again later.</p>");
  }
}
