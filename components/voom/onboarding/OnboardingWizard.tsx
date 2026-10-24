"use client";

/**
 * Onboarding, Brand Kit v2 (docs/brand-kit-v2-design.md, slices 3 and 4).
 *
 * Ten screens, one topic each, with a per-screen Skip where the answer has a
 * safe default and no global Skip. Five answers are required: your name, the
 * description, the kind of business, the main goal and the automation level.
 * Everything is kept in the store until "Finish setup", which writes the
 * `businesses` row and brand kit version 1 in one go (lib/voom/mutations.ts).
 *
 * "Send to MARA" on the description screen makes ONE structured AI read
 * (lib/brand/extract.ts). Every guess is prefilled into the screen that asks
 * for it, marked "MARA's guess", so each answer is confirmed exactly once:
 * there, or on the Brand Brief screen for the brief, offerings and facts
 * (facts she found wait as "Needs confirmation" until tapped). When the read
 * fails, is slow or finds nothing, the keyword guess picks the category as
 * before and the basics screen says so.
 *
 * Still to come: uploads (slice 5) and sample captions (slice 6).
 */
import { useEffect, useMemo, useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { detectIndustry } from "@/lib/voom/demoData";
import { brandLearnedIsEmpty } from "@/lib/brand/extract";
import { extractBrandDescription, type ExtractBrandResult } from "@/lib/brand/extract-actions";
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
import { BrandHub } from "@/components/voom/brand/BrandHub";
import { Icon } from "../icons";
import { Btn, Chip, Input, Orb, Tag, Textarea } from "../ui/primitives";
import { AnalyzingScreen } from "./AnalyzingScreen";
import Logo from "@/app/components/Logo";

export const LAST_STEP = OB_STEPS.length - 1;

/** Screen indices that other code refers to. */
const STEP_DESCRIBE = 1;
const STEP_BASICS = 2;
const STEP_BRIEF = 8;

/** Screens whose answer has a safe default. Everything else must be answered. */
export const SKIPPABLE_STEPS: readonly number[] = [4, 5, 6, 8, 9];

/** How long "Send to MARA" waits for the read before carrying on without it. */
export const EXTRACTION_WAIT_MS = 12_000;

/** The five required answers, by screen. Returns the message to show, or null when the screen may continue. */
export function stepBlocker(step: number, onboard: { displayName: string; desc: string; industry: string; goal: string; auto: string }): string | null {
  if (step === 0 && !onboard.displayName.trim()) return "Tell MARA what to call you";
  if (step === 1 && onboard.desc.trim().split(/\s+/).filter(Boolean).length < 5) return "Tell MARA a little more — a sentence or two";
  if (step === 2 && !onboard.industry) return "Pick the kind of business";
  if (step === 3 && !onboard.goal) return "Choose your main marketing goal";
  if (step === 7 && !onboard.auto) return "Choose how much MARA should do";
  return null;
}

export function OnboardingWizard() {
  const { onboard, onboardStep, igConnected, onboardSaving, onboardError } = useVoomState();
  const { setOnboardField, setOnboardStep, applyLearned, markLearnedFailed, finishOnboarding, toast, goTo } = useVoomActions();
  const [analyzing, setAnalyzing] = useState(false);
  const [reading, setReading] = useState(false);

  const st = onboardStep;
  const words = onboard.desc.trim().split(/\s+/).filter(Boolean).length;

  /**
   * One AI read per description text. The same text is never sent twice
   * (going back and forward reuses the result, or the recorded failure); a
   * slow, failed or empty read falls back to the keyword category guess.
   * Either way the next screen is the basics, prefilled where she could.
   */
  async function sendToMara() {
    const desc = onboard.desc.trim();
    if (onboard.learnedFor === desc && (onboard.learned || onboard.learnedNote === "failed")) {
      setOnboardStep(STEP_BASICS);
      return;
    }
    setReading(true);
    const result = await Promise.race<ExtractBrandResult>([
      extractBrandDescription(desc).catch(() => ({ ok: false, reason: "unavailable" })),
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, reason: "unavailable" }), EXTRACTION_WAIT_MS)),
    ]);
    setReading(false);
    if (result.ok && !brandLearnedIsEmpty(result.learned)) {
      applyLearned(result.learned, desc);
    } else {
      markLearnedFailed(desc);
      if (!onboard.industry) {
        const detected = detectIndustry(desc);
        if (detected) setOnboardField("industry", detected);
      }
    }
    setOnboardStep(STEP_BASICS);
  }

  async function next() {
    const blocker = stepBlocker(st, onboard);
    if (blocker) {
      toast(blocker, "err");
      return;
    }
    if (st === STEP_DESCRIBE) {
      await sendToMara();
      return;
    }
    if (st < LAST_STEP) {
      setOnboardStep(st + 1);
      return;
    }
    await finish();
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
    if (st < LAST_STEP) {
      setOnboardStep(st + 1);
      return;
    }
    await finish();
  }

  async function finish() {
    const ok = await finishOnboarding(false);
    if (ok) setAnalyzing(true);
  }

  if (analyzing) {
    return <AnalyzingScreen onDone={() => goTo("dash")} />;
  }

  const busy = onboardSaving || reading;
  const continueLabel = onboardSaving ? "Saving…" : reading ? "Reading…" : st === LAST_STEP ? "Finish setup" : st === STEP_DESCRIBE ? "Send to MARA" : st === STEP_BRIEF ? "Looks right" : "Continue";

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-surface px-6 py-5">
        <Logo />
        <div className="hidden items-center gap-1.5 md:flex">
          {OB_STEPS.map((s, i) => (
            <div key={s} className={`h-[5px] rounded-full transition-all ${i <= st ? "voom-grad w-10" : "w-7 bg-surface-3"}`} title={s} />
          ))}
        </div>
        <span className="text-[13px] text-text-3">
          Step {st + 1} of {OB_STEPS.length}
        </span>
      </div>

      <div className="flex flex-1 items-start justify-center px-5 py-9">
        <div className="w-full max-w-[640px]">
          {onboardError && (
            <div role="alert" className="mb-5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">
              {onboardError}
            </div>
          )}
          {st === 0 && <StepName />}
          {st === 1 && <StepDescribe words={words} reading={reading} />}
          {st === 2 && <StepBasics />}
          {st === 3 && <StepAudienceGoal />}
          {st === 4 && <StepVoice />}
          {st === 5 && <StepAvoid />}
          {st === 6 && <StepPace />}
          {st === 7 && <StepAutomation />}
          {st === 8 && <StepBrief />}
          {st === 9 && <StepChannels igConnected={igConnected} />}
        </div>
      </div>

      <div className="sticky bottom-0 flex justify-between gap-3 border-t border-line bg-surface px-6 py-4">
        <Btn variant="ghost" onClick={back} disabled={busy}>
          <Icon name="back" size={16} /> Back
        </Btn>
        <div className="flex items-center gap-2">
          {SKIPPABLE_STEPS.includes(st) ? (
            <Btn variant="ghost" onClick={() => void skip()} disabled={busy}>
              Skip this step
            </Btn>
          ) : null}
          <Btn variant="primary" onClick={() => void next()} disabled={busy}>
            {continueLabel} {!busy && <Icon name="arrow" size={16} />}
          </Btn>
        </div>
      </div>
    </div>
  );
}

