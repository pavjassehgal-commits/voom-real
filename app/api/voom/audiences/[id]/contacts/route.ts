import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { resolveAudienceContacts } from "@/lib/contacts/server-data";

export const dynamic = "force-dynamic";

// Returns the eligible contacts for an audience. Uses the same
// `resolveAudienceContacts` helper that powers the server UI, so the
// eligibility rules are never duplicated in the client.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!id) return NextResponse.json({ error: "Missing audience id" }, { status: 400 });

  const db = await createClient();
  const result = await resolveAudienceContacts(db, user.id, id);
  if (!result.ok) {
    if (result.error.code === "not_found") {
      return NextResponse.json({ error: "Audience not found" }, { status: 404 });
    }
    return NextResponse.json({ error: result.error.message }, { status: 400 });
  }
  return NextResponse.json({ contacts: result.data });
}
