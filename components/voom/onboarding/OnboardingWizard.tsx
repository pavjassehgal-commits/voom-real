"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useEffect, useState, type ReactNode } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { detectIndustry } from "@/lib/voom/demoData";
import { cx } from "@/lib/voom/cx";
import {
  OB_TONE,
  Q_AUTO,
  Q_BUDGET,
  Q_CHANNELS,
  Q_CUSTOMER,
  Q_FREQ,
  Q_GOAL,
  Q_INDUSTRY,
  Q_PERM,
} from "@/lib/voom/onboardingData";
import { Icon } from "../icons";
import { ChannelGlyph } from "../redesign/ui";
import { VoomLogo } from "../shell/VoomLogo";
import { SetupComplete } from "./SetupComplete";

const LAST_STEP = 7;

/**
 * Setup — redesign Batch 4A (Figma "06–13 — Setup · Step 1–8", Keep).
 *
 * The reference draws the same eight questions in two different orders (its
 * Step 1 already ends in "Finish setup", and "How you sound" appears as both
 * Step 3 and Step 7), so the working order below is kept: every answer is
 * validated and saved exactly as before, and each step uses the reference's
 * layout, cards and artwork. Nothing is saved until Finish setup (or Skip).
 *
 * Artwork: each illustration is cropped at native resolution from the
 * reference's own panel export (public/redesign/setup-art-*.webp, 640×530) and
 * shown no wider than 360 CSS px, so it stays sharp; it sits under the step
 * intro on large screens and is left out on phones, where the form comes
 * first. The reference's channel artwork includes LinkedIn, which Voom does
 * not support, so it is not used.
 */
const STEPS: { label: string; art: string }[] = [
  { label: "Name", art: "mara" },
  { label: "Brand", art: "voice" },
  { label: "Business", art: "business" },
  { label: "Audience", art: "audience" },
  { label: "Voice", art: "voice" },
  { label: "Budget", art: "budget" },
  { label: "MARA", art: "mara" },
  { label: "Channels", art: "voice" },
];

