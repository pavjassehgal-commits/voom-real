import { NextResponse } from "next/server";

import { getCurrentUser } from "@/lib/voom/server-data";
import { loadContactsPage } from "@/lib/contacts/load";
import type { ContactRecord, AudienceRecord } from "@/lib/contacts/types";

export const dynamic = "force-dynamic";

// Re-fetch the contacts/audiences page snapshot from the client workspace.
// Owner-scoped: if there is no session, returns 401.
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  const data = await loadContactsPage();
  if (!data) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

  return NextResponse.json({
    contacts: data.contacts as ContactRecord[],
    audiences: data.audiences as AudienceRecord[],
    audienceSizes: data.audienceSizes,
    summary: data.summary,
  });
}
