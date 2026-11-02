"use client";

/**
 * Onboarding, Brand Kit v2 (docs/brand-kit-v2-design.md, slices 3 to 7).
 *
 * Eleven screens, one topic each, with a per-screen Skip where the answer has
 * a safe default and no global Skip. Five answers are required: your name, the
 * description, the kind of business, the main goal and the automation level.
 * Everything is kept in the store until "Finish setup", which writes the
 * `businesses` row and brand kit version 1 in one go (lib/voom/mutations.ts).
 *
 * Screen 2, "Give MARA your brand" (slice 5): website, logo, product photos
 * and past posts, all optional. Files upload at once to the private bucket;
 * when image reading is configured MARA fills a line per image, marked as her
 * guess. The references are saved with the kit at Finish.
 *
 * "Send to MARA" on the description screen makes ONE structured AI read
 * (lib/brand/extract.ts). Every guess is prefilled into the screen that asks
 * for it, marked "MARA's guess", so each answer is confirmed exactly once:
 * there, or on the Brand Brief screen for the brief, offerings and facts
 * (facts she found wait as "Needs confirmation" until tapped). When the read
 * fails, is slow or finds nothing, the keyword guess picks the category as
 * before and the basics screen says so.
 *
 * "How you sound" (slice 6): after the personality chips, MARA writes three
 * captions from everything so far (lib/brand/voice.ts, 8 s wait); the owner
 * taps "Sounds like us" / "Not us" and only those are saved as voice samples.
 *
 * The website (slice 7): leaving screen 2 with an address starts a read in
 * the background (lib/brand/website-actions.ts: the site's text plus one look
 * at a homepage screenshot). "Send to MARA" waits for it briefly and sends
 * the description and the site's text together; the site's colours become
 * the website palette, used only when nothing else is.
 *
 * Look (Phase C of handover/merge-plan.md, 2026-11-02): the redesign's setup
 * layout from `main` (Figma "Setup", Batch 4A): sticky header with the step
 * list, a sticky intro column with the designers' artwork on large screens,
 * white answer cards with their 3D icons (components/voom/onboarding/onboardingIcons.tsx),
 * a light footer that clears the notifications, and main's `SetupComplete`
 * summary at the end. A finished account opening setup directly is sent on
 * by the wizard itself (`completedOnServer`), decided once at mount, so the
 * save's own revalidated render never tears the summary down.
 */
import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { BrandAssetsEditor } from "@/components/voom/brand/BrandAssetsEditor";
import { detectIndustry } from "@/lib/voom/demoData";
import { cx } from "@/lib/voom/cx";
import { brandLearnedIsEmpty } from "@/lib/brand/extract";
import { extractBrandDescription, type ExtractBrandResult } from "@/lib/brand/extract-actions";
import { checkWebsiteUrl, WEBSITE_READ_MESSAGES } from "@/lib/brand/website";
import { readBrandWebsiteLook, readBrandWebsiteText } from "@/lib/brand/website-actions";
import { emptyWebsiteRead } from "@/lib/voom/store";
import type { OnboardingWebsiteRead } from "@/lib/voom/types";
import { VOICE_SAMPLES_PER_LIST, voiceSnapshotFromSections, voiceSnapshotKey } from "@/lib/brand/voice";
import { requestVoiceSamples, sortSample, VoiceSampleCards, WritingSamplesPanel, type SampleVerdict } from "@/components/voom/brand/VoiceSamples";
import {
  AUTOMATION_CHOICES,
  OB_STEPS,
  OB_TONE,
  ONBOARDING_CHANNELS,
  Q_CUSTOMER,
  Q_FREQ,
  Q_GOAL,
  Q_INDUSTRY,
} from "@/lib/voom/onboardingData";
import { AVOID_RULES, type BrandSectionId, type BrandSectionValues } from "@/lib/brand/sections";
import { canUseAutomationMode, getPlanConfig } from "@/lib/billing/plans";
import { beginHapticGesture, haptic, type HapticGesture } from "@/lib/voom/haptics";
import { BrandHub } from "@/components/voom/brand/BrandHub";
import { Icon } from "../icons";
import { ChannelGlyph } from "../redesign/ui";
import { VoomLogo } from "../shell/VoomLogo";
import { Btn, Orb, Tag } from "../ui/primitives";
import { SetupComplete } from "./SetupComplete";
import { OnboardingIcon } from "./onboardingIcons";

export const LAST_STEP = OB_STEPS.length - 1;

/** Screen indices that other code refers to. */
const STEP_ASSETS = 1;
const STEP_DESCRIBE = 2;
const STEP_BASICS = 3;
const STEP_BRIEF = 9;

/** Screens whose answer has a safe default. Everything else must be answered. */
export const SKIPPABLE_STEPS: readonly number[] = [1, 5, 6, 7, 9, 10];

/** How long "Send to MARA" waits for the read before carrying on without it. */
export const EXTRACTION_WAIT_MS = 12_000;
/** How long "Send to MARA" waits for a website read still running (slice 7) before reading the description alone. */
export const WEBSITE_WAIT_MS = 20_000;
/** What a website text read resolved to, handed straight to the reading screen. */
type WebsiteOutcome = { status: "ready" | "failed" | "timeout"; reason: string };

/** The five required answers, by screen. Returns the message to show, or null when the screen may continue. */
export function stepBlocker(step: number, onboard: { displayName: string; desc: string; industry: string; goal: string; auto: string }): string | null {
  if (step === 0 && !onboard.displayName.trim()) return "Tell MARA what to call you";
  if (step === 2 && onboard.desc.trim().split(/\s+/).filter(Boolean).length < 5) return "Tell MARA a little more — a sentence or two";
  if (step === 3 && !onboard.industry) return "Pick the kind of business";
  if (step === 4 && !onboard.goal) return "Choose your main marketing goal";
  if (step === 8 && !onboard.auto) return "Choose how much MARA should do";
  return null;
}

/**
 * Each screen's title, intro line and artwork (the intro column). The artwork
 * is the reference's five panels (public/redesign/setup-art-*.webp), shared
 * between screens of the same kind.
 */
const INTRO: { title: string; text: string; art: string }[] = [
  { title: "What should MARA call you?", text: "This is how she'll greet you — nothing else changes because of it.", art: "mara" },
  { title: "Give MARA your brand", text: "Anything here saves you typing later. All optional: skip it and add images on your Brand page any time.", art: "voice" },
  { title: "Describe your brand in your own words.", text: "Write it however you'd explain it to a customer. MARA reads this before she asks anything else.", art: "voice" },
  { title: "The basics", text: "So MARA writes as you, not about you.", art: "business" },
  { title: "Who you serve, and why", text: "MARA uses these to choose the angle for every post.", art: "audience" },
  { title: "How you sound", text: "These shape the words MARA chooses. Skip it and she keeps a neutral tone until you tell her otherwise.", art: "voice" },
  { title: "What you DON'T want", text: "Hard rules MARA will never break. Tap what applies; add anything specific below.", art: "voice" },
  { title: "How often should MARA post?", text: "This sets how many slots MARA plans each week. You can change it any time.", art: "budget" },
  { title: "How much should MARA do?", text: "This decides what MARA does on her own. It is the one setting that changes what runs on a schedule.", art: "mara" },
  { title: "Your Brand Brief", text: "This is what MARA will work from, and your Brand page after setup. Edit anything that's off; add what you offer and the facts she may state.", art: "business" },
  { title: "Your channels", text: "Pick where MARA should plan content. Connect the accounts after setup; nothing is published anywhere until you approve it.", art: "voice" },
];

