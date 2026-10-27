"use client";

/**
 * Brand Kit v2, slice 6: the three sample captions MARA wrote, each with
 * "Sounds like us" / "Not us". Shared by the onboarding voice screen and the
 * Brand page's "How we sound" editor. The call itself is raced against a
 * short wait so a slow model never holds the screen.
 */
import { Btn, Orb } from "@/components/voom/ui/primitives";
import { writeBrandVoiceSamples, type VoiceSamplesReason, type VoiceSamplesResult } from "@/lib/brand/voice-actions";
import { VOICE_SAMPLES_PER_LIST, type BrandVoiceSnapshot } from "@/lib/brand/voice";

/** How long the screen waits for MARA's captions before carrying on without them. */
export const VOICE_WAIT_MS = 8_000;

export type SampleVerdict = "liked" | "disliked";

/** One call, with the wait. Never throws. */
export async function requestVoiceSamples(snapshot: BrandVoiceSnapshot): Promise<VoiceSamplesResult> {
  return Promise.race<VoiceSamplesResult>([
    writeBrandVoiceSamples(snapshot).catch(() => ({ ok: false, reason: "unavailable" })),
    new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "unavailable" }), VOICE_WAIT_MS)),
  ]);
}

/** What the screen says when there are no captions to show. */
export function voiceSamplesMessage(reason: VoiceSamplesReason): string {
  switch (reason) {
    case "not_configured": return "MARA's text model isn't set up, so she can't write samples here.";
    case "rate_limited": return "You've asked for samples a lot this hour. Try again a little later.";
    case "login": return "You're signed out. Log in again to get samples.";
    default: return "MARA couldn't write samples just now.";
  }
}

/**
 * Sorts one caption: the verdict adds it to that list (and removes it from
 * the other); the same verdict again removes it. Returns null when the list
 * is full, so the caller can say so.
 */
export function sortSample(lists: { liked: string[]; disliked: string[] }, sample: string, verdict: SampleVerdict): { liked: string[]; disliked: string[] } | null {
  const liked = lists.liked.filter((s) => s !== sample);
  const disliked = lists.disliked.filter((s) => s !== sample);
  const already = lists[verdict].includes(sample);
  if (already) return { liked, disliked };
  const target = verdict === "liked" ? liked : disliked;
  if (target.length >= VOICE_SAMPLES_PER_LIST) return null;
  target.push(sample);
  return { liked, disliked };
}

export function VoiceSampleCards({ samples, liked, disliked, disabled, onSort }: {
  samples: string[];
  liked: string[];
  disliked: string[];
  disabled?: boolean;
  onSort: (sample: string, verdict: SampleVerdict) => void;
}) {
  return (
    <ul className="space-y-2">
      {samples.map((sample) => {
        const isLiked = liked.includes(sample);
        const isDisliked = disliked.includes(sample);
        return (
          <li key={sample} className={`rounded-xl border p-3 ${isLiked ? "border-brand bg-[var(--brand-soft)]" : isDisliked ? "border-line bg-surface-2 opacity-70" : "border-line"}`}>
            <p className={`text-[13.5px] leading-relaxed ${isDisliked ? "line-through decoration-text-3" : ""}`}>{sample}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Btn variant={isLiked ? "primary" : "outline"} size="sm" disabled={disabled} aria-pressed={isLiked} onClick={() => onSort(sample, "liked")}>Sounds like us</Btn>
              <Btn variant={isDisliked ? "primary" : "outline"} size="sm" disabled={disabled} aria-pressed={isDisliked} onClick={() => onSort(sample, "disliked")}>Not us</Btn>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function WritingSamplesPanel() {
  return (
    <div role="status" className="rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
      <div className="flex items-start gap-2.5">
        <Orb size="sm" className="mt-0.5" />
        <p className="text-[13.5px] leading-[1.6]">
          <b>MARA is writing three captions in your voice…</b> a few seconds at most.
        </p>
      </div>
    </div>
  );
}