export function OnboardingWizard({ completedOnServer = false }: { completedOnServer?: boolean }) {
  const { onboard, onboardStep, igConnected, onboardSaving, onboardError } = useVoomState();
  const { setOnboardField, setOnboardStep, finishOnboarding, toast, goTo } = useVoomActions();
  const [complete, setComplete] = useState<null | { skipped: boolean }>(null);
  const router = useRouter();
  // What the server said when this wizard FIRST mounted. A finished account
  // opening setup directly is sent on to the app. Later re-renders — such as
  // the one the save action's revalidation triggers once onboarding_completed
  // turns true — must not redirect, or the completion summary never shows.
  const [finishedBeforeMount] = useState(completedOnServer);
  useEffect(() => {
    if (finishedBeforeMount) router.replace("/app");
  }, [finishedBeforeMount, router]);

  const st = onboardStep;
  const words = onboard.desc.trim().split(/\s+/).filter(Boolean).length;

  async function next() {
    if (st === 0) {
      if (!onboard.displayName.trim()) {
        toast("Tell MARA what to call you", "err");
        return;
      }
      setOnboardStep(1);
      return;
    }
    if (st === 1) {
      if (words < 5) {
        toast("Tell MARA a little more — a sentence or two", "err");
        return;
      }
      if (!onboard.industry) {
        const detected = detectIndustry(onboard.desc);
        if (detected) setOnboardField("industry", detected);
      }
      setOnboardStep(2);
      return;
    }
    const need: Record<number, [string, string]> = {
      2: ["industry", "Pick the kind of business"],
      3: ["goal", "Choose your main marketing goal"],
      5: ["budget", "Choose a monthly budget"],
      6: ["auto", "Choose an automation level"],
    };
    if (need[st]) {
      const [field, msg] = need[st];
      if (!onboard[field as keyof typeof onboard]) {
        toast(msg, "err");
        return;
      }
    }
    if (st === 3 && !onboard.customer.length) {
      toast("Pick at least one target customer", "err");
      return;
    }
    if (st === 6 && !onboard.permission) {
      toast("Choose a publishing permission", "err");
      return;
    }
    if (st < LAST_STEP) {
      setOnboardStep(st + 1);
      return;
    }
    await finish(false);
  }

  async function finish(skipped: boolean) {
    if (!skipped && !onboard.displayName.trim()) {
      setOnboardStep(0);
      toast("Tell MARA what to call you", "err");
      return;
    }
    const ok = await finishOnboarding(skipped);
    if (ok) setComplete({ skipped });
  }

  if (complete) return <SetupComplete skipped={complete.skipped} />;
  if (finishedBeforeMount) return null;

  const step = STEPS[st] ?? STEPS[0];

  return (
    <div className="voom-public flex min-h-dvh flex-col">
      <header className="sticky top-0 z-30 border-b border-[var(--line)] bg-white/90 backdrop-blur-[12px]">
        <div className="flex h-[60px] items-center justify-between gap-3 px-4 sm:px-6 lg:h-[72px]">
          <VoomLogo size={28} />
          <ol className="hidden items-start gap-3 xl:flex" aria-label="Setup progress">
            {STEPS.map((item, index) => (
              <li key={item.label} className="w-[78px] text-center" aria-current={index === st ? "step" : undefined}>
                <span className={cx("block h-[4px] rounded-full", index < st ? "bg-[#9a7cf6]" : index === st ? "bg-[linear-gradient(90deg,#8645fa,#b14cf0)]" : "bg-[var(--surface-3)]")} />
                <span className={cx("mt-1.5 block truncate text-[11px]", index === st ? "font-semibold text-[var(--brand)]" : "text-text-3")}>
                  {index < st && <Icon name="check" size={10} className="mr-0.5 inline align-[-1px]" />}
                  {index + 1}. {item.label}
                </span>
              </li>
            ))}
          </ol>
          <div className="flex items-center gap-3">
            <span className="text-[13px] text-text-2"><span className="hidden sm:inline">Step </span>{st + 1} of {STEPS.length}</span>
            <button
              type="button"
              onClick={() => finish(true)}
              disabled={onboardSaving}
              className="h-9 rounded-[10px] border border-[var(--line)] bg-white px-3.5 text-[13px] font-semibold text-text transition hover:bg-[var(--surface-2)] disabled:opacity-60"
            >
              Skip
            </button>
          </div>
        </div>
        <div className="h-[3px] bg-[var(--surface-3)] xl:hidden" aria-hidden="true">
          <div className="h-full bg-[linear-gradient(90deg,#8645fa,#b14cf0)] transition-all" style={{ width: `${((st + 1) / STEPS.length) * 100}%` }} />
        </div>
      </header>

      <main className="voom-setup-wash relative flex-1">
        <div className="mx-auto grid w-full max-w-[1320px] gap-5 px-4 pb-8 pt-5 sm:gap-8 sm:px-6 sm:pt-6 lg:grid-cols-[minmax(240px,300px)_minmax(0,1fr)] lg:gap-12 lg:px-10 lg:pb-6 lg:pt-10 xl:gap-14">
          <StepIntro index={st} art={step.art} />
          <div className="min-w-0 pb-4">
            {onboardError && (
              <div role="alert" className="mb-5 rounded-[12px] border border-[var(--red)]/25 bg-[var(--red-soft)] px-4 py-3 text-[13.5px] text-[var(--red)]">
                {onboardError}
              </div>
            )}
            {st === 0 && <StepName />}
            {st === 1 && <StepDescribe words={words} />}
            {st === 2 && <StepBasics />}
            {st === 3 && <StepAudienceGoal />}
            {st === 4 && <StepVoiceChannels />}
            {st === 5 && <StepBudgetPace />}
            {st === 6 && <StepAutomation />}
            {st === 7 && <StepConnect igConnected={igConnected} />}
          </div>
        </div>
      </main>

      <footer className="sticky bottom-0 z-30 border-t border-[var(--line)] bg-white/95 backdrop-blur-[12px]">
        <div className="flex items-center justify-between gap-3 px-4 py-3.5 sm:px-6">
          <button
            type="button"
            onClick={() => (st === 0 ? goTo("dash") : setOnboardStep(st - 1))}
            disabled={onboardSaving}
            className="inline-flex h-11 items-center gap-2 rounded-[12px] border border-[var(--line)] bg-white px-4 text-[14px] font-semibold text-text transition hover:bg-[var(--surface-2)] disabled:opacity-60"
          >
            <Icon name="back" size={16} /> Back
          </button>
          <button
            type="button"
            onClick={next}
            disabled={onboardSaving}
            className="voom-create-btn inline-flex h-11 items-center gap-2 rounded-full px-6 text-[14px] font-semibold text-white shadow-[0_10px_22px_-14px_rgba(134,69,250,.9)] transition hover:brightness-[1.05] disabled:opacity-60"
          >
            {onboardSaving ? "Saving…" : st === LAST_STEP ? "Finish setup" : st === 1 ? "Send to MARA" : "Continue"}
            {!onboardSaving && <Icon name="arrow" size={16} />}
          </button>
        </div>
      </footer>
    </div>
  );
}

