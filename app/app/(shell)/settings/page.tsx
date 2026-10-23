"use client";

import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { Q_INDUSTRY, OB_TONE, Q_CHANNELS, Q_CUSTOMER } from "@/lib/voom/onboardingData";
import type { BusinessProfileInput } from "@/lib/voom/types";
import { MANUAL_NEVER_AUTO_SPENDS } from "@/lib/mara/media-spend";
import { Icon } from "@/components/voom/icons";
import { BTN, ChannelGlyph, PageHeader } from "@/components/voom/redesign/ui";
import { AdSepNote } from "@/components/voom/ui/Notes";
import { getPlanConfig } from "@/lib/billing/plans";
import type { CreditSummary } from "@/lib/billing/ledger";
import { EmailIdentityCard } from "@/components/voom/modals/EmailIdentityCard";
import { cx } from "@/lib/voom/cx";
import { logout as logoutAction } from "@/app/app/actions";

/**
 * Settings — redesign Batch 4C (Figma "Workspace settings", PDF pages
 * 84–94; their labels are shifted by one section, the drawings were matched
 * by content).
 *
 * One section at a time, chosen from the grouped side navigation (kept in the
 * URL hash so a section can be linked, e.g. /app/settings#email). Every
 * control reads or writes a real saved value. Not shown, because Voom has no
 * backing for them: brand logo, language, week start, notification toggles,
 * automation-rule toggles, Team & permissions, payment method, invoices,
 * billing email, Buy credits, data export, password change, active sessions
 * and self-serve workspace deletion — and the "Ask MARA" helper card (the MARA
 * chat is retired).
 */
type SectionId = "general" | "brand" | "channels" | "email" | "mara" | "billing" | "appearance" | "privacy" | "account" | "danger";

const NAV: { group: string; items: { id: SectionId; label: string }[] }[] = [
  { group: "Workspace", items: [{ id: "general", label: "General" }, { id: "brand", label: "Brand profile" }] },
  { group: "Publishing", items: [{ id: "channels", label: "Channels" }, { id: "email", label: "Email & notifications" }] },
  { group: "Automation", items: [{ id: "mara", label: "MARA & AI" }] },
  { group: "Billing", items: [{ id: "billing", label: "Billing & credits" }] },
  { group: "Preferences", items: [{ id: "appearance", label: "Appearance" }] },
  { group: "Security", items: [{ id: "privacy", label: "Data & privacy" }] },
  { group: "Account", items: [{ id: "account", label: "Account details" }, { id: "danger", label: "Danger zone" }] },
];
const SECTION_IDS = new Set<string>(NAV.flatMap((group) => group.items.map((item) => item.id)));

