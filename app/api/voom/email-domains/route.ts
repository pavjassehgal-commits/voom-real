import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createResendClient } from "@/lib/email/client";
import { beginDomainClaim, normalizeSendingDomain, ownershipName, ownershipValue, readDomainClaim, verifyDomainClaim } from "@/lib/email/domains";

export const runtime = "nodejs";
export const maxDuration = 90;
const payload = z.object({ action: z.enum(["begin", "verify"]), domain: z.string().min(4).max(253) }).strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });
  if (request.headers.get("origin") !== new URL(request.url).origin) return Response.json({ error: "Open domain setup from your VOOM workspace." }, { status: 403 });
  try {
    const parsed = payload.safeParse(await request.json());
    if (!parsed.success) return Response.json({ error: "Choose a valid sending domain." }, { status: 400 });
    const db = createAdminClient();
    const limited = await db.rpc("consume_rate_limit", { p_owner_user_id: user.id, p_bucket: "email_domain_setup", p_limit: 10, p_window_seconds: 3600 });
    if (limited.error || limited.data !== true) return Response.json({ error: "Domain setup is unavailable or rate-limited. Try later." }, { status: 429 });
    const domain = normalizeSendingDomain(parsed.data.domain);
    const claim = parsed.data.action === "begin"
      ? await beginDomainClaim(db, user.id, domain)
      : await readDomainClaim(db, user.id, domain);
    if (!claim) return Response.json({ error: "Start domain setup first." }, { status: 409 });
    const result = parsed.data.action === "verify"
      ? await verifyDomainClaim(db, user.id, domain, { client: createResendClient() })
      : { verified: false, records: [] };
    return Response.json({ domain, ownership: { type: "TXT", name: ownershipName(domain), value: ownershipValue(claim) }, ...result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const code = error instanceof Error ? error.message : "domain_setup_unavailable";
    const messages: Record<string, string> = {
      dns_ownership_not_verified: "Add the exact ownership TXT record to your DNS, then check again. No provider domain was changed.",
      domain_unavailable: "This domain cannot be claimed. It may belong to another workspace; contact support rather than creating another identity.",
      managed_domain_reserved: "VOOM's managed domain is reserved. Use a domain your business controls.",
      invalid_sending_domain: "Enter a domain such as updates.yourbusiness.com, without a URL or email address.",
    };
    return Response.json({ error: messages[code] ?? "Domain setup could not be completed. Keep your DNS records and retry verification later; do not change credentials." }, { status: 409 });
  }
}