const INTRO: { title: string; text: string }[] = [
  { title: "What should MARA call you?", text: "This is how she'll greet you — nothing else changes because of it." },
  { title: "Describe your brand in your own words.", text: "Write it however you'd explain it to a customer. MARA reads this before she asks anything else." },
  { title: "Tell me about your business", text: "This helps MARA understand your industry and tailor content ideas that fit your business." },
  { title: "Who you serve, and why", text: "Two questions. MARA uses these to choose the angle for every post." },
  { title: "How you sound, and where", text: "Voice and channels — these shape the words and the format." },
  { title: "Budget and pace", text: "This sets how much MARA plans — and how often she asks you for things." },
  { title: "How much should MARA do?", text: "You can change both of these at any time in Settings." },
  { title: "Your channels", text: "Finish setup to create your workspace, then connect each channel from its own page." },
];

function StepIntro({ index, art }: { index: number; art: string }) {
  const intro = INTRO[index] ?? INTRO[0];
  return (
    // On large screens this column is sticky and exactly as tall as the space
    // between the sticky header and the sticky footer: 73px header + 40px top
    // padding above, 24px bottom padding + 73px footer below (210px in all),
    // so it ends ~17px above the footer and adds no scroll of its own. The artwork
    // takes only what is left after the text, so on short screens it shrinks
    // — down to nothing — instead of sliding under the footer.
    <div className="min-w-0 lg:sticky lg:top-[112px] lg:flex lg:h-[calc(100dvh-210px)] lg:min-h-[220px] lg:flex-col lg:self-start">
      <span className="inline-flex w-fit shrink-0 rounded-full bg-[#ece8ff] px-3 py-1 text-[12px] font-semibold text-[#4b38c9]">Step {index + 1}</span>
      <h1 className="mt-3 shrink-0 text-[clamp(1.6rem,6vw,1.85rem)] font-bold leading-[1.1] tracking-[-0.035em] text-text lg:mt-4 lg:text-[clamp(1.9rem,2.6vw,2.35rem)]">{intro.title}</h1>
      <p className="mt-2 max-w-[520px] shrink-0 text-[14px] leading-[1.6] text-text-2 lg:mt-3 lg:max-w-[300px] lg:text-[14.5px]">{intro.text}</p>
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
function OptionCard({ active, onClick, icon, label, hint, mark = "check", compact, tint }: { active: boolean; onClick: () => void; icon?: ReactNode; label: string; hint?: string; mark?: "check" | "radio" | "box"; compact?: boolean; tint?: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "relative flex w-full min-w-0 items-center gap-3 rounded-[14px] border bg-white text-left transition hover:border-[var(--brand-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
        compact ? "px-3.5 py-3 sm:py-3.5" : "px-4 py-3 sm:py-4",
        active ? "border-[#b9a8ff] bg-[#f5f2ff] shadow-[0_0_0_1px_#b9a8ff]" : "border-[var(--line)]",
      )}
    >
      {icon && <span className={cx("grid h-10 w-10 shrink-0 place-items-center rounded-[12px] text-[19px] sm:h-11 sm:w-11 sm:text-[20px]", tint ?? "bg-[var(--surface-2)]")} aria-hidden="true">{icon}</span>}
      <span className="min-w-0 flex-1 pr-6">
        <span className="block text-[14px] font-semibold leading-snug text-text">{label}</span>
        {hint && <span className="mt-0.5 block text-[12.5px] leading-snug text-text-2">{hint}</span>}
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

/** The reference gives each answer icon its own pastel tile. */
const TINTS = ["bg-[#e8f3ff]", "bg-[#fff4e0]", "bg-[#ffece9]", "bg-[#e9f8ee]", "bg-[#f1ecff]", "bg-[#fff0f6]"];
const tint = (index: number) => TINTS[index % TINTS.length];

const FIELD = "h-12 w-full rounded-[12px] border border-[var(--line)] bg-white px-4 text-[14.5px] text-text outline-none transition placeholder:text-text-3 focus:border-[var(--brand-line)] focus:ring-4 focus:ring-[var(--brand-soft)]";

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

const INSPIRATION: [string, string][] = [
  ["🏷️", "What you sell"],
  ["🎯", "Your unique value"],
  ["👥", "Your target customers"],
  ["🌱", "Your brand values"],
  ["📖", "Your story or inspiration"],
  ["⭐", "What makes you different"],
  ["📍", "Online or offline presence"],
  ["➕", "Anything else"],
];

function StepDescribe({ words }: { words: number }) {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div className="max-w-[640px]">
      <h2 className="text-[19px] font-semibold tracking-[-0.01em] text-text">Tell MARA about your brand</h2>
      <p className="mt-1.5 text-[13.5px] leading-relaxed text-text-2">Include what you do, what makes you special, who your customers are and anything else that helps MARA understand your business.</p>
      <textarea
        rows={7}
        aria-label="Describe your brand"
        className="mt-4 w-full resize-y rounded-[14px] border border-[#cfc4ff] bg-white px-4 py-3.5 text-[14.5px] leading-[1.65] text-text outline-none transition placeholder:text-text-3 focus:border-[var(--brand-line)] focus:ring-4 focus:ring-[var(--brand-soft)]"
        placeholder="e.g. We are a small café near the marina. We roast our own beans, most of our customers are regulars who work nearby, and weekends are our busiest time."
        value={onboard.desc}
        onChange={(e) => setOnboardField("desc", e.target.value)}
      />
      <p className="mt-2 text-[12.5px] text-text-3">{words} word{words === 1 ? "" : "s"} — a few sentences is plenty</p>
      <h3 className="mt-7 text-[14.5px] font-semibold text-text">Need inspiration? You can mention:</h3>
      <ul className="mt-3 flex flex-wrap gap-2">
        {INSPIRATION.map(([emoji, label]) => (
          <li key={label} className="inline-flex items-center gap-2 rounded-full border border-[var(--line)] bg-white px-3.5 py-2 text-[13px] text-text">
            <span aria-hidden="true">{emoji}</span>{label}
          </li>
        ))}
      </ul>
    </div>
  );
}

function StepBasics() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock title="1. What kind of business is this?" help="Pick the closest match.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_INDUSTRY.map(([emoji, name], index) => (
            <OptionCard key={name} tint={tint(index)} icon={emoji} label={name} active={onboard.industry === name} onClick={() => setOnboardField("industry", name)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. What is your business name?" help="This will be used by MARA to personalise content ideas.">
        <input className={FIELD} placeholder="Your business name" aria-label="Business name" value={onboard.name} onChange={(e) => setOnboardField("name", e.target.value)} />
      </QBlock>
      <QBlock title={<>3. Website <span className="text-text-3">(optional)</span></>} help="Used in your marketing emails as the website link and default button destination. Change it any time in Settings → Email identity.">
        <span className="relative block">
          <Icon name="link" size={16} className="pointer-events-none absolute left-4 top-4 text-text-3" />
          <input className={cx(FIELD, "pl-11")} placeholder="https://yourbusiness.com" inputMode="url" aria-label="Website" value={onboard.site} onChange={(e) => setOnboardField("site", e.target.value)} />
        </span>
      </QBlock>
    </div>
  );
}