function Title({ children, sub }: { children: string; sub: string }) {
  return (
    <>
      <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[26px]">{children}</h1>
      <p className="my-2 text-[15px] text-text-2">{sub}</p>
    </>
  );
}

function StepName() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <Title sub="This is how she'll greet you — nothing else changes because of it.">What should MARA call you?</Title>
      <label className="mt-4 block">
        <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Your name</span>
        <input
          className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[15.5px]"
          placeholder="e.g. Alex"
          autoFocus
          value={onboard.displayName}
          onChange={(e) => setOnboardField("displayName", e.target.value)}
        />
      </label>
    </div>
  );
}

function QBlock({ title, help, children }: { title: string; help?: string; children: React.ReactNode }) {
  return (
    <div className="mb-6.5">
      <label className="mb-1 block text-[13.5px] font-semibold">{title}</label>
      {help ? <p className="mb-2.5 text-[12.5px] text-text-3">{help}</p> : <div className="h-2" />}
      {children}
    </div>
  );
}

function StepDescribe({ words, reading }: { words: number; reading: boolean }) {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <Title sub="Write it however you'd explain it to a customer. MARA reads this before she asks anything else.">Describe your brand in your own words.</Title>
      <Textarea
        rows={9}
        className="text-[15.5px] leading-[1.65]"
        placeholder="For example: We're a small café near the marina. We roast our own beans, most of our customers are regulars who work nearby, and weekends are our busiest time. We want more people to know we do brunch."
        value={onboard.desc}
        disabled={reading}
        onChange={(e) => setOnboardField("desc", e.target.value)}
      />
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-xs text-text-3">
          <span>{words}</span> words — a few sentences is plenty
        </span>
        <span className="text-xs text-text-3">MARA reads it once and fills in what she can on the next screens.</span>
      </div>
      {reading ? (
        <div role="status" className="mt-4 rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
          <div className="flex items-start gap-2.5">
            <Orb size="sm" className="mt-0.5" />
            <p className="text-[13.5px] leading-[1.6]">
              <b>MARA is reading your description…</b> a few seconds at most. She fills in what she can and marks it as her guess for you to check.
            </p>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** The help line under a prefilled question. */
const GUESS_HELP = "MARA's guess from your description is highlighted. Change it if she got it wrong.";

function AudienceChips({ selected, onToggle }: { selected: string[]; onToggle: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {Q_CUSTOMER.map((c) => (
        <Chip key={c} active={selected.includes(c)} onClick={() => onToggle(c)}>
          {c}
        </Chip>
      ))}
    </div>
  );
}

function GoalPicks({ value, onPick }: { value: string; onPick: (goal: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {Q_GOAL.map(([emoji, name]) => (
        <button
          key={name}
          onClick={() => onPick(name)}
          className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${value === name ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
        >
          <span className="mb-1.5 block text-[22px]">{emoji}</span>
          <b className="text-[13.5px]">{name}</b>
        </button>
      ))}
    </div>
  );
}

function ToneChips({ selected, onToggle }: { selected: string[]; onToggle: (value: string) => void }) {
  return (
    <div className="flex flex-wrap gap-2">
      {OB_TONE.map((t) => (
        <Chip key={t} active={selected.includes(t)} onClick={() => onToggle(t)}>
          {t}
        </Chip>
      ))}
    </div>
  );
}

function IndustryPicks() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
      {Q_INDUSTRY.map(([emoji, name]) => (
        <button
          key={name}
          onClick={() => setOnboardField("industry", name)}
          className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.industry === name ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
        >
          <span className="mb-1.5 block text-[22px]">{emoji}</span>
          <b className="text-[13.5px]">{name}</b>
        </button>
      ))}
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
      <Title sub="So MARA writes as you, not about you.">The basics</Title>
      {onboard.learnedNote === "failed" ? (
        <p className="mb-4 rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-text-2">
          MARA couldn&apos;t read your description just now, so pick these yourself. Nothing else changes.
        </p>
      ) : onboard.learned ? (
        <div className="mb-4 rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
          <div className="flex items-start gap-2.5">
            <Orb size="sm" className="mt-0.5" />
            <p className="text-[13.5px] leading-[1.6]">
              I read your description and filled in what I could, here and on the next screens. My guesses are marked; change anything I got wrong.
            </p>
          </div>
        </div>
      ) : null}
      <div className="mb-4 flex flex-wrap gap-3">
        <label className="min-w-[200px] flex-1">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Business name</span>
          <input
            className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]"
            placeholder="Your business name"
            value={onboard.name}
            onChange={(e) => setOnboardField("name", e.target.value)}
          />
        </label>
        <label className="min-w-[200px] flex-1">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">
            Website <span className="text-text-3">(optional)</span>
          </span>
          <input
            className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]"
            placeholder="https://yourbusiness.ae"
            inputMode="url"
            value={onboard.site}
            onChange={(e) => setOnboardField("site", e.target.value)}
          />
          <span className="mt-1.5 block text-xs text-text-3">
            Used in your marketing emails as the website link and default button destination. Change it any time in Settings → Email identity.
          </span>
        </label>
      </div>
      <QBlock title="What kind of business is this?" help={guessed ? GUESS_HELP : "Pick the closest match."}>
        <IndustryPicks />
      </QBlock>
    </div>
  );
}

function StepAudienceGoal() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField } = useVoomActions();
  return (
    <div>
      <Title sub="MARA uses these to choose the angle for every post.">Who you serve, and why</Title>
      <QBlock title="Who is your target customer?" help={onboard.fromMara.includes("audience") ? GUESS_HELP : "Choose all that apply. Leave it empty and MARA writes for a broad audience."}>
        <AudienceChips selected={onboard.customer} onToggle={(c) => toggleOnboardArray("customer", c)} />
      </QBlock>
      <QBlock title="What is your main marketing goal?" help={onboard.fromMara.includes("goal") ? GUESS_HELP : "Pick the one that matters most right now."}>
        <GoalPicks value={onboard.goal} onPick={(goal) => setOnboardField("goal", goal)} />
      </QBlock>
    </div>
  );
}

