/**
 * Preview endpoint: renders an email with the SAME deterministic renderer used
 * in production. Both desktop and mobile are the same document — the renderer's
 * single `@media` breakpoint makes it responsive — so the returned HTML embeds
 * a dual-frame harness only for viewing convenience; the email markup itself is
 * untouched renderer output.
 */

import { z } from "zod";

import { deriveEmailDesign } from "@/lib/branded-email/derive";
import { renderEmail } from "@/lib/branded-email/render";
import { loadEmailBrandProfile } from "@/lib/branded-email/brand";
import { loadResolvedSender } from "@/lib/branded-email/sender-server";
import { resolveCtaDestination } from "@/lib/branded-email/destinations";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const previewPayload = z.object({
  subject: z.string().trim().min(1).max(300),
  previewText: z.string().trim().max(500).optional(),
  body: z.string().trim().min(1).max(12000),
  cta: z.string().trim().max(80).optional(),
  ctaUrl: z.string().trim().max(500).optional(),
}).strict();

export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try { body = await request.json(); } catch { return Response.json({ error: "That preview is not valid." }, { status: 400 }); }
  const parsed = previewPayload.safeParse(body);
  if (!parsed.success) return Response.json({ error: "Check the preview content before rendering." }, { status: 400 });

  try {
    const admin = createAdminClient();
    const [brand, sender] = await Promise.all([
      loadEmailBrandProfile(admin, user.id),
      loadResolvedSender(admin, user.id, { businessName: null }),
    ]);

    const design = deriveEmailDesign({
      subject: parsed.data.subject,
      preheader: parsed.data.previewText ?? "",
      body: parsed.data.body,
      cta: parsed.data.cta ?? "",
      ctaUrl: parsed.data.ctaUrl ?? null,
      position: 0,
      kind: "campaign",
    });

    // Resolve the CTA destination through the SAME authority production uses:
    // a real CTA may only point at a supplied destination or the business's
    // own website. Nothing is invented for the preview.
    const destination = resolveCtaDestination({
      website: brand.website,
      siteUrl: null,
      campaignDestination: parsed.data.ctaUrl ?? null,
      allowedUrls: parsed.data.ctaUrl ? [parsed.data.ctaUrl] : [],
    });

    const cta = design.cta && destination.ctaUrl
      ? { label: design.cta.label, url: destination.ctaUrl }
      : null;

    const rendered = renderEmail({
      design,
      brand,
      cta,
      hero: null,
      personalization: { firstName: "Ada", recipientEmail: "ada@example.com" },
      unsubscribeUrl: null,
      unsubscribeText: `You are receiving this because you subscribed to email from ${brand.name}. Unsubscribe at any time:`,
      subject: parsed.data.subject,
    });

    return Response.json(
      { preview: { subject: rendered.subject, preheader: rendered.preheader, html: rendered.html, text: rendered.text, fromName: sender.fromName, fromAddress: sender.fromAddress } },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json({ error: "That preview is temporarily unavailable." }, { status: 503 });
  }
}