const CUSTOMER_ICON: Record<string, string> = {
  "Local residents nearby": "📍",
  "Young adults (18–29)": "🔞",
  "Families with children": "👨‍👩‍👧",
  "Professionals (30–50)": "💼",
  "Tourists & visitors": "✈️",
  "Businesses (B2B)": "🏢",
  "Luxury / high-income": "👑",
  "Budget-conscious shoppers": "🛒",
};

function StepAudienceGoal() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock title="1. Who is your target customer?" help="Choose all that apply.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_CUSTOMER.map((c, index) => (
            <OptionCard key={c} tint={tint(index)} icon={CUSTOMER_ICON[c] ?? "👤"} label={c} mark="box" compact active={onboard.customer.includes(c)} onClick={() => toggleOnboardArray("customer", c)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. What is your main marketing goal?" help="Pick the one that matters most right now.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-3">
          {Q_GOAL.map(([emoji, name], index) => (
            <OptionCard key={name} tint={tint(index + 2)} icon={emoji} label={name} mark="radio" compact active={onboard.goal === name} onClick={() => setOnboardField("goal", name)} />
          ))}
        </div>
      </QBlock>
    </div>
  );
}

const TONE_DETAIL: Record<string, [string, string]> = {
  Friendly: ["😊", "Warm, approachable and friendly"],
  Premium: ["👑", "High-end, elegant and exclusive"],
  Playful: ["🎉", "Fun, energetic and creative"],
  Professional: ["🧑‍💼", "Trustworthy, expert and reliable"],
  Bold: ["⚡", "Confident, strong and impactful"],
  Calm: ["🍃", "Simple, clear and soothing"],
  Traditional: ["🌿", "Classic, established and familiar"],
  Modern: ["✨", "Fresh, current and forward-looking"],
};

