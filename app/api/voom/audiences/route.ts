import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import { listAudiences } from "@/lib/contacts/server-data";

export const dynamic = "force-dynamic";

// Lists the current user's audiences for the campaign audience picker.
// Owner-scoped through RLS plus the explicit owner filter; read-only.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Please log in again." }, { status: 401 });

  try {
    const db = await createClient();
    const result = await listAudiences(db, { owner_id: user.id, limit: 200 });
    if (!result.ok) {
      return NextResponse.json({ error: "Audiences couldn't load. Please retry." }, { status: 503 });
    }
    return NextResponse.json({ audiences: result.data }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "Audiences couldn't load. Please retry." }, { status: 503 });
  }
}
