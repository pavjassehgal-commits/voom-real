import { notFound } from "next/navigation";
import { CreateSchedule } from "@/components/voom/create/CreateSchedule";
import { loadCreateDraft } from "@/lib/voom/create-draft";
import { readinessChecks } from "@/lib/voom/create-readiness";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Create · Step 3 · Schedule (Figma "25 — Create · Step 3 · Schedule" and "26 — Scheduled confirmation", Keep). */
export default async function CreateSchedulePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await getCurrentUser();
  if (!user) return null;
  const loaded = await loadCreateDraft(createAdminClient(), user.id, id);
  if (!loaded) notFound();
  return <CreateSchedule draft={loaded.draft} connected={loaded.connected} checks={readinessChecks(loaded.draft)} />;
}