const CHANNEL_KEY: Record<string, string> = { Instagram: "instagram", TikTok: "tiktok", YouTube: "youtube", Email: "email" };

function StepVoiceChannels() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray } = useVoomActions();
  return (
    <div>
      <QBlock title="1. What is your brand personality?" help={`Choose up to three. ${onboard.tone.length} of 3 picked.`}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 xl:grid-cols-4">
          {OB_TONE.map((t, index) => (
            <OptionCard key={t} tint={tint(index + 1)} icon={TONE_DETAIL[t]?.[0]} label={t} hint={TONE_DETAIL[t]?.[1]} active={onboard.tone.includes(t)} onClick={() => toggleOnboardArray("tone", t, 3)} />
          ))}
        </div>
      </QBlock>
      <QBlock
        title="2. Which channels should MARA plan for?"
        help="Voom publishes to Instagram, TikTok and YouTube through your connected accounts and sends email campaigns and flows. Choose all that apply."
      >
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {Q_CHANNELS.map((c) => (
            <OptionCard key={c} icon={<ChannelGlyph channel={CHANNEL_KEY[c] ?? c} size={26} />} label={c} compact active={onboard.channels.includes(c)} onClick={() => toggleOnboardArray("channels", c)} />
          ))}
        </div>
      </QBlock>
      <p className="mt-6 flex items-center gap-2.5 rounded-[12px] bg-white/70 px-4 py-3 text-[13px] text-text-2">
        <Icon name="info" size={16} className="shrink-0 text-text-3" /> You can change these any time in Settings.
      </p>
    </div>
  );
}