function StepVoice() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray } = useVoomActions();
  return (
    <div>
      <Title sub="These shape the words MARA chooses. Skip it and she keeps a neutral tone until you tell her otherwise.">How you sound</Title>
      <QBlock title="What is your brand personality?" help={onboard.fromMara.includes("personality") ? `${GUESS_HELP} Up to three.` : "Choose up to three."}>
        <ToneChips selected={onboard.tone} onToggle={(t) => toggleOnboardArray("tone", t, 3)} />
      </QBlock>
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
    ? <Textarea rows={rows ?? 3} value={text} placeholder={placeholder} onChange={(e) => handle(e.target.value)} />
    : <Input value={text} placeholder={placeholder} onChange={(e) => handle(e.target.value)} />;
}

function StepAvoid() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray, setOnboardField } = useVoomActions();
  return (
    <div>
      <Title sub="Hard rules MARA will never break. Tap what applies; add anything specific below.">What you DON&apos;T want</Title>
      <QBlock title="Tap everything that applies">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
          {AVOID_RULES.map((rule) => (
            <button
              key={rule}
              onClick={() => toggleOnboardArray("rules", rule)}
              className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.rules.includes(rule) ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
            >
              <b className="text-[13.5px]">{rule}</b>
            </button>
          ))}
        </div>
      </QBlock>
      <QBlock title="Words, topics or emoji to ban" help="Comma-separated. MARA never uses them, in any casing.">
        <ListInput value={onboard.words} separator="comma" placeholder="cheap, discount, 🔥" onChange={(words) => setOnboardField("words", words)} />
      </QBlock>
      <QBlock title="Anything specific MARA should know or do?" help="Optional. Facts she may state, things to always mention, how to sign off.">
        <Textarea rows={3} value={onboard.notes} placeholder="For example: we're family-run, always say 'roastery' not 'coffee shop', never mention competitors." onChange={(e) => setOnboardField("notes", e.target.value)} />
      </QBlock>
    </div>
  );
}

