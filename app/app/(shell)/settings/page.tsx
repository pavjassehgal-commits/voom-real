"use client";

import { useEffect, useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { Q_INDUSTRY, OB_TONE } from "@/lib/voom/onboardingData";
import type { BusinessProfileInput } from "@/lib/voom/types";
import { MANUAL_NEVER_AUTO_SPENDS } from "@/lib/mara/media-spend";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { AdSepNote } from "@/components/voom/ui/Notes";
import { Btn, Card, Chip, Field, Input, Tag, Textarea } from "@/components/voom/ui/primitives";
import { getPlanConfig } from "@/lib/billing/plans";
import type { CreditSummary } from "@/lib/billing/ledger";
import { EmailIdentityCard } from "@/components/voom/modals/EmailIdentityCard";

export default function SettingsPage() {
  const { brand, mediaSpend, theme, displayName, email, settingsSaving, settingsError, plan } = useVoomState();
  const { toggleTone, setTheme, toast, restartOnboarding, saveBrandSettings, saveMediaSpend } = useVoomActions();

  const [nameInput, setNameInput] = useState(displayName);
  const [brandNameInput, setBrandNameInput] = useState(brand.name);
  // Loaded from the persisted businesses.brand_description, so saving any
  // other field round-trips the existing value instead of wiping it.
  const [descInput, setDescInput] = useState(brand.desc);
  const [industryInput, setIndustryInput] = useState(brand.industry);
  const [audience, setAudience] = useState(brand.audience);
  const [restarting, setRestarting] = useState(false);
  const [allowAutomaticMedia, setAllowAutomaticMedia] = useState(mediaSpend.allowAutomaticPaidMedia);
  const [mediaBudgetInput, setMediaBudgetInput] = useState(String(mediaSpend.monthlyMediaBudgetUsd));
  const [savingSpend, setSavingSpend] = useState(false);
  const [creditSummary, setCreditSummary] = useState<CreditSummary | null>(null);
  const [creditLoading, setCreditLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void fetch("/api/billing/summary", { cache: "no-store" })
      .then((r) => r.json())
      .then((body: { summary?: CreditSummary }) => {
        if (active && body.summary) setCreditSummary(body.summary);
      })
      .catch(() => null)
      .finally(() => {
        if (active) setCreditLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  const planConfig = getPlanConfig(plan);

  const autonomyRows: [string, string, string][] = [
    ["Draft content", "Always", "t-green"],
    [
      "Publish to Instagram",
      brand.permission ? (brand.permission.startsWith("No") ? "Automatic" : "Ask first") : "Not set yet",
      brand.permission.startsWith("No") ? "t-green" : "t-amber",
    ],
    ["Send email", "Explicit send only · Ask first", "t-grey"],
    ["Spend ad budget", "Always ask", "t-red"],
    ["Automation level", brand.auto || "Not set yet", "t-blue"],
    ["Posting frequency", brand.freq || "Not set yet", "t-blue"],
    ["Monthly ad budget", brand.budget || "Not set yet", "t-blue"],
  ];

  async function handleSave() {
    const payload: BusinessProfileInput = {
      displayName: nameInput,
      brandName: brandNameInput,
      brandDescription: descInput,
      industry: industryInput,
      targetCustomer: audience,
      mainGoal: brand.goals[0] ?? "",
      brandPersonality: brand.tone,
      preferredChannels: brand.channels,
      monthlyAdBudget: brand.budget,
      contentFrequency: brand.freq,
      automationLevel: brand.auto,
      publishingPermission: brand.permission,
    };
    const ok = await saveBrandSettings(payload);
    if (ok) toast("Brand profile saved");
  }

  async function handleSaveSpending() {
    setSavingSpend(true);
    await saveMediaSpend({
      allowAutomaticPaidMedia: allowAutomaticMedia,
      monthlyMediaBudgetUsd: Number(mediaBudgetInput.trim() || 0),
    });
    setSavingSpend(false);
  }

  async function handleRestart() {
    setRestarting(true);
    await restartOnboarding();
    setRestarting(false);
  }

  return (
    <div className="mx-auto max-w-[820px]">
      <PageHead
        title="Settings"
        description="What Voom knows about your brand and how its intelligence should operate."
        actions={
          <Btn variant="primary" size="sm" onClick={handleSave} disabled={settingsSaving}>
            {settingsSaving ? "Saving…" : "Save changes"}
          </Btn>
        }
      />

      {settingsError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red-900/40 bg-red-950/30 px-3.5 py-2.5 text-sm text-red-300">
          {settingsError}
        </div>
      )}

      <Card className="mb-3.5 p-4">
        <h2 className="mb-3.5 font-display text-lg font-semibold">Billing & Credits</h2>
        <div className="flex flex-wrap items-center gap-2 mb-3">
          <Tag tone="t-brand">{planConfig.name} plan</Tag>
          <Tag>${planConfig.priceUsd}/month</Tag>
          <Tag>{planConfig.allowedModes.join(", ")} modes</Tag>
        </div>
        {creditLoading ? (
          <p className="text-sm text-text-3">Loading credits…</p>
        ) : creditSummary ? (
          <div className="space-y-2">
            <div className="flex flex-wrap gap-3 text-sm">
              <span><b>{creditSummary.remaining}</b> remaining</span>
              <span className="text-text-3">· {creditSummary.used} used</span>
              <span className="text-text-3">· {creditSummary.allowance + creditSummary.additional} total this month</span>
            </div>
            <div className="h-2 w-full rounded-full bg-surface-2 overflow-hidden">
              <div
                className="h-full bg-brand"
                style={{ width: `${Math.min(100, ((creditSummary.used / Math.max(1, creditSummary.allowance + creditSummary.additional)) * 100))}%` }}
              />
            </div>
            <p className="text-[12.5px] text-text-3">
              Resets {new Date(creditSummary.resetAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })} · Period from {new Date(creditSummary.periodStart).toLocaleDateString()} · {creditSummary.label}
            </p>
          </div>
        ) : (
          <p className="text-sm text-text-3">Credits unavailable — migration pending.</p>
        )}
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">
          Credits are used only when Voom generates AI images or videos. An image costs 5 credits, a short video costs 40 credits. Polling, planning, copy and scheduling use zero credits. No provider call happens when you are blocked for insufficient credits.
        </p>
        <div className="mt-3">
          <Btn variant="outline" size="sm" onClick={() => window.location.assign("/app/pricing")}>View plans</Btn>
        </div>
      </Card>

      <Card className="mb-3.5 p-4">
        <h2 className="mb-3.5 font-display text-lg font-semibold">Your name</h2>
        <Field label="What should Voom call you?" hint="Shown in your greeting and account menu.">
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" />
        </Field>
      </Card>

      <Card className="mb-3.5 p-4">
        <h2 className="mb-3.5 font-display text-lg font-semibold">Brand profile</h2>
        <div className="flex flex-wrap gap-3">
          <div className="min-w-[200px] flex-1">
            <Field label="Brand name">
              <Input value={brandNameInput} onChange={(e) => setBrandNameInput(e.target.value)} placeholder="Your business name" />
            </Field>
          </div>
        </div>
        <Field label="Describe your brand" hint="What you do, who you serve and what makes you different. MARA reads this before she writes or plans anything. Clear the field to remove the description.">
          <Textarea
            rows={5}
            value={descInput}
            onChange={(e) => setDescInput(e.target.value)}
            placeholder="For example: We're a small café near the marina. Most of our customers are regulars who work nearby, and weekends are our busiest time."
          />
        </Field>
        <Field label="Kind of business">
          <select
            className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]"
            value={industryInput}
            onChange={(e) => setIndustryInput(e.target.value)}
          >
            <option value="">Not set</option>
            {Q_INDUSTRY.map(([, name]) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
        </Field>
        <label className="mb-2.5 block text-[12.5px] font-semibold text-text-2">Brand personality</label>
        <div className="mb-4 flex flex-wrap gap-1.5">
          {OB_TONE.map((t) => (
            <Chip key={t} active={brand.tone.includes(t)} onClick={() => toggleTone(t)}>
              {t}
            </Chip>
          ))}
        </div>
        <label className="mb-2.5 block text-[12.5px] font-semibold text-text-2">Audience</label>
        <div className="flex flex-wrap gap-1.5">
          {audience.length === 0 && <span className="text-[13px] text-text-3">Not set yet.</span>}
          {audience.map((a) => (
            <span key={a} className="inline-flex items-center gap-1.5 rounded-full border border-brand bg-[var(--brand-soft)] px-3.5 py-1.5 text-[13px] font-semibold text-brand">
              {a}{" "}
              <button onClick={() => setAudience((prev) => prev.filter((x) => x !== a))} className="text-brand/70 hover:text-brand">
                ×
              </button>
            </span>
          ))}
          <Chip onClick={() => toast("Audience editor is visual-only", "info")}>
            <Icon name="plus" size={14} /> Add
          </Chip>
        </div>
      </Card>

      <EmailIdentityCard />

      <Card className="mb-3.5 p-4">
        <h2 className="mb-1.5 font-display text-lg font-semibold">Voom automation</h2>
        <p className="mb-3.5 text-[12.5px] text-text-3">How much she can do without checking in — set during onboarding.</p>
        <div className="mb-3.5">
          <AdSepNote />
        </div>
        {autonomyRows.map(([label, value, tone]) => (
          <div key={label} className="flex items-center justify-between border-b border-line py-2.5 last:border-0">
            <span className="text-[13.5px] font-semibold">{label}</span>
            <button
              className={`inline-flex items-center gap-1.5 rounded-[7px] px-2.5 py-[3px] text-[11.5px] font-semibold ${{ "t-green": "bg-green/15 text-green", "t-amber": "bg-amber/15 text-amber", "t-red": "bg-red/15 text-red", "t-blue": "bg-blue/15 text-blue" }[tone]}`}
              onClick={() => toast("Autonomy settings are visual-only here", "info")}
            >
              {value} <Icon name="arrow" size={12} />
            </button>
          </div>
        ))}
      </Card>

      <Card className="mb-3.5 p-4">
        <h2 className="mb-1.5 font-display text-lg font-semibold">AI Media Spending</h2>
        <p className="mb-3.5 text-[12.5px] text-text-3">
          What MARA may spend on generated media (images and videos) without you asking for each one. Only Max plan + Autopilot mode can use automatic paid media, and only when this toggle is ON and you have enough credits.
        </p>
        <div className="flex items-center justify-between gap-3 border-b border-line py-2.5">
          <div>
            <b className="text-[13.5px]">Allow MARA to generate paid media automatically</b>
            <div className="text-[12.5px] text-text-3">
              {allowAutomaticMedia ? "On" : "Off"} — used by Autopilot runs only, within your credit limits. Assisted never auto-generates paid media.
            </div>
          </div>
          <div className="inline-flex shrink-0 gap-1 rounded-xl border border-line bg-surface-2 p-1">
            <button
              type="button"
              aria-pressed={allowAutomaticMedia}
              onClick={() => setAllowAutomaticMedia(true)}
              className={`rounded-[10px] px-3.5 py-1.5 text-[13.5px] font-semibold transition ${allowAutomaticMedia ? "bg-surface shadow-[var(--shadow)]" : "text-text-2"}`}
            >
              On
            </button>
            <button
              type="button"
              aria-pressed={!allowAutomaticMedia}
              onClick={() => setAllowAutomaticMedia(false)}
              className={`rounded-[10px] px-3.5 py-1.5 text-[13.5px] font-semibold transition ${!allowAutomaticMedia ? "bg-surface shadow-[var(--shadow)]" : "text-text-2"}`}
            >
              Off
            </button>
          </div>
        </div>

        <p className="mb-3.5 text-[12.5px] text-text-3">{MANUAL_NEVER_AUTO_SPENDS}</p>
        <Btn variant="outline" size="sm" onClick={handleSaveSpending} disabled={savingSpend || settingsSaving}>
          {savingSpend ? "Saving…" : "Save spending settings"}
        </Btn>
      </Card>

      <Card className="p-4">
        <h2 className="mb-3.5 font-display text-lg font-semibold">Account</h2>
        <div className="flex items-center justify-between border-b border-line py-2.5">
          <div>
            <b className="text-[13.5px]">{displayName || "Your account"}</b>
            <div className="text-[12.5px] text-text-3">{email}</div>
          </div>
        </div>
        <div className="flex items-center justify-between border-b border-line py-2.5">
          <div>
            <b className="text-[13.5px]">Appearance</b>
            <div className="text-[12.5px] text-text-3">Light or dark interface</div>
          </div>
          <div className="inline-flex gap-1 rounded-xl border border-line bg-surface-2 p-1">
            <button
              onClick={() => setTheme("light")}
              className={`rounded-[10px] px-3.5 py-1.5 text-[13.5px] font-semibold transition ${theme === "light" ? "bg-surface shadow-[var(--shadow)]" : "text-text-2"}`}
            >
              Light
            </button>
            <button
              onClick={() => setTheme("dark")}
              className={`rounded-[10px] px-3.5 py-1.5 text-[13.5px] font-semibold transition ${theme === "dark" ? "bg-surface shadow-[var(--shadow)]" : "text-text-2"}`}
            >
              Dark
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between border-b border-line py-2.5">
          <div>
            <b className="text-[13.5px]">Onboarding</b>
            <div className="text-[12.5px] text-text-3">Re-run the brand setup questions on this account</div>
          </div>
          <Btn variant="outline" size="sm" onClick={handleRestart} disabled={restarting}>
            {restarting ? "Restarting…" : "Restart onboarding"}
          </Btn>
        </div>
        <div className="flex items-center justify-between pt-3.5">
          <div>
            <b className="text-[13.5px] text-red">Delete workspace</b>
            <div className="text-[12.5px] text-text-3">Removes {brand.name || "your business"} and all content</div>
          </div>
          <Btn variant="danger" size="sm" onClick={() => toast("Deletion is disabled in this prototype", "err")}>
            Delete
          </Btn>
        </div>
      </Card>
    </div>
  );
}
