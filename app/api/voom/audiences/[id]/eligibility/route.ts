import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { resolveAudienceChannelEligibility } from "@/lib/contacts/server-data";
import { toAudienceEligibilityPreview } from "@/lib/voom/campaign-delivery";

export const dynamic = "force-dynamic";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Channel-aware audience eligibility preview for the campaign editor.
 *
 * Eligibility is computed on the server from live contacts (email requires
 * subscribed + valid email; SMS requires subscribed + valid phone; unknown /
 * unsubscribed are excluded; duplicate destinations are deduped). The
 * response contains masked destinations only — the browser never receives a
 * raw recipient list. No sending happens here.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await ctx.params;
  if (!UUID_RE.test(id)) return NextResponse.json({ error: "Audience not found." }, { status: 404 });

  const kind = new URL(request.url).searchParams.get("kind");
  if (kind !== "email" && kind !== "sms") {
    return NextResponse.json({ error: "Choose a valid channel (email or sms) for the eligibility preview." }, { status: 400 });
  }

  try {
    const db = await createClient();
    const result = await resolveAudienceChannelEligibility(db, user.id, id, kind);
    if (!result.ok) {
      if (result.error.code === "not_found") {
        return NextResponse.json({ error: "Audience not found." }, { status: 404 });
      }
      return NextResponse.json({ error: result.error.message }, { status: 400 });
    }
    return NextResponse.json(
      { preview: toAudienceEligibilityPreview(result.data) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return NextResponse.json({ error: "Audience eligibility is temporarily unavailable." }, { status: 503 });
  }
}
