import { notFound } from "next/navigation";
import { CreatePreview } from "@/components/voom/create/CreatePreview";
import { loadCreateDraft } from "@/lib/voom/create-draft";
import { readinessChecks } from "@/lib/voom/create-readiness";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Create · Step 2 · Preview (Figma "24 — Create · Step 2 · Preview per channel", Keep). */
export default async function CreatePreviewPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await getCurrentUser();
  if (!user) return null;
  const loaded = await loadCreateDraft(createAdminClient(), user.id, id);
  if (!loaded) notFound();
  return <CreatePreview draft={loaded.draft} connected={loaded.connected} checks={readinessChecks(loaded.draft)} />;
}