function RadioTile({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button onClick={onClick} className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition ${active ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}>
      <span className="flex items-center gap-2.5">
        <span
          className="h-4 w-4 flex-none rounded-full border-2"
          style={{ borderColor: active ? "var(--brand)" : "var(--line-2)", background: active ? "var(--brand)" : "transparent", boxShadow: "inset 0 0 0 2.5px var(--surface)" }}
        />
        <b className="text-[13.5px]">{label}</b>
      </span>
    </button>
  );
}

function StepPace() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <Title sub="This sets how many slots MARA plans each week. You can change it any time.">How often should MARA post?</Title>
      <QBlock title="Posting pace" help="2–3 times a week is preselected; skipping keeps it.">
        <div className="flex flex-col gap-2">
          {Q_FREQ.map((v) => (
            <RadioTile key={v} label={v} active={onboard.freq === v} onClick={() => setOnboardField("freq", v)} />
          ))}
        </div>
      </QBlock>
    </div>
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
      <Title sub="This decides what MARA does on her own. It is the one setting that changes what runs on a schedule.">How much should MARA do?</Title>
      <QBlock title="Choose a level" help={`You're on the ${planName} plan. Each card says which plan it needs.`}>
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {AUTOMATION_CHOICES.map((choice) => {
            const allowed = canUseAutomationMode(plan, choice.value);
            return (
              <button
                key={choice.value}
                onClick={() => setOnboardField("auto", choice.value)}
                className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.auto === choice.value ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
              >
                <span className="mb-1.5 block text-[22px]">{choice.emoji}</span>
                <b className="text-[13.5px]">{choice.title}</b>
                <span className="mt-0.5 block text-[11.5px] text-text-3">{choice.sub}</span>
                <span className="mt-2 block"><Tag tone={allowed ? "t-green" : "t-grey"}>{allowed ? "Included in your plan" : `Needs the ${choice.plan}`}</Tag></span>
              </button>
            );
          })}
        </div>
      </QBlock>
      {blocked ? (
        <div className="rounded-2xl border border-amber/35 bg-amber/10 p-4 text-[13px] leading-relaxed text-text-2">
          You&apos;re on the {planName} plan, so MARA runs <b>{fallback}</b> until you upgrade. We&apos;ll remember that you wanted {chosen?.title}.
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
    voice: { personality: onboard.tone, liked: [], disliked: [] },
    avoid: { rules: onboard.rules, words: onboard.words, notes: onboard.notes },
    facts: { facts: onboard.facts, unconfirmed: onboard.factsUnconfirmed },
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
      case "voice": setOnboardField("tone", (saved as BrandSectionValues["voice"]).personality); return;
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
      <Title sub="This is what MARA will work from, and your Brand page after setup. Edit anything that's off; add what you offer and the facts she may state.">Your Brand Brief</Title>
      <div className="mb-4 rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
        <div className="flex items-start gap-2.5">
          <Orb size="sm" className="mt-0.5" />
          <p className="text-[13.5px] leading-[1.6]">
            {drafted
              ? "I drafted the Brand Brief and what you offer from your description. Edit anything that's off; what you change here is what I'll work from."
              : "Write a few lines in the Brand Brief box or leave it, and I'll work from your description."}
            {onboard.factsUnconfirmed.length ? " Under Facts, tap Confirm on each claim that's true; I never state the others." : ""}
          </p>
        </div>
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

  const social: { key: keyof typeof CHANNEL_STATUS_ENDPOINTS; icon: string; name: string; desc: string; page: string; background: string }[] = [
    { key: "instagram", icon: "ig", name: "Instagram", desc: "Professional account · posts, Reels and Stories publish through your connected account.", page: "the Instagram page", background: "linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)" },
    { key: "tiktok", icon: "film", name: "TikTok", desc: "Videos publish through Voom's durable TikTok queue — Published only after TikTok confirms.", page: "the TikTok page", background: "#010101" },
  ];

  return (
    <div>
      <Title sub="Pick where MARA should plan content. Connect the accounts after setup; nothing is published anywhere until you approve it.">Your channels</Title>
      <QBlock title="Which channels should MARA plan for?" help="Skip it and MARA plans nothing until you choose a channel on your Brand page.">
        <div className="flex flex-wrap gap-2">
          {ONBOARDING_CHANNELS.map(({ label, available }) => (
            available ? (
              <Chip key={label} active={onboard.channels.includes(label)} onClick={() => toggleOnboardArray("channels", label)}>
                {label}
              </Chip>
            ) : (
              <Chip key={label} disabled title="Coming soon">
                {label} · Coming soon
              </Chip>
            )
          ))}
        </div>
      </QBlock>
      {social.map(({ key, icon, name, desc, page, background }) => {
        const state = status[key];
        const connected = key === "instagram" ? igConnected || state?.connected === true : state?.connected === true;
        return (
          <div key={name} className="mb-2.5 flex items-center justify-between gap-3 rounded-[var(--r-lg)] border border-line bg-surface p-4">
            <div className="flex items-center gap-2.5">
              <div className="grid h-10 w-10 flex-none place-items-center rounded-xl text-white" style={{ background }}>
                <Icon name={icon} />
              </div>
              <div>
                <b className="text-[14px]">{name}</b>
                <div className="text-[12.5px] text-text-3">{desc}</div>
              </div>
            </div>
            {connected ? (
              <Tag tone="t-green"><Icon name="check" size={12} /> Connected</Tag>
            ) : state && !state.configured ? (
              <Tag tone="t-amber">Not configured on this server yet</Tag>
            ) : (
              <span className="flex-none text-right text-[12px] text-text-3">Connect after setup from {page}</span>
            )}
          </div>
        );
      })}
      <div className="mt-2.5 rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
        <div className="flex items-start gap-2.5">
          <Orb size="sm" className="mt-0.5" />
          <p className="text-[13.5px] leading-[1.6]">
            You can plan, draft and approve content before anything is connected. Approval never publishes on its own — each
            channel reports Published only after the provider itself confirms.
          </p>
        </div>
      </div>
    </div>
  );
}
