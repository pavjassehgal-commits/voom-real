import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { processEmailUnsubscribe, verifyUnsubscribeToken } from "./branded/unsubscribe";

/** RFC 8058: signed HTTPS URL, form POST, no login/cookies/redirect. */
export function unsubscribeHandler(admin: () => SupabaseClient) {
  return async (request: Request) => {
    const formPost = request.headers.get("content-type")?.split(";")[0] === "application/x-www-form-urlencoded";
    const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };
    let token: string;
    try {
      const raw = await request.text();
      if (raw.length > 4096) return new Response(null, { status: 413, headers });
      if (formPost) {
        if (new URLSearchParams(raw).get("List-Unsubscribe") !== "One-Click") return new Response(null, { status: 400, headers });
        token = new URL(request.url).searchParams.get("token") ?? "";
      } else {
        const body = JSON.parse(raw) as { token?: unknown };
        token = typeof body.token === "string" ? body.token : "";
      }
    } catch { return Response.json({ ok: false, message: "That unsubscribe request is not valid." }, { status: 400, headers }); }
    const check = verifyUnsubscribeToken(token);
    if (!check.ok) return Response.json({ ok: false, reason: check.reason, message: "That unsubscribe link is not valid or is unavailable." }, { status: 400, headers });
    try {
      const result = await processEmailUnsubscribe(admin(), { ownerId: check.ownerId, email: check.email });
      if (!result.ok) throw new Error("unsubscribe_not_recorded");
      if (formPost) return new Response(null, { status: 200, headers });
      return Response.json({ ok: true, reason: result.reason, businessName: result.businessName, message: result.businessName ? `You're unsubscribed from ${result.businessName} marketing email.` : "You're unsubscribed from marketing email." }, { headers });
    } catch { return Response.json({ ok: false, reason: "processing_failed", message: "We couldn't record your request. Please retry or contact the sender." }, { status: 503, headers }); }
  };
}
