import { z } from "zod";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { consumeAiRateLimit, rateLimitedResponse } from "@/lib/rate-limit";
import { sameOrigin } from "@/lib/linkedin/http";
import { loadNativePlanVideoDraft, nativeGenerationView, nativeVideoPorts, startNativePlanVideo } from "@/lib/social/video-generation";
import { latestVideoGeneration, buildVideoService } from "@/lib/mara/video-service";
import { advanceVideoGeneration } from "@/lib/mara/video-generation";
import { isActiveVideoState } from "@/lib/mara/video-job";

export const runtime = "nodejs";
export const maxDuration = 300;
const input = z.object({ token: z.uuid() }).strict();
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);
  if (!sameOrigin(request)) return json({ error: "That request was not valid." }, 403);
  const parsed = input.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return json({ error: "That request was not valid." }, 400);
  if (!await consumeAiRateLimit(user.id, "post_generate")) return rateLimitedResponse();
  try {
    const { id } = await params;
    const result = await startNativePlanVideo(createAdminClient(), user.id, id, parsed.data.token);
    return json(result, result.status);
  } catch { return json({ error: "Voom couldn't confirm generation. Retry the same request before starting another." }, 503); }
}

/** Only advances an already-paid job; cannot create or approve a job/post. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);
  try {
    const { id } = await params;
    const admin = createAdminClient();
    const draft = await loadNativePlanVideoDraft(admin, user.id, id);
    if (!draft) return json({ error: "That recommendation was not found." }, 404);
    let row = await latestVideoGeneration(admin, user.id, id);
    if (row && isActiveVideoState(row.status)) {
      const service = await buildVideoService(admin, user.id);
      if (service) {
        const advanced = await advanceVideoGeneration(nativeVideoPorts(admin, service.ports, row.id), user.id, row.id, draft.kind);
        if (advanced.ok) row = advanced.generation;
      }
    }
    return json({ generation: await nativeGenerationView(admin, row) });
  } catch { return json({ error: "Video status is temporarily unavailable. No new generation was started." }, 503); }
}