const BUDGET_HINT: Record<string, string> = {
  "AED 0 — organic only": "No paid advertising",
  "Under AED 1,000": "Good for getting started",
  "AED 1,000 – 3,000": "Steady growth and visibility",
  "AED 3,000 – 10,000": "Faster reach and more results",
  "AED 10,000+": "Scale with bigger impact",
};

const FREQ_HINT: Record<string, string> = {
  "A few times a month": "Keep a light presence",
  "2–3 times a week": "Recommended for steady growth",
  Daily: "Stay active and visible",
  "Multiple times a day": "For high-engagement brands",
};

function StepBudgetPace() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock
        title="1. What is your optional monthly paid-advertising budget?"
        help={<>This is separate from your Voom subscription. Choose AED 0 if you only want <span className="font-medium text-[var(--brand)]">organic marketing</span>.</>}
      >
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-5">
          {Q_BUDGET.map((v) => (
            <TileChoice key={v} icon="💰" label={v} hint={BUDGET_HINT[v]} active={onboard.budget === v} onClick={() => setOnboardField("budget", v)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. How often do you want to post?" help="MARA will create a content plan based on this.">
        <div className="grid grid-cols-2 gap-2.5 xl:grid-cols-4">
          {Q_FREQ.map((v) => (
            <TileChoice key={v} icon="📅" label={v} hint={FREQ_HINT[v]} active={onboard.freq === v} onClick={() => setOnboardField("freq", v)} />
          ))}
        </div>
      </QBlock>
      <p className="mt-6 flex items-start gap-2.5 rounded-[12px] bg-white/70 px-4 py-3 text-[13px] leading-relaxed text-text-2">
        <Icon name="info" size={16} className="mt-0.5 shrink-0 text-text-3" />
        Your Voom subscription pays for the software. Advertising budgets are optional and paid directly through your connected advertising account.
      </p>
    </div>
  );
}

/** Centred radio tile used for budget and pace (the reference's stacked layout). */
function TileChoice({ icon, label, hint, active, onClick }: { icon: string; label: string; hint?: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx(
        "relative flex min-w-0 flex-col items-center rounded-[14px] border bg-white px-2.5 pb-3.5 pt-5 text-center transition sm:px-3 sm:pb-4 hover:border-[var(--brand-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
        active ? "border-[#b9a8ff] bg-[#f5f2ff] shadow-[0_0_0_1px_#b9a8ff]" : "border-[var(--line)]",
      )}
    >
      <span className="absolute left-3 top-3"><RadioDot active={active} /></span>
      <span className="text-[26px] leading-none" aria-hidden="true">{icon}</span>
      <span className="mt-2.5 text-[13.5px] font-semibold leading-snug text-text sm:text-[14px]">{label}</span>
      {hint && <span className="mt-1 text-[12px] leading-snug text-text-2">{hint}</span>}
    </button>
  );
}

function RadioDot({ active }: { active: boolean }) {
  return <span className={cx("grid h-[18px] w-[18px] place-items-center rounded-full border-[1.5px]", active ? "border-[var(--brand)]" : "border-[var(--line-2)]")} aria-hidden="true">{active && <span className="h-2 w-2 rounded-full bg-[var(--brand)]" />}</span>;
}

function StepAutomation() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <QBlock title="1. What level of automation do you want?" help="Choose how much MARA should take care of for you.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {Q_AUTO.map(([emoji, name, sub], index) => (
            <OptionCard key={name} tint={tint(index + 1)} icon={emoji} label={name} hint={sub} mark="radio" active={onboard.auto === name} onClick={() => setOnboardField("auto", name)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="2. Must MARA ask permission before publishing?" help="Choose when MARA should ask for your approval.">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {Q_PERM.map(([emoji, name, sub]) => (
            <button
              key={name}
              type="button"
              onClick={() => setOnboardField("permission", name)}
              aria-pressed={onboard.permission === name}
              className={cx(
                "relative flex min-w-0 flex-col rounded-[14px] border bg-white p-4 text-left transition hover:border-[var(--brand-line)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
                onboard.permission === name ? "border-[#b9a8ff] bg-[#f5f2ff] shadow-[0_0_0_1px_#b9a8ff]" : "border-[var(--line)]",
              )}
            >
              <span className="absolute right-3 top-3"><RadioDot active={onboard.permission === name} /></span>
              <span className="grid h-10 w-10 place-items-center rounded-[11px] bg-[var(--surface-2)] text-[20px]" aria-hidden="true">{emoji}</span>
              <span className="mt-3 text-[14px] font-semibold leading-snug text-text">{name}</span>
              <span className="mt-1 text-[12.5px] leading-snug text-text-2">{sub}</span>
            </button>
          ))}
        </div>
      </QBlock>
    </div>
  );
}