export default function SettingsPage() {
  const { brand, mediaSpend, theme, displayName, email, settingsSaving, settingsError, plan } = useVoomState();
  const { toggleTone, setTheme, toast, restartOnboarding, saveBrandSettings, saveMediaSpend } = useVoomActions();

  const [section, setSection] = useState<SectionId>("general");
  const [nameInput, setNameInput] = useState(displayName);
  const [brandNameInput, setBrandNameInput] = useState(brand.name);
  // Loaded from the persisted businesses.brand_description, so saving any
  // other field round-trips the existing value instead of wiping it.
  const [descInput, setDescInput] = useState(brand.desc);
  const [industryInput, setIndustryInput] = useState(brand.industry);
  const [audience, setAudience] = useState(brand.audience);
  const [channels, setChannels] = useState(brand.channels);
  const [restarting, setRestarting] = useState(false);
  const [allowAutomaticMedia, setAllowAutomaticMedia] = useState(mediaSpend.allowAutomaticPaidMedia);
  const [mediaBudgetInput] = useState(String(mediaSpend.monthlyMediaBudgetUsd));
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

  // The section lives in the URL hash so /app/settings#email opens Email.
  useEffect(() => {
    function fromHash() {
      const id = window.location.hash.replace("#", "");
      if (SECTION_IDS.has(id)) setSection(id as SectionId);
    }
    fromHash();
    window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  function open(id: SectionId) {
    setSection(id);
    window.history.replaceState(null, "", `#${id}`);
  }

  const planConfig = getPlanConfig(plan);

  async function handleSave() {
    const payload: BusinessProfileInput = {
      displayName: nameInput,
      brandName: brandNameInput,
      brandDescription: descInput,
      industry: industryInput,
      targetCustomer: audience,
      mainGoal: brand.goals[0] ?? "",
      brandPersonality: brand.tone,
      preferredChannels: channels,
      monthlyAdBudget: brand.budget,
      contentFrequency: brand.freq,
      automationLevel: brand.auto,
      publishingPermission: brand.permission,
    };
    const ok = await saveBrandSettings(payload);
    if (ok) toast("Settings saved");
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

  const saveBar = (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
      <span className="text-[13px] text-text-3">Changes apply to MARA&apos;s next plan and drafts.</span>
      <button type="button" onClick={handleSave} disabled={settingsSaving} className={BTN.primary}>{settingsSaving ? "Saving…" : "Save changes"}</button>
    </div>
  );

  const total = creditSummary ? creditSummary.allowance + creditSummary.additional : 0;

  return (
    <div className="min-w-0">
      <PageHeader title="Workspace settings" subtitle="Manage your brand, channels, automation preferences and account details." />

      {settingsError && (
        <div role="alert" className="mb-5 rounded-[14px] border border-[var(--red)]/25 bg-[var(--red-soft)] px-4 py-3 text-[14px] text-[var(--red)]">
          {settingsError}
        </div>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-6 lg:grid-cols-[220px_minmax(0,1fr)]">
        <label className="block lg:hidden">
          <span className="mb-1.5 block text-[13px] font-semibold text-text">Settings section</span>
          <select className={cx(BTN.field, "w-full")} value={section} onChange={(e) => open(e.target.value as SectionId)}>
            {NAV.map((group) => (
              <optgroup key={group.group} label={group.group}>
                {group.items.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
        <nav aria-label="Settings sections" className="hidden min-w-0 lg:block">
          <div>
            {NAV.map((group) => (
              <div key={group.group} className="mb-4">
                <div className="px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-text-3">{group.group}</div>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => open(item.id)}
                    aria-current={section === item.id ? "page" : undefined}
                    className={cx(
                      "flex w-full items-center justify-between gap-2 whitespace-nowrap rounded-[12px] px-3 py-2 text-left text-[14px] transition",
                      section === item.id
                        ? "border border-line border-l-[3px] border-l-[var(--brand)] bg-surface font-semibold text-text shadow-[var(--shadow-sm)]"
                        : "border border-transparent text-text-2 hover:bg-surface-2 hover:text-text",
                    )}
                  >
                    {item.label}
                    {item.id === "billing" && <span className="rounded-full bg-surface-3 px-2 py-0.5 text-[11px] font-semibold text-text-2">{planConfig.name}</span>}
                  </button>
                ))}
              </div>
            ))}
          </div>
        </nav>

        <div className="min-w-0 space-y-5">
          {section === "general" && (
            <Panel title="General" hint="Workspace basics.">
              <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
                <Field label="Your name" hint="Shown in your greeting and account menu.">
                  <input className={cx(BTN.field, "w-full")} value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" />
                </Field>
                <Field label="Workspace name" hint="Your brand name — edit it in Brand profile.">
                  <input className={cx(BTN.field, "w-full bg-surface-2 text-text-2")} value={brandNameInput || "Not set"} readOnly aria-readonly="true" />
                </Field>
              </div>
              {saveBar}
            </Panel>
          )}

          {section === "brand" && <>
            <Panel title="Brand profile" hint="Keeps your brand consistent across content, campaigns and MARA's recommendations.">
              <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
                <Field label="Brand name">
                  <input className={cx(BTN.field, "w-full")} value={brandNameInput} onChange={(e) => setBrandNameInput(e.target.value)} placeholder="Your business name" />
                </Field>
                <Field label="Industry">
                  <select className={cx(BTN.field, "w-full")} value={industryInput} onChange={(e) => setIndustryInput(e.target.value)}>
                    <option value="">Not set</option>
                    {Q_INDUSTRY.map(([, name]) => <option key={name} value={name}>{name}</option>)}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Brand description" hint={`MARA reads this before she writes or plans anything. Clear the field to remove the description. ${descInput.length} characters.`}>
                    <textarea
                      rows={5}
                      className="w-full rounded-[14px] border border-line bg-surface px-3.5 py-3 text-[14px] leading-relaxed text-text outline-none transition focus:border-[var(--brand-line)] focus:shadow-[0_0_0_4px_var(--brand-soft)]"
                      value={descInput}
                      onChange={(e) => setDescInput(e.target.value)}
                      placeholder="For example: We're a small café near the marina. Most of our customers are regulars who work nearby, and weekends are our busiest time."
                    />
                  </Field>
                </div>
              </div>
              {saveBar}
            </Panel>
            <Panel title="Brand personality" hint="Help MARA understand how your brand should sound.">
              <div className="p-5 sm:p-6">
                <h3 className="text-[13.5px] font-semibold text-text">Tone of voice <span className="font-normal text-text-3">· pick up to 3</span></h3>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {OB_TONE.map((t) => <Pill key={t} active={brand.tone.includes(t)} onClick={() => toggleTone(t)}>{t}</Pill>)}
                </div>
                <h3 className="mt-6 text-[13.5px] font-semibold text-text">Target audience</h3>
                <div className="mt-2.5 flex flex-wrap gap-2">
                  {Q_CUSTOMER.map((a) => <Pill key={a} active={audience.includes(a)} onClick={() => setAudience((prev) => prev.includes(a) ? prev.filter((x) => x !== a) : [...prev, a])}>{a}</Pill>)}
                  {audience.filter((a) => !Q_CUSTOMER.includes(a)).map((a) => <Pill key={a} active onClick={() => setAudience((prev) => prev.filter((x) => x !== a))}>{a}</Pill>)}
                </div>
              </div>
              {saveBar}
            </Panel>
          </>}

          {section === "channels" && (
            <Panel title="Channels" hint="Which channels MARA plans for. Connections live on the Channels page.">
              <div className="p-5 sm:p-6">
                <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                  {Q_CHANNELS.map((c) => {
                    const on = channels.includes(c);
                    return (
                      <button key={c} type="button" aria-pressed={on} onClick={() => setChannels((prev) => on ? prev.filter((x) => x !== c) : [...prev, c])}
                        className={cx("flex items-center gap-3 rounded-[14px] border px-4 py-3 text-left transition", on ? "border-[var(--brand-line)] bg-[var(--brand-soft-2)]" : "border-line bg-surface hover:border-[var(--line-2)]")}>
                        <ChannelGlyph channelLabel={c} size={26} />
                        <span className="flex-1 text-[14px] font-semibold text-text">{c}</span>
                        <span className={cx("text-[12.5px] font-semibold", on ? "text-[var(--brand-ink)]" : "text-text-3")}>{on ? "In plan" : "Not planned"}</span>
                      </button>
                    );
                  })}
                </div>
                <Link href="/app/connections" className={cx(BTN.outline, "mt-5")}>Manage connections <Icon name="arrow" size={14} /></Link>
              </div>
              {saveBar}
            </Panel>
          )}

          {section === "email" && (
            <div id="email" className="min-w-0">
              <EmailIdentityCard />
            </div>
          )}

          {section === "mara" && <>
            <Panel title="Voom automation" hint="What MARA can prepare or do without asking you. Change the mode on the Automations page." icon="sparkles">
              <ul className="divide-y divide-line">
                <Row label="Automation level" hint="How proactive MARA is overall." value={brand.auto || "Not set yet"} tone="brand" />
                <Row label="Draft content" hint="Write captions, ideas and post drafts." value="Always" tone="green" />
                <Row label="Publish to social channels" hint="Instagram, TikTok and YouTube." value={brand.permission ? (brand.permission.startsWith("No") ? "Automatic" : "Ask first") : "Not set yet"} tone="amber" />
                <Row label="Send email campaigns" hint="Only through an explicit send action." value="Ask first" tone="amber" />
                <Row label="Spend ad budget" hint="Always needs your approval." value="Always ask" tone="coral" />
                <Row label="Posting frequency" hint="MARA plans around this." value={brand.freq || "Not set yet"} tone="brand" />
                <Row label="Monthly ad budget" hint="Upper limit MARA can propose." value={brand.budget || "Not set yet"} tone="brand" />
              </ul>
              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-line px-5 py-4 sm:px-6">
                <AdSepNote />
                <Link href="/app/automations" className={BTN.outline}>Open Automations <Icon name="arrow" size={14} /></Link>
              </div>
            </Panel>
            <Panel title="AI media spending" hint="Whether MARA can use your Voom credits to generate images and videos.">
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-6">
                <div className="min-w-0 max-w-xl">
                  <b className="text-[14px] font-semibold text-text">Allow MARA to generate paid media automatically</b>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">
                    {allowAutomaticMedia ? "On" : "Off"} — used by Autopilot runs only, within your credit limits. Only the Max plan in Autopilot mode can use it. Assisted never auto-generates paid media.
                  </p>
                </div>
                <Segmented value={allowAutomaticMedia ? "on" : "off"} options={[["on", "On"], ["off", "Off"]]} onChange={(value) => setAllowAutomaticMedia(value === "on")} />
              </div>
              <p className="px-5 pb-4 text-[12.5px] text-text-3 sm:px-6">{MANUAL_NEVER_AUTO_SPENDS}</p>
              <div className="flex justify-end border-t border-line px-5 py-4 sm:px-6">
                <button type="button" onClick={handleSaveSpending} disabled={savingSpend || settingsSaving} className={BTN.primary}>{savingSpend ? "Saving…" : "Save spending settings"}</button>
              </div>
            </Panel>
          </>}

          {section === "billing" && <>
            <Panel title="Billing & credits" hint="Your plan and what you've used this month.">
              <div className="grid gap-4 p-5 sm:p-6 md:grid-cols-2">
                <div className="rounded-[16px] border border-line p-5">
                  <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-3">Current plan</div>
                  <div className="mt-2 flex items-baseline gap-2">
                    <span className="text-[26px] font-bold tracking-[-0.03em] text-text">{planConfig.name}</span>
                    <span className="text-[14px] text-text-2">${planConfig.priceUsd} / month</span>
                  </div>
                  <p className="mt-1.5 text-[13px] text-text-2">Modes: {planConfig.allowedModes.map((mode) => mode.charAt(0).toUpperCase() + mode.slice(1)).join(", ")}</p>
                  <Link href="/app/pricing" className={cx(BTN.primary, "mt-4")}>View plans</Link>
                </div>
                <div className="rounded-[16px] border border-line p-5">
                  <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-3">AI credits{creditSummary ? ` · ${creditSummary.label}` : ""}</div>
                  {creditLoading ? <p className="mt-3 text-[13.5px] text-text-3">Loading credits…</p>
                    : creditSummary ? <>
                      <div className="mt-2 flex items-baseline gap-2"><span className="text-[26px] font-bold tracking-[-0.03em] text-text">{creditSummary.remaining}</span><span className="text-[14px] text-text-2">remaining</span></div>
                      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={creditSummary.used} aria-label="Credits used">
                        <div className="h-full rounded-full bg-[linear-gradient(90deg,#8645fa,#cc40ea)]" style={{ width: `${Math.min(100, (creditSummary.used / Math.max(1, total)) * 100)}%` }} />
                      </div>
                      <div className="mt-2 flex justify-between text-[12.5px] text-text-2"><span>{creditSummary.used} used</span><span>{total} total this month</span></div>
                      <p className="mt-2 text-[12px] text-text-3">Resets {new Date(creditSummary.resetAt).toLocaleDateString("en-US", { month: "long", day: "numeric" })} · period from {new Date(creditSummary.periodStart).toLocaleDateString()}</p>
                    </> : <p className="mt-3 text-[13.5px] text-text-3">Credits are unavailable right now. Refresh to try again.</p>}
                </div>
              </div>
              <p className="border-t border-line px-5 py-4 text-[12.5px] leading-relaxed text-text-2 sm:px-6">
                Credits are used only when Voom generates AI images or videos. An image costs 5 credits, a short video costs 40 credits. Polling, planning, copy and scheduling use zero credits. No provider call happens when you are blocked for insufficient credits.
              </p>
            </Panel>
            <Panel title="Payment & invoices" hint="Voom does not take payments inside the app yet.">
              <p className="px-5 py-5 text-[13.5px] leading-relaxed text-text-2 sm:px-6">
                There is no payment method on file and no invoice to show. Plan changes are handled from the plans page; Voom never charges a card from here.
              </p>
            </Panel>
          </>}

          {section === "appearance" && (
            <Panel title="Appearance" hint="Applies to this browser.">
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-6">
                <div><b className="text-[14px] font-semibold text-text">Theme</b><p className="text-[12.5px] text-text-2">Light or dark interface.</p></div>
                <Segmented value={theme} options={[["light", "Light"], ["dark", "Dark"]]} onChange={(value) => setTheme(value as "light" | "dark")} />
              </div>
            </Panel>
          )}

          {section === "privacy" && (
            <Panel title="Data & privacy" hint="How Voom handles your workspace data.">
              <ul className="divide-y divide-line">
                <LinkRow href="/privacy" label="Privacy Policy" hint="What Voom collects and why." />
                <LinkRow href="/terms" label="Terms of Service" hint="The terms your workspace runs under." />
                <LinkRow href="/data-deletion" label="Data deletion" hint="How to have your data and connected-account data deleted." />
              </ul>
              <p className="border-t border-line px-5 py-4 text-[12.5px] leading-relaxed text-text-3 sm:px-6">
                Provider access tokens are stored encrypted on the server and never sent to your browser. Disconnect a channel from its own page to revoke Voom&apos;s access.
              </p>
            </Panel>
          )}

          {section === "account" && (
            <Panel title="Account details" hint="Your personal details in this workspace.">
              <div className="grid gap-4 p-5 sm:grid-cols-2 sm:p-6">
                <Field label="Name"><input className={cx(BTN.field, "w-full")} value={nameInput} onChange={(e) => setNameInput(e.target.value)} placeholder="Your name" /></Field>
                <Field label="Email" hint="The address you sign in with."><input className={cx(BTN.field, "w-full bg-surface-2 text-text-2")} value={email ?? ""} readOnly aria-readonly="true" /></Field>
              </div>
              <ul className="divide-y divide-line border-t border-line">
                <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
                  <div><b className="text-[14px] font-semibold text-text">Onboarding</b><p className="text-[12.5px] text-text-2">Re-run the brand setup questions on this account.</p></div>
                  <button type="button" onClick={handleRestart} disabled={restarting} className={BTN.quiet}>{restarting ? "Restarting…" : "Restart onboarding"}</button>
                </li>
                <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-4 sm:px-6">
                  <div><b className="text-[14px] font-semibold text-text">Sign out</b><p className="text-[12.5px] text-text-2">End this session on this device.</p></div>
                  <form action={logoutAction}><button type="submit" className={BTN.quiet}><Icon name="logout" size={15} /> Sign out</button></form>
                </li>
              </ul>
              {saveBar}
            </Panel>
          )}

          {section === "danger" && (
            <Panel title="Danger zone" hint="Permanent actions.">
              <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-5 sm:px-6">
                <div className="min-w-0 max-w-xl">
                  <b className="text-[14px] font-semibold text-[var(--red)]">Delete workspace</b>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-text-2">
                    Removes {brand.name || "your business"} and all of its content. Deletion is handled on request rather than from a button here, so nothing can be removed by accident.
                  </p>
                </div>
                <Link href="/data-deletion" className="inline-flex h-11 items-center gap-2 rounded-[14px] border border-[var(--red)]/30 px-4 text-[14px] font-semibold text-[var(--red)] transition hover:bg-[var(--red-soft)]">How to delete your data</Link>
              </div>
            </Panel>
          )}
        </div>
      </div>
    </div>
  );
}

function Panel({ title, hint, icon, children }: { title: string; hint?: string; icon?: string; children: ReactNode }) {
  return (
    <section className="voom-card min-w-0 overflow-hidden" aria-label={title}>
      <header className="flex items-start gap-3 border-b border-line px-5 py-4 sm:px-6">
        {icon && <span className="voom-create-btn grid h-9 w-9 shrink-0 place-items-center rounded-[11px] text-white"><Icon name={icon} size={17} /></span>}
        <div className="min-w-0">
          <h2 className="text-[17px] font-semibold tracking-[-0.01em] text-text">{title}</h2>
          {hint && <p className="mt-0.5 text-[13px] text-text-2">{hint}</p>}
        </div>
      </header>
      {children}
    </section>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block min-w-0">
      <span className="mb-1.5 block text-[13px] font-semibold text-text">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-[12px] text-text-3">{hint}</span>}
    </label>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" aria-pressed={active} onClick={onClick}
      className={cx("inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition", active ? "border-[var(--brand-line)] bg-[var(--brand-soft)] text-[var(--brand-ink)]" : "border-line bg-surface text-text-2 hover:border-[var(--line-2)]")}>
      {active && <Icon name="check" size={12} />}{children}
    </button>
  );
}

const ROW_TONES = {
  brand: "bg-[var(--brand-soft)] text-[var(--brand-ink)]",
  green: "bg-[var(--green-soft)] text-[var(--green)]",
  amber: "bg-[var(--amber-soft)] text-[var(--amber)]",
  coral: "bg-[var(--coral-soft)] text-[var(--coral)]",
} as const;

function Row({ label, hint, value, tone }: { label: string; hint: string; value: string; tone: keyof typeof ROW_TONES }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-5 py-3.5 sm:px-6">
      <div className="min-w-0"><b className="text-[14px] font-semibold text-text">{label}</b><p className="text-[12.5px] text-text-2">{hint}</p></div>
      <span className={cx("rounded-[8px] px-2.5 py-1 text-[12.5px] font-semibold", ROW_TONES[tone])}>{value}</span>
    </li>
  );
}

function LinkRow({ href, label, hint }: { href: string; label: string; hint: string }) {
  return (
    <li>
      <Link href={href} className="flex items-center justify-between gap-3 px-5 py-4 transition hover:bg-surface-2 sm:px-6">
        <span><b className="block text-[14px] font-semibold text-text">{label}</b><span className="text-[12.5px] text-text-2">{hint}</span></span>
        <Icon name="chevR" size={16} className="text-text-3" />
      </Link>
    </li>
  );
}

function Segmented({ value, options, onChange }: { value: string; options: [string, string][]; onChange: (value: string) => void }) {
  return (
    <div className="inline-flex shrink-0 gap-1 rounded-[12px] border border-line bg-surface-2 p-1" role="group">
      {options.map(([key, label]) => (
        <button key={key} type="button" aria-pressed={value === key} onClick={() => onChange(key)}
          className={cx("rounded-[9px] px-4 py-1.5 text-[13.5px] font-semibold transition", value === key ? "bg-surface text-text shadow-[var(--shadow-sm)]" : "text-text-2 hover:text-text")}>
          {label}
        </button>
      ))}
    </div>
  );
}
