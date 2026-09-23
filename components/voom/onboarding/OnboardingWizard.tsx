"use client";

import { useEffect, useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { detectIndustry } from "@/lib/voom/demoData";
import {
  OB_STEPS,
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
import { Btn, Chip, Orb, Tag, Textarea } from "../ui/primitives";
import { AnalyzingScreen } from "./AnalyzingScreen";
import Logo from "@/app/components/Logo";

const LAST_STEP = 7;

export function OnboardingWizard() {
  const { onboard, onboardStep, igConnected, onboardSaving, onboardError } = useVoomState();
  const { setOnboardField, setOnboardStep, finishOnboarding, toast, goTo } = useVoomActions();
  const [analyzing, setAnalyzing] = useState(false);

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
    if (ok) setAnalyzing(true);
  }

  if (analyzing) {
    return <AnalyzingScreen onDone={() => goTo("dash")} />;
  }

  return (
    <div className="flex min-h-dvh flex-col bg-bg">
      <div className="flex items-center justify-between border-b border-line bg-surface px-6 py-5">
        <Logo />
        <div className="hidden items-center gap-2 md:flex">
          {OB_STEPS.map((s, i) => (
            <div key={s} className={`h-[5px] rounded-full transition-all ${i <= st ? "voom-grad w-16" : "w-11 bg-surface-3"}`} title={s} />
          ))}
        </div>
        <div className="flex items-center gap-2.5">
          <span className="text-[13px] text-text-3">
            Step {st + 1} of {OB_STEPS.length}
          </span>
          <Btn variant="ghost" size="sm" onClick={() => finish(true)} disabled={onboardSaving}>
            Skip
          </Btn>
        </div>
      </div>

      <div className="flex flex-1 items-center justify-center px-5 py-9">
        <div className="w-full max-w-[620px]">
          {onboardError && (
            <div role="alert" className="mb-5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">
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

      <div className="sticky bottom-0 flex justify-between gap-3 border-t border-line bg-surface px-6 py-4">
        <Btn variant="ghost" onClick={() => (st === 0 ? goTo("dash") : setOnboardStep(st - 1))} disabled={onboardSaving}>
          <Icon name="back" size={16} /> Back
        </Btn>
        <Btn variant="primary" onClick={next} disabled={onboardSaving}>
          {onboardSaving ? "Saving…" : st === LAST_STEP ? "Finish setup" : st === 1 ? "Send to MARA" : "Continue"}{" "}
          {!onboardSaving && <Icon name="arrow" size={16} />}
        </Btn>
      </div>
    </div>
  );
}

function StepName() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[26px]">What should MARA call you?</h1>
      <p className="my-2 text-[15px] text-text-2">This is how she&apos;ll greet you — nothing else changes because of it.</p>
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

function StepDescribe({ words }: { words: number }) {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight sm:text-[26px]">Describe your brand in your own words.</h1>
      <p className="my-2 text-[15px] text-text-2">Write it however you&apos;d explain it to a customer. MARA reads this before she asks anything else.</p>
      <Textarea
        rows={9}
        className="text-[15.5px] leading-[1.65]"
        placeholder="For example: We're a small café near the marina. We roast our own beans, most of our customers are regulars who work nearby, and weekends are our busiest time. We want more people to know we do brunch."
        value={onboard.desc}
        onChange={(e) => setOnboardField("desc", e.target.value)}
      />
      <div className="mt-2.5 flex items-center justify-between">
        <span className="text-xs text-text-3">
          <span>{words}</span> words — a few sentences is plenty
        </span>
      </div>
    </div>
  );
}

function MaraUnderstands() {
  const { onboard } = useVoomState();
  const words = onboard.desc.trim().split(/\s+/).filter(Boolean).length;
  return (
    <div className="mb-6.5 rounded-[var(--r-lg)] border border-brand bg-[var(--brand-soft)] p-5">
      <div className="flex items-start gap-3">
        <Orb size="sm" className="mt-0.5" />
        <div>
          <b className="text-sm">Got it — I understand your brand.</b>
          <p className="mt-1.5 text-[13.5px] leading-[1.62] text-text-2">
            I read all {words} words.{" "}
            {onboard.industry ? (
              <>
                This reads like a <b>{onboard.industry.toLowerCase()}</b> business, so I&apos;ve pre-selected that below — change it if I&apos;ve got it
                wrong.
              </>
            ) : (
              "I couldn't pin the category from the description alone, so pick it below."
            )}{" "}
            Now nine quick questions and I&apos;ll build your first two weeks.
          </p>
        </div>
      </div>
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
  return (
    <div>
      <MaraUnderstands />
      <h1 className="font-display text-[22px] font-bold tracking-tight">First, the basics</h1>
      <p className="my-2 text-[15px] text-text-2">So MARA writes as you, not about you.</p>
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
      <QBlock title="1. What kind of business is this?" help="Pick the closest match.">
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
      <h1 className="font-display text-2xl font-bold tracking-tight">Who you serve, and why</h1>
      <p className="my-2 text-[15px] text-text-2">Two questions. MARA uses these to choose the angle for every post.</p>
      <QBlock title="2. Who is your target customer?" help="Choose all that apply.">
        <div className="flex flex-wrap gap-2">
          {Q_CUSTOMER.map((c) => (
            <Chip key={c} active={onboard.customer.includes(c)} onClick={() => toggleOnboardArray("customer", c)}>
              {c}
            </Chip>
          ))}
        </div>
      </QBlock>
      <QBlock title="3. What is your main marketing goal?" help="Pick the one that matters most right now.">
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
          {Q_GOAL.map(([emoji, name]) => (
            <button
              key={name}
              onClick={() => setOnboardField("goal", name)}
              className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.goal === name ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
            >
              <span className="mb-1.5 block text-[22px]">{emoji}</span>
              <b className="text-[13.5px]">{name}</b>
            </button>
          ))}
        </div>
      </QBlock>
    </div>
  );
}

function StepVoiceChannels() {
  const { onboard } = useVoomState();
  const { toggleOnboardArray } = useVoomActions();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">How you sound, and where</h1>
      <p className="my-2 text-[15px] text-text-2">Voice and channels — these shape the words and the format.</p>
      <QBlock title="4. What is your brand personality?" help="Choose up to three.">
        <div className="flex flex-wrap gap-2">
          {OB_TONE.map((t) => (
            <Chip key={t} active={onboard.tone.includes(t)} onClick={() => toggleOnboardArray("tone", t, 3)}>
              {t}
            </Chip>
          ))}
        </div>
      </QBlock>
      <QBlock
        title="5. Which channels should MARA plan for?"
        help="Voom publishes to Instagram, TikTok and YouTube through your connected accounts and sends email campaigns and flows. Choose all that apply."
      >
        <div className="flex flex-wrap gap-2">
          {Q_CHANNELS.map((c) => (
            <Chip key={c} active={onboard.channels.includes(c)} onClick={() => toggleOnboardArray("channels", c)}>
              {c}
            </Chip>
          ))}
        </div>
      </QBlock>
    </div>
  );
}

function StepBudgetPace() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Budget and pace</h1>
      <p className="my-2 text-[15px] text-text-2">This sets how much MARA plans — and how much she asks you for.</p>
      <QBlock title="6. What is your optional monthly paid-advertising budget?" help="This is separate from your Voom subscription. Choose AED 0 if you only want organic marketing.">
        <div className="flex flex-col gap-2">
          {Q_BUDGET.map((v) => (
            <RadioTile key={v} label={v} active={onboard.budget === v} onClick={() => setOnboardField("budget", v)} />
          ))}
        </div>
      </QBlock>
      <QBlock title="7. How often do you want to post?">
        <div className="flex flex-col gap-2">
          {Q_FREQ.map((v) => (
            <RadioTile key={v} label={v} active={onboard.freq === v} onClick={() => setOnboardField("freq", v)} />
          ))}
        </div>
      </QBlock>
      <div className="rounded-2xl bg-surface-2 p-4">
        <div className="flex items-start gap-2.5">
          <Icon name="info" className="text-text-3" />
          <p className="text-[12.8px] leading-[1.6] text-text-2">
            Your Voom subscription pays for the software. Advertising budgets are optional and paid directly through your connected advertising account.
          </p>
        </div>
      </div>
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

function StepAutomation() {
  const { onboard } = useVoomState();
  const { setOnboardField } = useVoomActions();
  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">How much should MARA do?</h1>
      <p className="my-2 text-[15px] text-text-2">You can change both of these at any time in settings.</p>
      <QBlock title="8. What level of automation do you want?">
        <div className="grid grid-cols-2 gap-2.5">
          {Q_AUTO.map(([emoji, name, sub]) => (
            <button
              key={name}
              onClick={() => setOnboardField("auto", name)}
              className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.auto === name ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
            >
              <span className="mb-1.5 block text-[22px]">{emoji}</span>
              <b className="text-[13.5px]">{name}</b>
              <span className="mt-0.5 block text-[11.5px] text-text-3">{sub}</span>
            </button>
          ))}
        </div>
      </QBlock>
      <QBlock title="9. Must MARA ask permission before publishing?">
        <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-3">
          {Q_PERM.map(([emoji, name, sub]) => (
            <button
              key={name}
              onClick={() => setOnboardField("permission", name)}
              className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition hover:-translate-y-0.5 ${onboard.permission === name ? "border-brand bg-[var(--brand-soft)]" : "border-line"}`}
            >
              <span className="mb-1.5 block text-[22px]">{emoji}</span>
              <b className="text-[13.5px]">{name}</b>
              <span className="mt-0.5 block text-[11.5px] text-text-3">{sub}</span>
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

  const social: { key: keyof typeof CHANNEL_STATUS_ENDPOINTS; icon: string; name: string; desc: string; page: string; background: string }[] = [
    { key: "instagram", icon: "ig", name: "Instagram", desc: "Professional account · posts, Reels and Stories publish through your connected account.", page: "the Instagram page", background: "linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)" },
    { key: "tiktok", icon: "film", name: "TikTok", desc: "Videos publish through Voom's durable TikTok queue — Published only after TikTok confirms.", page: "the TikTok page", background: "#010101" },
    { key: "youtube", icon: "play", name: "YouTube", desc: "Shorts and full videos publish through Voom's durable YouTube queue — Published only after YouTube confirms.", page: "the YouTube page", background: "#ff0033" },
  ];

  return (
    <div>
      <h1 className="font-display text-2xl font-bold tracking-tight">Your channels</h1>
      <p className="my-2 text-[15px] text-text-2">
        Finish setup to create your workspace, then connect each channel from its own page. Every connection uses the
        provider&apos;s real authorization flow, and nothing is published anywhere until you approve it.
      </p>
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
      <div className="mb-2.5 flex items-center justify-between gap-3 rounded-[var(--r-lg)] border border-line bg-surface p-4">
        <div className="flex items-center gap-2.5">
          <div className="grid h-10 w-10 flex-none place-items-center rounded-xl text-white" style={{ background: "var(--grad)" }}>
            <Icon name="mail" />
          </div>
          <div>
            <b className="text-[14px]">Email</b>
            <div className="text-[12.5px] text-text-3">
              Campaigns and automated flows. There is no account to connect: set your sender name, sending address and domain in
              Settings → Email identity. Until your domain is verified, emails send from Voom&apos;s managed address with your business
              name shown.
            </div>
          </div>
        </div>
        <span className="flex-none text-right text-[12px] text-text-3">Set up in Settings</span>
      </div>
      <div className="mt-2.5 rounded-2xl border border-brand bg-[var(--brand-soft)] p-4">
        <div className="flex items-start gap-2.5">
          <Orb size="sm" className="mt-0.5" />
          <p className="text-[13.5px] leading-[1.6]">
            You can plan, draft and approve content for every channel before anything is connected. Approval never publishes on its
            own — each channel reports Published only after the provider itself confirms.
          </p>
        </div>
      </div>
    </div>
  );
}