/**
 * The last step tells the truth about where each channel connects. The
 * workspace only exists once "Finish setup" saves it, and every channel page
 * lives behind that gate — so no "Connect" button can work from inside the
 * wizard, and none is offered. Instagram, TikTok and YouTube connect through
 * their own real authorization flows after setup; email has no account to
 * connect at all — it is campaigns, automated flows and a sender identity
 * configured in Settings (the Voom-managed sender address is used until the
 * business verifies its own domain).
 */
type ChannelStatus = { connected: boolean; configured: boolean };

const CHANNEL_STATUS_ENDPOINTS: Record<"instagram" | "tiktok" | "youtube", string> = {
  instagram: "/api/integrations/instagram/status",
  tiktok: "/api/integrations/tiktok/status",
  youtube: "/api/integrations/youtube/status",
};

function StepConnect({ igConnected }: { igConnected: boolean }) {
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

  const channels: { key: keyof typeof CHANNEL_STATUS_ENDPOINTS | "email"; name: string; desc: string; after: string }[] = [
    { key: "instagram", name: "Instagram", desc: "Professional account · posts, Reels and Stories publish through your connected account.", after: "Connect after setup" },
    { key: "tiktok", name: "TikTok", desc: "Videos publish through Voom's durable TikTok queue — Published only after TikTok confirms.", after: "Connect after setup" },
    { key: "youtube", name: "YouTube", desc: "Shorts and full videos publish through Voom's durable YouTube queue — Published only after YouTube confirms.", after: "Connect after setup" },
    { key: "email", name: "Email", desc: "Campaigns and automated flows. There is no account to connect: set your sender name, sending address and domain in Settings → Email identity. Until your domain is verified, emails send from Voom's managed address with your business name shown.", after: "Set up in Settings" },
  ];

  return (
    <div>
      <p className="mb-4 max-w-[680px] text-[13.5px] leading-relaxed text-text-2">
        Every connection uses the provider&apos;s real authorization flow, and nothing is published anywhere until you approve it.
      </p>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {channels.map(({ key, name, desc, after }) => {
          const state = key === "email" ? undefined : status[key];
          const connected = key === "instagram" ? igConnected || state?.connected === true : state?.connected === true;
          return (
            <div key={name} className="flex gap-4 rounded-[18px] border border-[var(--line)] bg-white p-6">
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
                    <span className="inline-flex rounded-[9px] border border-[var(--line)] px-3 py-1.5 text-[12px] font-medium text-text-2">{after}</span>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-4 flex items-start gap-3 rounded-[18px] border-[1.5px] border-[#c9a6f5] bg-white/85 p-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full bg-[var(--brand-soft)] text-[var(--brand)]"><Icon name="sparkles" size={17} /></span>
        <p className="text-[13.5px] leading-[1.6] text-text-2">
          <b className="font-semibold text-text">You can plan, draft and approve content for every channel before anything is connected.</b>{" "}
          Approval never publishes on its own — each channel reports Published only after the provider itself confirms.
        </p>
      </div>
    </div>
  );
}
