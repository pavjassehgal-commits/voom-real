import { isLinkedInOneShotStaging, readLinkedInConfig } from "@/lib/linkedin/config";
import { handleLinkedInOneShot } from "@/lib/linkedin/one-shot-http";
import { runLinkedInOneShot } from "@/lib/linkedin/one-shot";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export const maxDuration = 60;
export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return handleLinkedInOneShot(request, id, {
    enabled: isLinkedInOneShotStaging(),
    owner: async () => (await getCurrentUser())?.id ?? null,
    publish: async (ownerId, draftId, input) => {
      const config = readLinkedInConfig();
      if (!config) throw new Error("linkedin_not_configured");
      return runLinkedInOneShot(ownerId, draftId, input, { db: createAdminClient(), config });
    },
  });
}
