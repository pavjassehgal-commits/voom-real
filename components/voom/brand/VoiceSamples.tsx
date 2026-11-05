"use client";

/**
 * Brand Kit v2, slice 6: the three sample captions MARA wrote, each with
 * "Sounds like us" / "Not us". Shared by the onboarding voice screen and the
 * Brand page's "How we sound" editor. The call itself is raced against a
 * short wait so a slow model never holds the screen.
 *
 * Look (2026-11-04): white cards, the two verdicts as pills that fill soft
 * purple when chosen, a "Not us" caption struck through; MARA's mark on the
 * writing panel.
 */
import { Icon } from "@/components/voom/icons";
import { MaraMark } from "@/components/voom/redesign/MaraMark";
import { FORM } from "@/components/voom/redesign/ui";
import { cx } from "@/lib/voom/cx";
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

const VERDICT_BTN = "inline-flex h-9 items-center gap-1.5 rounded-full border px-3.5 text-[13px] font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)] disabled:cursor-not-allowed disabled:opacity-50";

export function VoiceSampleCards({ samples, liked, disliked, disabled, onSort }: {
  samples: string[];
  liked: string[];
  disliked: string[];
  disabled?: boolean;
  onSort: (sample: string, verdict: SampleVerdict) => void;
}) {
  return (
    <ul className="space-y-2.5">
      {samples.map((sample) => {
        const isLiked = liked.includes(sample);
        const isDisliked = disliked.includes(sample);
        return (
          <li key={sample} className={cx("rounded-[16px] border p-4 transition", isLiked ? "border-[var(--brand-line)] bg-[var(--brand-soft)] shadow-[0_0_0_1px_var(--brand-line)]" : isDisliked ? "border-line bg-surface-2" : "border-line bg-surface")}>
            <p className={cx("text-[14px] leading-relaxed", isDisliked ? "text-text-3 line-through decoration-text-3" : "text-text")}>{sample}</p>
            <div className="mt-3 flex flex-wrap gap-2">
              <button type="button" className={cx(VERDICT_BTN, isLiked ? "border-[var(--brand-line)] bg-surface text-[var(--brand-ink)]" : "border-line bg-surface text-text-2 hover:border-[var(--line-2)] hover:text-text")} disabled={disabled} aria-pressed={isLiked} onClick={() => onSort(sample, "liked")}>
                {isLiked && <Icon name="check" size={12} />} Sounds like us
              </button>
              <button type="button" className={cx(VERDICT_BTN, isDisliked ? "border-[var(--line-2)] bg-surface-3 text-text" : "border-line bg-surface text-text-2 hover:border-[var(--line-2)] hover:text-text")} disabled={disabled} aria-pressed={isDisliked} onClick={() => onSort(sample, "disliked")}>
                {isDisliked && <Icon name="x" size={12} />} Not us
              </button>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

export function WritingSamplesPanel() {
  return (
    <div role="status" className={cx(FORM.card, "border-[#cfc4ff]")}>
      <div className="flex items-start gap-3">
        <MaraMark height={22} className="mt-0.5" />
        <p className="text-[13.5px] leading-[1.6] text-text">
          <b>MARA is writing three captions in your voice…</b> a few seconds at most.
        </p>
      </div>
    </div>
  );
}
