"use client";

import { useEffect, useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import type { BusinessProfileInput } from "@/lib/voom/types";
import { MANUAL_NEVER_AUTO_SPENDS } from "@/lib/mara/media-spend";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Btn, Card, Field, Input, Tag } from "@/components/voom/ui/primitives";
import { getPlanConfig } from "@/lib/billing/plans";
import type { CreditSummary } from "@/lib/billing/ledger";
import { EmailIdentityCard } from "@/components/voom/modals/EmailIdentityCard";

export default function SettingsPage() {
  const { brand, mediaSpend, theme, displayName, email, settingsSaving, settingsError, plan } = useVoomState();
  const { setTheme, toast, restartOnboarding, saveBrandSettings, saveMediaSpend, goTo } = useVoomActions();

  const [nameInput, setNameInput] = useState(displayName);
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

  async function handleSave() {
    const payload: BusinessProfileInput = {
      displayName: nameInput,
      // Brand fields are edited on the Brand page; this save sends the stored
      // values unchanged so the kit's carry-forward rule records no change.
      brandName: brand.name,
      brandDescription: brand.desc,
      industry: brand.industry,
      targetCustomer: brand.audience,
      mainGoal: brand.goals[0] ?? "",
      brandPersonality: brand.tone,
      preferredChannels: brand.channels,
      monthlyAdBudget: brand.budget,
      contentFrequency: brand.freq,
      automationLevel: brand.auto,
      publishingPermission: brand.permission,
    };
    await saveBrandSettings(payload);
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
          <Btn variant="outline" size="sm" onClick={() => goTo("pricing")}>View plans</Btn>
        </div>
      </Card>

      <Card className="mb-3.5 p-4">
        <h2 className="mb-3.5 font-display text-lg font-semibold">Your name</h2>
        <Field label="What should Voom call you?" hint="Shown in your greeting and account menu.">
          <Input value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" />
        </Field>
      </Card>

      <Card className="mb-3.5 p-4">
        <h2 className="mb-1.5 font-display text-lg font-semibold">Your brand</h2>
        <p className="mb-3.5 text-[12.5px] leading-relaxed text-text-3">
          Everything MARA knows about {brand.name || "your business"} — description, audience, voice, rules, facts, pace and channels — lives on
          the Brand page now, with a history of every change. The automation level is set on the Automations page.
        </p>
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" size="sm" onClick={() => goTo("brand")}>Open Brand page</Btn>
          <Btn variant="ghost" size="sm" onClick={() => goTo("automations")}>Automation level</Btn>
        </div>
      </Card>

      <EmailIdentityCard />

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