export function OnboardingWizard({ visionEnabled = false, completedOnServer = false }: { visionEnabled?: boolean; completedOnServer?: boolean } = {}) {
  const { onboard, onboardStep, igConnected, onboardSaving, onboardError } = useVoomState();
  const { setOnboardField, setOnboardStep, applyLearned, markLearnedFailed, applyWebsiteRead, applyWebsiteLook, applyWebsiteDescriptionDraft, finishOnboarding, toast, goTo } = useVoomActions();
  const [complete, setComplete] = useState<null | { skipped: boolean }>(null);
  const [reading, setReading] = useState(false);
  const router = useRouter();
  // What the server said when this wizard FIRST mounted. A finished account
  // opening setup directly is sent on to the app. Later re-renders — such as
  // the one the save action's revalidation triggers once onboarding_completed
  // turns true — must not redirect, or the completion summary never shows.
  const [finishedBeforeMount] = useState(completedOnServer);
  useEffect(() => {
    if (finishedBeforeMount) router.replace("/app");
  }, [finishedBeforeMount, router]);
  // The newest answers, for code that runs after an await.
  const latest = useRef(onboard);
  useEffect(() => { latest.current = onboard; });
  // The website read in flight (slice 7), resolving to its outcome, so the reading
  // screen and "Send to MARA" can wait for it. Its text is kept here too, because a
  // store update is not visible to code that resumes right after the await.
  const websiteRead = useRef<Promise<WebsiteOutcome> | null>(null);
  const websiteText = useRef<{ url: string; text: string; fetchedAt: string } | null>(null);

  const st = onboardStep;
  const words = onboard.desc.trim().split(/\s+/).filter(Boolean).length;

  /**
   * Slice 7: reading the website starts when the owner leaves "Give MARA your
   * brand" with an address typed, in the background. The same address is not
   * read twice; a changed address is. The outcome lands in the store, and the
   * site's colours become the website palette.
   */
  /**
   * Starts the two reads side by side and returns the text read's promise
   * (the look lands in the background). Null when nothing needs reading:
   * no address, or the same address already read.
   */
  function startWebsiteRead(force = false): Promise<WebsiteOutcome> | null {
    const typed = onboard.site.trim();
    const check = typed ? checkWebsiteUrl(typed) : null;
    if (!check) {
      if (onboard.website.status) applyWebsiteRead(emptyWebsiteRead(), null);
      return null;
    }
    const url = check.ok ? check.url.href : typed;
    const current = onboard.website;
    if (current.url === url && current.status === "reading" && websiteRead.current) return websiteRead.current;
    if (!force && current.url === url && current.status === "ready") return null;
    if (!check.ok) {
      applyWebsiteRead({ ...emptyWebsiteRead(), url, status: "failed", reason: WEBSITE_READ_MESSAGES.refused }, null);
      return null;
    }
    applyWebsiteRead({ ...emptyWebsiteRead(), url, status: "reading" }, null);
    websiteText.current = null;
    const failed = (reason: string): WebsiteOutcome => {
      applyWebsiteRead({ ...emptyWebsiteRead(), url, status: "failed", reason }, null);
      return { status: "failed", reason };
    };
    const text: Promise<WebsiteOutcome> = readBrandWebsiteText(url)
      .then((result): WebsiteOutcome => {
        if (!result.ok) {
          return failed(result.reason === "login" ? "You're signed out. Log in again to read the site." : result.reason === "rate_limited" ? "MARA has read websites ten times for you in the last hour, which is the limit. Wait a while and try again, or write the description yourself." : WEBSITE_READ_MESSAGES[result.reason]);
        }
        websiteText.current = { url, text: result.text, fetchedAt: result.fetchedAt };
        applyWebsiteRead({ url, status: "ready", reason: "", text: result.text, pageTitles: result.pageTitles, fetchedAt: result.fetchedAt, look: null, lookStatus: "" }, null);
        // The site's own words fill the description box while it is still empty.
        applyWebsiteDescriptionDraft(result.descriptionDraft);
        return { status: "ready", reason: "" };
      })
      .catch(() => failed(WEBSITE_READ_MESSAGES.unreachable))
      .finally(() => { websiteRead.current = null; });
    websiteRead.current = text;
    startWebsiteLook(url);
    return text;
  }

  /** The homepage look on its own: started with every read, and again from "Try the look again". */
  function startWebsiteLook(url: string) {
    applyWebsiteLook(url, null, "", null);
    void readBrandWebsiteLook(url)
      .then((result) => {
        if (!result.ok) {
          applyWebsiteLook(url, null, result.reason === "off" ? "off" : "failed", null);
          return;
        }
        applyWebsiteLook(url, { look: result.look.look, styleTags: result.look.styleTags, subject: result.look.subject }, "ready", { primary: result.look.primary, secondary: result.look.secondary });
      })
      .catch(() => applyWebsiteLook(url, null, "failed", null));
  }

  /**
   * Leaving screen 2 (Continue or Skip): an address not yet read starts its
   * read in the background, and the description screen shows the read's
   * state (the draft arrives there; a failure offers "Try reading again" and
   * "Back to the website"). Nothing holds the owner on a waiting screen.
   */
  function leaveAssets() {
    startWebsiteRead();
    setOnboardStep(STEP_DESCRIBE);
  }

  /**
   * One AI read per description text (and website read). The same input is
   * never sent twice (going back and forward reuses the result, or the
   * recorded failure); a slow, failed or empty read falls back to the keyword
   * category guess. Either way the next screen is the basics, prefilled
   * where she could. A website read still running is given a short wait.
   */
  async function sendToMara() {
    setReading(true);
    // A read still running (the owner came back and forward): the same wait as the reading screen's.
    if (websiteRead.current) {
      await Promise.race([websiteRead.current, new Promise((resolve) => setTimeout(resolve, WEBSITE_WAIT_MS))]);
    }
    const now = latest.current;
    const desc = now.desc.trim();
    // The text as the read handed it over (the store may lag by a render); only for the address still typed.
    const read = websiteText.current && websiteText.current.url === now.website.url ? websiteText.current : now.website.status === "ready" && now.website.text ? { url: now.website.url, text: now.website.text, fetchedAt: now.website.fetchedAt } : null;
    const site = read ? { url: read.url, text: read.text } : null;
    const key = site ? `${desc}\n#website:${read!.fetchedAt}` : desc;
    if (now.learnedFor === key && (now.learned || now.learnedNote === "failed")) {
      setReading(false);
      setOnboardStep(STEP_BASICS);
      return;
    }
    const result = await Promise.race<ExtractBrandResult>([
      extractBrandDescription(desc, site).catch(() => ({ ok: false, reason: "unavailable" })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "unavailable" }), EXTRACTION_WAIT_MS)),
    ]);
    setReading(false);
    if (result.ok && !brandLearnedIsEmpty(result.learned)) {
      applyLearned(result.learned, key);
      setOnboardField("learnedWith", site ? "description+website" : "description");
    } else {
      markLearnedFailed(key);
      setOnboardField("learnedWith", "");
      if (!now.industry) {
        const detected = detectIndustry(desc);
        if (detected) setOnboardField("industry", detected);
      }
    }
    setOnboardStep(STEP_BASICS);
  }

  async function next() {
    // main's haptics (merged 2026-11-01): taken synchronously from the click that called
    // us, so a scripted or timer-generated click gets no vibration; a real one warns once.
    const gesture = beginHapticGesture();
    const blocker = stepBlocker(st, onboard);
    if (blocker) {
      toast(blocker, "err");
      haptic("warning", gesture);
      return;
    }
    if (st === STEP_ASSETS) {
      haptic("light", gesture);
      leaveAssets();
      return;
    }
    if (st === STEP_DESCRIBE) {
      haptic("light", gesture);
      await sendToMara();
      return;
    }
    if (st < LAST_STEP) {
      haptic("light", gesture);
      setOnboardStep(st + 1);
      return;
    }
    await finish(false, gesture);
  }

  function back() {
    if (st === 0) {
      goTo("dash");
      return;
    }
    setOnboardStep(st - 1);
  }

  async function skip() {
    if (!SKIPPABLE_STEPS.includes(st)) return;
    // Skipping the images screen with an address typed still reads the site: the field is optional, the read is free.
    if (st === STEP_ASSETS) {
      leaveAssets();
      return;
    }
    if (st < LAST_STEP) {
      setOnboardStep(st + 1);
      return;
    }
    await finish(false);
  }

  // There is no global Skip, so `skipped` is always false here; the parameter keeps the
  // save path's signature. Default gesture: evaluated synchronously when Skip's click calls us.
  async function finish(skipped: boolean, gesture: HapticGesture = beginHapticGesture()) {
    const ok = await finishOnboarding(skipped);
    haptic(ok ? "success" : "error", gesture);
    if (ok) setComplete({ skipped });
  }

  if (complete) return <SetupComplete skipped={complete.skipped} />;
  if (finishedBeforeMount) return null;

  const busy = onboardSaving || reading;
  const continueLabel = onboardSaving ? "Saving…" : reading ? "Reading…" : st === LAST_STEP ? "Finish setup" : st === STEP_DESCRIBE ? "Send to MARA" : st === STEP_BRIEF ? "Looks right" : "Continue";
  const intro = INTRO[st] ?? INTRO[0];

  return (
    <div className="voom-public flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-white/90 backdrop-blur-[12px]">
        <div className="flex h-[60px] items-center justify-between gap-3 px-4 sm:px-6 lg:h-[72px]">
          <VoomLogo size={28} />
          <ol className="hidden items-start gap-2 xl:flex" aria-label="Setup progress">
            {OB_STEPS.map((label, index) => (
              <li key={label} className="w-[74px] text-center" aria-current={index === st ? "step" : undefined} title={label}>
                <span className={cx("block h-[4px] rounded-full", index < st ? "bg-[#9a7cf6]" : index === st ? "bg-[linear-gradient(90deg,#8645fa,#b14cf0)]" : "bg-[var(--surface-3)]")} />
                <span className={cx("mt-1.5 block truncate text-[11px]", index === st ? "font-semibold text-[var(--brand)]" : "text-text-3")}>
                  {index < st && <Icon name="check" size={10} className="mr-0.5 inline align-[-1px]" />}
                  {index + 1}. {label}
                </span>
              </li>
            ))}
          </ol>
          <span className="text-[13px] text-text-2">
            Step {st + 1} of {OB_STEPS.length}
          </span>
        </div>
        <div className="h-[3px] bg-[var(--surface-3)] xl:hidden" aria-hidden="true">
          <div className="h-full bg-[linear-gradient(90deg,#8645fa,#b14cf0)] transition-all" style={{ width: `${((st + 1) / OB_STEPS.length) * 100}%` }} />
        </div>
      </header>

      <main className="voom-setup-wash relative flex-1">
        <div className="mx-auto grid w-full max-w-[1320px] gap-5 px-4 pb-8 pt-5 sm:gap-8 sm:px-6 sm:pt-6 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:gap-12 lg:px-10 lg:pb-6 lg:pt-10 xl:gap-14">
          <StepIntro index={st} title={intro.title} text={intro.text} art={intro.art} />
          <div className="min-w-0 pb-4">
            {onboardError && (
              <div role="alert" className="mb-5 rounded-[12px] border border-[var(--red)]/25 bg-[var(--red-soft)] px-4 py-3 text-[13.5px] text-[var(--red)]">
                {onboardError}
              </div>
            )}
            {st === 0 && <StepName />}
            {st === 1 && <StepAssets visionEnabled={visionEnabled} onRead={() => { void startWebsiteRead(true); }} onRetryLook={() => startWebsiteLook(latest.current.website.url)} />}
            {st === 2 && <StepDescribe words={words} reading={reading} onReadAgain={() => { void startWebsiteRead(true); }} onBackToWebsite={() => setOnboardStep(STEP_ASSETS)} />}
            {st === 3 && <StepBasics />}
            {st === 4 && <StepAudienceGoal />}
            {st === 5 && <StepVoice />}
            {st === 6 && <StepAvoid />}
            {st === 7 && <StepPace />}
            {st === 8 && <StepAutomation />}
            {st === 9 && <StepBrief />}
            {st === 10 && <StepChannels igConnected={igConnected} />}
          </div>
        </div>
      </main>

      {/* `data-toast-clearance` (main's toast system, merged 2026-11-01): notifications
          stack above this bar instead of covering Back, Skip and Continue. Continue
          stays the footer's last button (tests/motion-system.test.mjs clicks it). */}
      <footer data-toast-clearance className="sticky bottom-0 z-30 border-t border-[var(--line)] bg-white/95 backdrop-blur-[12px]">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <button type="button" onClick={back} disabled={onboardSaving || reading} className={QUIET_BTN}>
            <Icon name="back" size={16} /> Back
          </button>
          <div className="flex items-center gap-2">
            {SKIPPABLE_STEPS.includes(st) ? (
              <button type="button" onClick={() => void skip()} disabled={busy} className={QUIET_BTN}>
                Skip this step
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => void next()}
              disabled={busy}
              className="voom-create-btn inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px] font-semibold text-white shadow-[0_10px_22px_-14px_rgba(134,69,250,.9)] transition hover:brightness-[1.05] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)] focus-visible:ring-offset-1 disabled:cursor-not-allowed"
            >
              {continueLabel} {!busy && <Icon name="arrow" size={16} />}
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}

/* ── Shared looks (main's setup design) ─────────────────────────────────── */

const QUIET_BTN = "inline-flex h-11 items-center gap-2 rounded-[12px] border border-[var(--line)] bg-white px-4 text-[14px] font-semibold text-text transition hover:bg-[var(--surface-2)] disabled:opacity-60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)] focus-visible:ring-offset-1 disabled:cursor-not-allowed";
const FIELD = "h-12 w-full rounded-[12px] border border-[var(--line)] bg-white px-4 text-[14.5px] text-text outline-none transition placeholder:text-text-3 focus:border-[var(--brand-line)] focus:ring-4 focus:ring-[var(--brand-soft)]";
const AREA = "w-full resize-y rounded-[14px] border border-[var(--line)] bg-white px-4 py-3.5 text-[14.5px] leading-[1.65] text-text outline-none transition placeholder:text-text-3 focus:border-[var(--brand-line)] focus:ring-4 focus:ring-[var(--brand-soft)] disabled:opacity-60";
/** MARA's own notes: the panel with her orb. */
const MARA_PANEL = "rounded-[16px] border border-[#cfc4ff] bg-white/85 p-4";
/** A plain note (what happened, what to do). */
const NOTE = "rounded-[12px] border border-[var(--line)] bg-white/80 px-4 py-3 text-[13px] leading-relaxed text-text-2";
/** Something went wrong but the owner can carry on. */
const WARN = "rounded-[12px] border border-[var(--amber)]/30 bg-[var(--amber-soft)] px-4 py-3 text-[13px] leading-relaxed text-text-2";

/** The reference gives each answer icon its own pastel tile. */
const TINTS = ["bg-[#e8f3ff]", "bg-[#fff4e0]", "bg-[#ffece9]", "bg-[#e9f8ee]", "bg-[#f1ecff]", "bg-[#fff0f6]"];
const tint = (index: number) => TINTS[index % TINTS.length];

function StepIntro({ index, title, text, art }: { index: number; title: string; text: string; art: string }) {
  return (
    // On large screens this column is sticky and exactly as tall as the space
    // between the sticky header and the sticky footer: 73px header + 40px top
    // padding above, 24px bottom padding + 73px footer below (210px in all),
    // so it ends ~17px above the footer and adds no scroll of its own. The artwork
    // takes only what is left after the text, so on short screens it shrinks
    // — down to nothing — instead of sliding under the footer.
    <div className="min-w-0 lg:sticky lg:top-[112px] lg:flex lg:h-[calc(100dvh-210px)] lg:min-h-[220px] lg:flex-col lg:self-start">
      <span className="inline-flex w-fit shrink-0 rounded-full bg-[#ece8ff] px-3 py-1 text-[12px] font-semibold text-[#4b38c9]">Step {index + 1}</span>
      <h1 className="mt-3 shrink-0 text-[clamp(1.6rem,6vw,1.85rem)] font-bold leading-[1.1] tracking-[-0.035em] text-text lg:mt-4 lg:text-[clamp(1.9rem,2.6vw,2.35rem)]">{title}</h1>
      <p className="mt-2 max-w-[520px] shrink-0 text-[14px] leading-[1.6] text-text-2 lg:mt-3 lg:max-w-[300px] lg:text-[14.5px]">{text}</p>
      {/* Decorative: native 640×530 crop, never wider than 360px (≈1.8× density) nor taller than 300px. */}
      <div className="relative mt-6 hidden min-h-0 w-full max-w-[360px] flex-1 lg:block lg:max-h-[300px]">
        <Image
          src={`/redesign/setup-art-${art}.webp`}
          alt=""
          width={640}
          height={530}
          unoptimized
          priority
          className="absolute inset-0 h-full w-full select-none object-contain object-left-top"
        />
      </div>
    </div>
  );
}

function QBlock({ title, help, children }: { title: ReactNode; help?: ReactNode; children: ReactNode }) {
  return (
    <section className="mb-7 last:mb-0">
      <h2 className="text-[15px] font-semibold text-text">{title}</h2>
      {help && <p className="mt-1 text-[13px] text-text-2">{help}</p>}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** A selectable answer card: icon tile, label, optional hint, and a check or radio mark. */
function OptionCard({ active, onClick, icon, label, hint, extra, mark = "check", compact, tint, disabled, title }: {
  active: boolean; onClick: () => void; icon?: ReactNode; label: string; hint?: string; extra?: ReactNode;
  mark?: "check" | "radio" | "box"; compact?: boolean; tint?: string; disabled?: boolean; title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      disabled={disabled}
      title={title}
      data-haptic="light"
      className={cx(
        "relative flex w-full min-w-0 items-center gap-3 rounded-[14px] border bg-white text-left transition hover:border-[var(--brand-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)] disabled:cursor-not-allowed disabled:opacity-55 disabled:hover:border-[var(--line)]",
        compact ? "px-3.5 py-3 sm:py-3.5" : "px-4 py-3 sm:py-4",
        active ? "border-[#b9a8ff] bg-[#f5f2ff] shadow-[0_0_0_1px_#b9a8ff]" : "border-[var(--line)]",
      )}
    >
      {icon && <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-[12px] sm:h-11 sm:w-11", tint ?? "bg-[var(--surface-2)]")} aria-hidden="true">{icon}</span>}
      <span className="min-w-0 flex-1 pr-6">
        <span className="block text-[14px] font-semibold leading-snug text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-text-2">{hint}</span>}
        {extra && <span className="mt-2 block">{extra}</span>}
      </span>
      <Mark kind={mark} active={active} />
    </button>
  );
}

function Mark({ kind, active }: { kind: "check" | "radio" | "box"; active: boolean }) {
  const base = "absolute right-3 top-3 grid h-[18px] w-[18px] place-items-center";
  if (kind === "radio") {
    return <span className={cx(base, "rounded-full border-[1.5px]", active ? "border-[var(--brand)]" : "border-[var(--line-2)]")} aria-hidden="true">{active && <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />}</span>;
  }
  return (
    <span className={cx(base, kind === "box" ? "rounded-[5px]" : "rounded-full", "border-[1.5px]", active ? "border-[var(--brand)] bg-[var(--brand)] text-white" : "border-[var(--line-2)]")} aria-hidden="true">
      {active && <Icon name="check" size={11} />}
    </span>
  );
}

/** Centred radio tile with the icon on top (the reference's stacked layout, used for the pace). */
function TileChoice({ label, hint, active, onClick }: { label: string; hint?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      data-haptic="light"
      className={cx(
        "relative flex min-w-0 flex-col items-center rounded-[14px] border bg-white px-2.5 pb-3.5 pt-5 text-center transition sm:px-3 sm:pb-4 hover:border-[var(--brand-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
        active ? "border-[#b9a8ff] bg-[#f5f2ff] shadow-[0_0_0_1px_#b9a8ff]" : "border-[var(--line)]",
      )}
    >
      <span className="absolute left-3 top-3"><Mark kind="radio" active={active} /></span>
      <OnboardingIcon label={label} size={30} />
      <span className="mt-2.5 text-[13.5px] font-semibold leading-snug text-text sm:text-[14px]">{label}</span>
      {hint && <span className="mt-1 text-[12px] leading-snug text-text-2">{hint}</span>}
    </button>
  );
}

/** MARA speaking: her orb beside a short paragraph. */
function MaraNote({ children, role }: { children: ReactNode; role?: "status" }) {
  return (
    <div role={role} className={MARA_PANEL}>
      <div className="flex items-start gap-2.5">
        <Orb size="sm" className="mt-0.5" />
        <p className="text-[13.5px] leading-[1.6] text-text">{children}</p>
      </div>
    </div>
  );
}

/* ── Screens ────────────────────────────────────────────────────────────── */

/** The website read's state under the field on screen 2 (slice 7). */
function WebsiteReadStatus({ website, draftReady, onRetry, onRetryLook }: { website: OnboardingWebsiteRead; draftReady: boolean; onRetry: () => void; onRetryLook: () => void }) {
  if (website.status === "reading") return <span role="status" className="mt-1.5 block text-xs text-text-2">MARA is reading your site… carry on with your images meanwhile.</span>;
  if (website.status === "ready") {
    const pages = website.pageTitles.length || 1;
    return (
      <span role="status" className="mt-1.5 flex flex-wrap items-center gap-x-1 gap-y-1 text-xs text-text-2">
        <span>Read {pages} page{pages === 1 ? "" : "s"}.{draftReady ? " Drafted your description for the next screen." : ""}</span>
        {website.lookStatus === "ready" ? <span>Took one look at the homepage: its colours are under your logo.</span> : null}
        {website.lookStatus === "" ? <span>Looking at the homepage for its colours…</span> : null}
        {website.lookStatus === "failed" ? <><span className="text-[var(--amber)]">Couldn&apos;t take a look at the homepage for its colours.</span><Btn variant="ghost" size="sm" onClick={onRetryLook}>Try the look again</Btn></> : null}
        {website.lookStatus === "off" ? <span>Image reading is off, so no colours from the site.</span> : null}
      </span>
    );
  }
  if (website.status === "failed") {
    return (
      <span role="alert" className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-[var(--amber)]">
        {website.reason}
        <Btn variant="ghost" size="sm" onClick={onRetry}>Try again</Btn>
      </span>
    );
  }
  return null;
}

function StepName() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <QBlock title="Your name" help="MARA uses it in greetings only.">
      <input
        className={cx(FIELD, "max-w-[460px]")}
        placeholder="e.g. Alex"
        autoFocus
        aria-label="Your name"
        value={onboard.displayName}
        onChange={(e) => setOnboardField("displayName", e.target.value)}
      />
    </QBlock>
  );
}

/** The reference's "Need inspiration?" prompts under the description box, each with its icon. */
const INSPIRATION = [
  "What you sell",
  "Your unique value",
  "Your target customers",
  "Your brand values",
  "Your story or inspiration",
  "What makes you different",
  "Online or offline presence",
  "Anything else",
];

function StepDescribe({ words, reading, onReadAgain, onBackToWebsite }: { words: number; reading: boolean; onReadAgain: () => void; onBackToWebsite: () => void }) {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  const site = onboard.website;
  return (
    <div className="max-w-[680px]">
      {site.status === "reading" ? (
        <p role="status" className={cx(MARA_PANEL, "mb-3 text-[13px] leading-relaxed text-text-2")}>
          <b className="text-text">MARA is reading your website…</b> the draft will appear here while the box is still empty. Write your own meanwhile if you prefer.
        </p>
      ) : site.status === "failed" ? (
        <div role="alert" className={cx(WARN, "mb-3")}>
          <b className="text-text">I couldn&apos;t read your website.</b> {site.reason}
          <span className="mt-2 flex flex-wrap gap-2">
            <Btn variant="outline" size="sm" onClick={onReadAgain}>Try reading again</Btn>
            <Btn variant="ghost" size="sm" onClick={onBackToWebsite}>Back to the website</Btn>
          </span>
        </div>
      ) : onboard.descFromWebsite ? (
        <p className={cx(NOTE, "mb-3")}>
          <b className="text-text">From your website.</b> Edit it or write your own.
        </p>
      ) : site.status === "ready" && !onboard.desc.trim() ? (
        <p className={cx(NOTE, "mb-3")}>
          <b className="text-text">Your website was read,</b> but MARA could not write a draft from it. Write a few lines yourself.
        </p>
      ) : null}
      <textarea
        rows={8}
        aria-label="Describe your brand"
        className={AREA}
        placeholder="For example: We're a small café near the marina. We roast our own beans, most of our customers are regulars who work nearby, and weekends are our busiest time. We want more people to know we do brunch."
        value={onboard.desc}
        disabled={reading}
        onChange={(e) => setOnboardField("desc", e.target.value)}
      />
      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <span className="text-[12.5px] text-text-3">
          <span>{words}</span> words — a few sentences is plenty
        </span>
        <span className="text-[12.5px] text-text-3">MARA reads it once and fills in what she can on the next screens.</span>
      </div>
      {reading ? (
        <div className="mt-4">
          <MaraNote role="status">
            <b>MARA is reading your description…</b> a few seconds at most. She fills in what she can and marks it as her guess for you to check.
          </MaraNote>
        </div>
      ) : null}
      <h3 className="mt-7 text-[14.5px] font-semibold text-text">Need inspiration? You can mention:</h3>
      <ul className="mt-3 flex flex-wrap gap-2">
        {INSPIRATION.map((label, index) => (
          <li key={label} className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3.5 py-2 text-[13px] text-text">
            <span className={cx("grid h-7 w-7 shrink-0 place-items-center rounded-full", tint(index))} aria-hidden="true"><OnboardingIcon label={label} size={18} /></span>{label}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** The help line under a prefilled question. */
const GUESS_HELP = "MARA's guess from your description is highlighted. Change it if she got it wrong.";
const GUESS_HELP_WEBSITE = "MARA's guess from your description and website is highlighted. Change it if she got it wrong.";
const guessHelp = (onboard: { learnedWith: string }) => (onboard.learnedWith === "description+website" ? GUESS_HELP_WEBSITE : GUESS_HELP);

/**
 * "Give MARA your brand" (slice 5). Everything optional. The website keeps its
 * one real use (the email link, saved through the email brand at Finish).
 */
function StepAssets({ visionEnabled, onRead, onRetryLook }: { visionEnabled: boolean; onRead: () => void; onRetryLook: () => void }) {
  const { onboard } = useVoomState();
  const { setOnboardField, addOnboardAsset, setOnboardAssetText, removeOnboardAsset } = useVoomActions();
  const site = onboard.website;
  const typed = onboard.site.trim();
  const check = typed ? checkWebsiteUrl(typed) : null;
  const readable = check?.ok === true;
  const readingThis = site.status === "reading";
  const readThis = site.status === "ready" && check?.ok === true && site.url === check.url.href;
  return (
    <div>
      <QBlock title={<>Website <span className="text-text-3">(optional)</span></>}>
        <div className="flex flex-wrap gap-2">
          <span className="relative min-w-[220px] flex-1">
            <Icon name="link" size={16} className="pointer-events-none absolute left-4 top-4 text-text-3" />
            <input
              className={cx(FIELD, "pl-11")}
              placeholder="https://yourbusiness.ae"
              inputMode="url"
              aria-label="Website"
              value={onboard.site}
              onChange={(e) => setOnboardField("site", e.target.value)}
            />
          </span>
          <button type="button" className={cx(QUIET_BTN, "h-12")} disabled={!readable || readingThis} onClick={onRead}>
            {readingThis ? "Reading…" : readThis ? "Read again" : "Read my website"}
          </button>
        </div>
        <span className="mt-2 block text-[12.5px] leading-relaxed text-text-3">
          MARA reads your public pages once, to understand what the business is and how it looks. Give it when you first set up, or again when the business or the site has changed. It is also the website link in your marketing emails (Settings → Email identity). Not read yet when you press Continue? She reads it in the background.
        </span>
        <WebsiteReadStatus website={site} draftReady={onboard.descFromWebsite} onRetry={onRead} onRetryLook={onRetryLook} />
      </QBlock>
      <div className="rounded-[18px] border border-[var(--line)] bg-white p-4 sm:p-5">
        <BrandAssetsEditor
          assets={onboard.assets}
          colours={onboard.colours}
          previews={onboard.assetPreviews}
          visionEnabled={visionEnabled}
          onAdd={addOnboardAsset}
          onText={setOnboardAssetText}
          onRemove={removeOnboardAsset}
          onColours={(colours) => setOnboardField("colours", colours)}
        />
      </div>
      {onboard.assets.some((asset) => asset.kind === "logo") || onboard.colours ? (
        <p className="mt-3 text-[12.5px] text-text-3">
          Your logo and colours also go to your marketing emails, unless you already set them in Settings → Email identity.
        </p>
      ) : null}
    </div>
  );
}

function StepBasics() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  const guessed = useMemo(
    () => onboard.fromMara.includes("category") || (Boolean(onboard.industry) && detectIndustry(onboard.desc) === onboard.industry),
    [onboard.desc, onboard.industry, onboard.fromMara],
  );
  return (
    <div>
      {onboard.learnedNote === "failed" ? (
        <p className={cx(NOTE, "mb-5")}>
          MARA couldn&apos;t read your description just now, so pick these yourself. Nothing else changes.
        </p>
      ) : onboard.learned ? (
        <div className="mb-5">
          <MaraNote>
            {onboard.learnedWith === "description+website"
              ? "I read your description and your website and filled in what I could, here and on the next screens. My guesses are marked; change anything I got wrong."
              : "I read your description and filled in what I could, here and on the next screens. My guesses are marked; change anything I got wrong."}
            {onboard.learnedWith !== "description+website" && (onboard.website.status === "failed" || onboard.website.status === "empty") ? ` I couldn't use your website: ${onboard.website.reason.replace(/, so MARA used your description only\.$/, ".")}` : ""}
            {onboard.learnedWith !== "description+website" && onboard.website.status === "reading" ? " Your website is still being read; it was not ready in time, so I used your description." : ""}
          </MaraNote>
        </div>
      ) : null}
      <QBlock title="1. What is your business name?" help="This will be used by MARA to personalise content ideas.">
        <input className={cx(FIELD, "max-w-[460px]")} placeholder="Your business name" aria-label="Business name" value={onboard.name} onChange={(e) => setOnboardField("name", e.target.value)} />
      </QBlock>
      <QBlock title="2. What kind of business is this?" help={guessed ? guessHelp(onboard) : "Pick the closest match."}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_INDUSTRY.map(([, name], index) => (
            <OptionCard key={name} tint={tint(index)} icon={<OnboardingIcon label={name} />} label={name} mark="radio" active={onboard.industry === name} onClick={() => setOnboardField("industry", name)} />
          ))}
        </div>
      </QBlock>
    </div>
  );
}

function StepAudienceGoal() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock title="1. Who is your target customer?" help={onboard.fromMara.includes("audience") ? guessHelp(onboard) : "Choose all that apply. Leave it empty and MARA writes for a broad audience."}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_CUSTOMER.map((c, index) => (
            <OptionCard key={c} tint={tint(index)} icon={<OnboardingIcon label={c} />} label={c} mark="box" compact active={onboard.customer.includes(c)} onClick={() => toggleOnboardArray("customer", c)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. What is your main marketing goal?" help={onboard.fromMara.includes("goal") ? guessHelp(onboard) : "Pick the one that matters most right now."}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_GOAL.map(([, name], index) => (
            <OptionCard key={name} tint={tint(index + 2)} icon={<OnboardingIcon label={name} />} label={name} mark="radio" compact active={onboard.goal === name} onClick={() => setOnboardField("goal", name)} />
          ))}
        </div>
      </QBlock>
    </div>
  );
}

const TONE_HINT: Record<string, string> = {
  Friendly: "Warm, approachable and friendly",
  Premium: "High-end, elegant and exclusive",
  Playful: "Fun, energetic and creative",
  Professional: "Trustworthy, expert and reliable",
  Bold: "Confident, strong and impactful",
  Calm: "Simple, clear and soothing",
  Traditional: "Classic, established and familiar",
  Modern: "Fresh, current and forward-looking",
};

/**
 * "How you sound" (slice 6): the personality chips, then three captions MARA
 * wrote from everything so far. One write per set of answers: opening the
 * screen again with the same answers shows the same captions (or the recorded
 * failure); "Try 3 more" always writes again. A failed or slow write leaves
 * the chips alone and says the samples will be on the Brand page.
 */
function StepVoice() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField, toast } = useVoomActions();
  const [writing, setWriting] = useState(false);
  // In flight, as a ref: a second call while one is running (StrictMode runs effects twice) must not spend a second read.
  const inFlight = useRef(false);
  const snapshot = useMemo(() => voiceSnapshotFromSections({
    basics: { name: onboard.name, description: onboard.desc, category: onboard.industry },
    brief: { brief: onboard.brief },
    offerings: { offerings: onboard.offerings },
    audience: { audience: onboard.customer, goal: onboard.goal },
    voice: { personality: onboard.tone, liked: onboard.liked, disliked: onboard.disliked },
    avoid: { rules: onboard.rules, words: onboard.words, notes: onboard.notes },
    facts: { facts: onboard.facts, unconfirmed: onboard.factsUnconfirmed },
  }), [onboard]);
  const key = voiceSnapshotKey(snapshot);
  const current = onboard.samplesFor === key && (onboard.samples.length > 0 || onboard.samplesNote !== "");

  async function write() {
    if (inFlight.current) return;
    inFlight.current = true;
    setWriting(true);
    const result = await requestVoiceSamples(snapshot);
    inFlight.current = false;
    setWriting(false);
    setOnboardField("samplesFor", key);
    if (result.ok) {
      setOnboardField("samples", result.samples);
      setOnboardField("samplesNote", "");
    } else {
      setOnboardField("samples", []);
      setOnboardField("samplesNote", result.reason === "not_configured" ? "off" : "failed");
    }
  }

  // The write starts when the screen opens, unless these answers already have their captions.
  useEffect(() => {
    if (!current) void write();
    // Only on opening the screen: later changes wait for "Try 3 more".
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function sort(sample: string, verdict: SampleVerdict) {
    const next = sortSample({ liked: onboard.liked, disliked: onboard.disliked }, sample, verdict);
    if (!next) {
      toast(`Up to ${VOICE_SAMPLES_PER_LIST} per list`, "err");
      return;
    }
    setOnboardField("liked", next.liked);
    setOnboardField("disliked", next.disliked);
  }

  return (
    <div>
      <QBlock title="1. What is your brand personality?" help={onboard.fromMara.includes("personality") ? `${guessHelp(onboard)} Up to three.` : `Choose up to three. ${onboard.tone.length} of 3 picked.`}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {OB_TONE.map((t, index) => (
            <OptionCard key={t} tint={tint(index + 1)} icon={<OnboardingIcon label={t} />} label={t} hint={TONE_HINT[t]} active={onboard.tone.includes(t)} onClick={() => toggleOnboardArray("tone", t, 3)} />
          ))}
        </div>
      </QBlock>
      {writing ? (
        <WritingSamplesPanel />
      ) : onboard.samples.length ? (
        <QBlock title="2. Three captions MARA wrote from what she knows so far" help="Tap what sounds like you and what doesn't. Nothing is used unless you say so.">
          <VoiceSampleCards samples={onboard.samples} liked={onboard.liked} disliked={onboard.disliked} onSort={sort} />
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-[12.5px] text-text-3">Kept so far: {onboard.liked.length} sound like you · {onboard.disliked.length} not you</span>
            <Btn variant="ghost" size="sm" onClick={() => void write()}>Try 3 more</Btn>
          </div>
        </QBlock>
      ) : onboard.samplesNote === "failed" ? (
        <div className={NOTE}>
          I couldn&apos;t write sample captions just now. I&apos;ll show you samples on your Brand page.
          <Btn variant="ghost" size="sm" className="ml-2" onClick={() => void write()}>Try again</Btn>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Free-text list input that keeps exactly what the user types (a trailing
 * comma or new line included) and reports the parsed list alongside.
 */
function ListInput({ value, separator, rows, placeholder, onChange }: { value: string[]; separator: "comma" | "line"; rows?: number; placeholder?: string; onChange: (next: string[]) => void }) {
  const [text, setText] = useState(value.join(separator === "line" ? "\n" : ", "));
  const handle = (raw: string) => {
    setText(raw);
    onChange((separator === "line" ? raw.split("\n") : raw.split(",")).map((part) => part.trim()).filter(Boolean));
  };
  return separator === "line"
    ? <textarea className={AREA} rows={rows ?? 3} value={text} placeholder={placeholder} onChange={(e) => handle(e.target.value)} />
    : <input className={FIELD} value={text} placeholder={placeholder} onChange={(e) => handle(e.target.value)} />;
}

function StepAvoid() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock title="1. Tap everything that applies">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {AVOID_RULES.map((rule) => (
            <OptionCard key={rule} label={rule} mark="box" compact active={onboard.rules.includes(rule)} onClick={() => toggleOnboardArray("rules", rule)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. Words, topics or emoji to ban" help="Comma-separated. MARA never uses them, in any casing.">
        <ListInput value={onboard.words} separator="comma" placeholder="cheap, discount, fire emoji" onChange={(words) => setOnboardField("words", words)} />
      </QBlock>
      <QBlock title="3. Anything specific MARA should know or do?" help="Optional. Facts she may state, things to always mention, how to sign off.">
        <textarea className={AREA} rows={3} value={onboard.notes} placeholder="For example: we're family-run, always say 'roastery' not 'coffee shop', never mention competitors." onChange={(e) => setOnboardField("notes", e.target.value)} />
      </QBlock>
    </div>
  );
}

const FREQ_HINT: Record<string, string> = {
  "A few times a month": "Keep a light presence",
  "2–3 times a week": "Recommended for steady growth",
  Daily: "Stay active and visible",
  "Multiple times a day": "For high-engagement brands",
};

function StepPace() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <QBlock title="Posting pace" help="2–3 times a week is preselected; skipping keeps it.">
      <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
        {Q_FREQ.map((v) => (
          <TileChoice key={v} label={v} hint={FREQ_HINT[v]} active={onboard.freq === v} onClick={() => setOnboardField("freq", v)} />
        ))}
      </div>
    </QBlock>
  );
}

function StepAutomation() {
  const { onboard, plan } = useVoomState();
  const { setOnboardField } = useVoomActions();
  const planName = getPlanConfig(plan).name;
  const chosen = AUTOMATION_CHOICES.find((choice) => choice.value === onboard.auto);
  const blocked = chosen ? !canUseAutomationMode(plan, chosen.value) : false;
  const fallback = plan === "pro" ? "Assisted" : "Manual";
  return (
    <div>
      <QBlock title="Choose a level" help={`You're on the ${planName} plan. Each card says which plan it needs.`}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {AUTOMATION_CHOICES.map((choice, index) => {
            const allowed = canUseAutomationMode(plan, choice.value);
            return (
              <OptionCard
                key={choice.value}
                tint={tint(index + 1)}
                icon={<OnboardingIcon label={choice.title} />}
                label={choice.title}
                hint={choice.sub}
                extra={<Tag tone={allowed ? "t-green" : "t-grey"}>{allowed ? "Included in your plan" : `Needs the ${choice.plan}`}</Tag>}
                mark="radio"
                active={onboard.auto === choice.value}
                onClick={() => setOnboardField("auto", choice.value)}
              />
            );
          })}
        </div>
      </QBlock>
      {blocked ? (
        <div className={WARN}>
          You&apos;re on the {planName} plan, so MARA runs <b className="text-text">{fallback}</b> until you upgrade. We&apos;ll remember that you wanted {chosen?.title}.
        </div>
      ) : null}
    </div>
  );
}

function StepBrief() {
  const { onboard, plan } = useVoomState();
  const { setOnboardField } = useVoomActions();
  const values: BrandSectionValues = useMemo(() => ({
    basics: { name: onboard.name, description: onboard.desc, category: onboard.industry },
    brief: { brief: onboard.brief },
    offerings: { offerings: onboard.offerings },
    audience: { audience: onboard.customer, goal: onboard.goal },
    voice: { personality: onboard.tone, liked: onboard.liked, disliked: onboard.disliked },
    avoid: { rules: onboard.rules, words: onboard.words, notes: onboard.notes },
    facts: { facts: onboard.facts, unconfirmed: onboard.factsUnconfirmed },
    // Not shown here (hub only): the images were confirmed on screen 2.
    assets: { assets: onboard.assets, colours: onboard.colours },
    operate: { pace: onboard.freq, channels: onboard.channels, ...(onboard.auto === "manual" || onboard.auto === "assisted" || onboard.auto === "autopilot" ? { automation: onboard.auto } : {}) },
  }), [onboard]);
  const drafted = onboard.fromMara.includes("brief") || onboard.fromMara.includes("offerings");

  function onLocalSave(id: BrandSectionId, saved: BrandSectionValues[BrandSectionId]) {
    switch (id) {
      case "basics": {
        const v = saved as BrandSectionValues["basics"];
        setOnboardField("name", v.name);
        setOnboardField("desc", v.description);
        setOnboardField("industry", v.category);
        return;
      }
      case "brief": setOnboardField("brief", (saved as BrandSectionValues["brief"]).brief); return;
      case "offerings": setOnboardField("offerings", (saved as BrandSectionValues["offerings"]).offerings); return;
      case "audience": {
        const v = saved as BrandSectionValues["audience"];
        setOnboardField("customer", v.audience);
        setOnboardField("goal", v.goal);
        return;
      }
      case "voice": {
        const v = saved as BrandSectionValues["voice"];
        setOnboardField("tone", v.personality);
        setOnboardField("liked", v.liked);
        setOnboardField("disliked", v.disliked);
        return;
      }
      case "avoid": {
        const v = saved as BrandSectionValues["avoid"];
        setOnboardField("rules", v.rules);
        setOnboardField("words", v.words);
        setOnboardField("notes", v.notes);
        return;
      }
      case "facts": {
        const v = saved as BrandSectionValues["facts"];
        setOnboardField("facts", v.facts);
        setOnboardField("factsUnconfirmed", v.unconfirmed);
        return;
      }
      default: return;
    }
  }

  return (
    <div>
      <div className="mb-5">
        <MaraNote>
          {drafted
            ? "I drafted the Brand Brief and what you offer from your description. Edit anything that's off; what you change here is what I'll work from."
            : "Write a few lines in the Brand Brief box or leave it, and I'll work from your description."}
          {onboard.factsUnconfirmed.length ? " Under Facts, tap Confirm on each claim that's true; I never state the others." : ""}
        </MaraNote>
      </div>
      <BrandHub
        mode="onboarding"
        persist="local"
        onLocalSave={onLocalSave}
        initialValues={values}
        history={[]}
        plan={plan}
        automation={onboard.auto === "manual" || onboard.auto === "autopilot" ? onboard.auto : "assisted"}
      />
    </div>
  );
}

/**
 * The last step tells the truth about where each channel connects. The
 * workspace only exists once "Finish setup" saves it, and every channel page
 * lives behind that gate — so no "Connect" button can work from inside the
 * wizard, and none is offered. Instagram and TikTok connect through their
 * own real authorization flows after setup. YouTube and Email stay available
 * to existing accounts in Settings and the Brand page; the new flow leads with
 * the two channels most small businesses start on.
 */
type ChannelStatus = { connected: boolean; configured: boolean };

const CHANNEL_STATUS_ENDPOINTS: Record<"instagram" | "tiktok", string> = {
  instagram: "/api/integrations/instagram/status",
  tiktok: "/api/integrations/tiktok/status",
};

function StepChannels({ igConnected }: { igConnected: boolean }) {
  const { onboard } = useVoomState();
  const { toggleOnboardArray } = useVoomActions();
  const [status, setStatus] = useState<Partial<Record<keyof typeof CHANNEL_STATUS_ENDPOINTS, ChannelStatus>>>({});

  useEffect(() => {
    let active = true;
    for (const [channel, endpoint] of Object.entries(CHANNEL_STATUS_ENDPOINTS) as [keyof typeof CHANNEL_STATUS_ENDPOINTS, string][]) {
      void fetch(endpoint, { cache: "no-store" })
        .then(async (response) => {
          if (!response.ok) return;
          const body = (await response.json()) as { connection?: { connected?: boolean; configured?: boolean } };
          if (!active || !body.connection) return;
          const next: ChannelStatus = { connected: Boolean(body.connection.connected), configured: Boolean(body.connection.configured) };
          setStatus((current) => ({ ...current, [channel]: next }));
        })
        .catch(() => { /* Unknown status is shown neutrally — never as connected. */ });
    }
    return () => { active = false; };
  }, []);

  const social: { key: keyof typeof CHANNEL_STATUS_ENDPOINTS; name: string; desc: string; page: string }[] = [
    { key: "instagram", name: "Instagram", desc: "Professional account · posts, Reels and Stories publish through your connected account.", page: "the Instagram page" },
    { key: "tiktok", name: "TikTok", desc: "Videos publish through Voom's durable TikTok queue — Published only after TikTok confirms.", page: "the TikTok page" },
  ];

  return (
    <div>
      <QBlock title="1. Which channels should MARA plan for?" help="Skip it and MARA plans nothing until you choose a channel on your Brand page.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {ONBOARDING_CHANNELS.map(({ label, available }) => (
            <OptionCard
              key={label}
              icon={<ChannelGlyph channel={label} size={26} />}
              label={label}
              hint={available ? undefined : "Coming soon"}
              title={available ? undefined : "Coming soon"}
              mark="box"
              compact
              disabled={!available}
              active={available && onboard.channels.includes(label)}
              onClick={() => toggleOnboardArray("channels", label)}
            />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. Where each one connects">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {social.map(({ key, name, desc, page }) => {
            const state = status[key];
            const connected = key === "instagram" ? igConnected || state?.connected === true : state?.connected === true;
            return (
              <div key={name} className="flex gap-4 rounded-[18px] border border-[var(--line)] bg-white p-5">
                <span className="grid h-14 w-14 shrink-0 place-items-center rounded-[16px] bg-[var(--surface-2)] shadow-[0_8px_18px_-12px_rgba(44,38,92,.45)]"><ChannelGlyph channel={key} size={34} /></span>
                <div className="min-w-0">
                  <b className="text-[16px] font-semibold text-text">{name}</b>
                  <p className="mt-1.5 text-[13px] leading-relaxed text-text-2">{desc}</p>
                  <div className="mt-3">
                    {connected ? (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--green-soft)] px-3 py-1 text-[12px] font-semibold text-[var(--green)]"><Icon name="check" size={12} /> Connected</span>
                    ) : state && !state.configured ? (
                      <span className="inline-flex rounded-full bg-[var(--amber-soft)] px-3 py-1 text-[12px] font-semibold text-[var(--amber)]">Not configured on this server yet</span>
                    ) : (
                      <span className="inline-flex rounded-[9px] border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium text-text-2">Connect after setup from {page}</span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </QBlock>
      <div className="flex items-start gap-3 rounded-[18px] border-[1.5px] border-[#c9a6f5] bg-white/85 p-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name="sparkles" size={17} /></span>
        <p className="text-[13.5px] leading-[1.6] text-text-2">
          <b className="font-semibold text-text">You can plan, draft and approve content before anything is connected.</b>{" "}
          Approval never publishes on its own — each channel reports Published only after the provider itself confirms.
        </p>
      </div>
    </div>
  );
}
