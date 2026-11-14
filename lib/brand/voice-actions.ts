"use server";

/**
 * "Write 3 samples" (Brand Kit v2, slice 6): the server action behind the
 * sample captions on the voice screen and the Brand page. Logged-in users
 * only, one bucket in the existing limiter, one structured AI call. Every
 * failure comes back as a plain reason, never a thrown error. Nothing is
 * stored here: the captions the owner sorts are saved with the kit by the
 * screen's own save (Finish, or the section's Save).
 */
import { AiError, createAiProvider } from "@/lib/ai";
import { getCurrentUser } from "@/lib/voom/server-data";
import { consumeAiRateLimit } from "@/lib/rate-limit";
import { brandVoiceSnapshotSchema, writeVoiceSamples } from "./voice";

export type VoiceSamplesReason = "login" | "invalid" | "rate_limited" | "not_configured" | "unavailable";

export type VoiceSamplesResult =
  | { ok: true; samples: string[] }
  | { ok: false; reason: VoiceSamplesReason };

export async function writeBrandVoiceSamples(input: unknown): Promise<VoiceSamplesResult> {
  const user = await getCurrentUser();
  if (!user) return { ok: false, reason: "login" };

  const parsed = brandVoiceSnapshotSchema.safeParse(input);
  if (!parsed.success) return { ok: false, reason: "invalid" };

  // Checked before the limiter, so an account without a text model spends nothing.
  let provider: ReturnType<typeof createAiProvider>;
  try { provider = createAiProvider(); } catch { return { ok: false, reason: "not_configured" }; }

  if (!(await consumeAiRateLimit(user.id, "brand_voice"))) return { ok: false, reason: "rate_limited" };

  try {
    const samples = await writeVoiceSamples(provider, parsed.data);
    // Every caption dropped (banned words, copies): a failed write, never an empty success.
    if (!samples.length) return { ok: false, reason: "unavailable" };
    return { ok: true, samples };
  } catch (error) {
    const code = error instanceof AiError ? error.code : "unknown";
    // The message carries the provider's HTTP status or stage, never a key or the prompt.
    console.error("[brand-voice] failed", { code, message: error instanceof Error ? error.message : String(error) });
    if (code === "not_configured") return { ok: false, reason: "not_configured" };
    if (code === "rate_limited") return { ok: false, reason: "rate_limited" };
    return { ok: false, reason: "unavailable" };
  }
}
