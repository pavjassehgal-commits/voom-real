"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { replenishPlanDescription } from "@/lib/voom/automation";
import { CADENCES, CADENCE_LABELS, DEFAULT_HORIZON_DAYS, type Cadence } from "@/lib/voom/cadence";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { addDays, formatLocalDate } from "@/lib/voom/timezone";
import { PlanItemCard } from "@/components/voom/operating/PlanItemCard";
// TEMPORARY: planning-only preview control, dev-flag gated. Remove with
// lib/voom/planning-only-preview.ts when the experiment ends.
import { PlanningOnlyPreviewCard } from "@/components/voom/operating/PlanningOnlyPreview";
import type { PlanReplenishOutcome } from "@/lib/voom/workflow/marketing-plan";
import { ChannelPill, QuietState } from "@/components/voom/workspace/ui";
import { BTN, ChannelGlyph, PageHeader, StatCard, StatusChip } from "@/components/voom/redesign/ui";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { channelIdentity, stateGroup, STATE_GROUP_LABELS } from "@/lib/voom/workflow/presentation";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";

/**
 * The preview control is a developer/test-only affordance. It stays available
 * for the current controlled workflow testing, but normal production users
 * never see it unless NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW=1 is set.
 */
const SHOW_PLANNING_PREVIEW = process.env.NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW === "1";

/** The truthful readiness of one channel's provider connection, read server-side. */
export interface ChannelReadiness {
  channel: "instagram" | "tiktok" | "youtube";
  connected: boolean;
  configured: boolean;
}

/**
 * The Marketing Plan is the strategy surface: Voom's plan for the next seven
 * days — which platform, which native format, which concept, what each piece
 * is for, and exactly how far along it is.
 *
 * It renders the real rolling horizon of executable workflow items — the same
 * items Today, Approvals, the Content Calendar and the publishing queue act on.
 * Every value comes from the existing authoritative read models:
 *   - `snapshot` — `marketingPlanSnapshot(loadWorkflowSnapshot(...))`
 *     (only the current rolling horizon is shown, exactly as before),
 *   - `uncoveredDates` — the coordinator's own `gaps[].date` evaluation,
 *   - `channelReadiness` — the existing per-provider connection rows.
 * Nothing here recomputes coverage, cadence, channel assignment or state.
 */
export function PlanWorkspace({
  initial,
  uncoveredDates = [],
  channelReadiness = [],
}: {
  initial: WorkflowSnapshot;
  /** The coordinator's authoritative uncovered local dates inside the horizon. */
  uncoveredDates?: string[];
  /** Existing connection truth per selected social channel (never assumed). */
  channelReadiness?: ChannelReadiness[];
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [cadence, setCadence] = useState<Cadence>(initial.cadence);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // AI Media Spend Control: the truthful reason a run left items waiting for
  // media (automatic generation off, or the month's budget reached).
  const [spendNotice, setSpendNotice] = useState("");
  const [outcome, setOutcome] = useState<PlanReplenishOutcome | null>(null);

  const refresh = useCallback((next: WorkflowSnapshot) => setSnapshot(next), []);

  async function build(next: Cadence) {
    setBusy(true); setError(""); setSpendNotice(""); setOutcome(null);
    try {
      const response = await fetch("/api/plan", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cadence: next }),
      });
      const body = await response.json() as {
        snapshot?: WorkflowSnapshot;
        outcome?: PlanReplenishOutcome;
        error?: string;
        mediaSpendNotice?: string | null;
      };
      const authoritativeOutcome = body.outcome ?? {
        state: "failed", added: 0, horizonStart: null, horizonEnd: null, addedChannelFormats: [],
      } satisfies PlanReplenishOutcome;
      setOutcome(authoritativeOutcome);
      if (response.ok && body.snapshot && authoritativeOutcome.state !== "failed") {
        setSnapshot(body.snapshot);
        setCadence(body.snapshot.cadence);
        setSpendNotice(body.mediaSpendNotice ?? "");
        window.dispatchEvent(new Event("voom:data-changed"));
      } else if (authoritativeOutcome.state === "failed") {
        setError(body.error ?? "Your existing plan hasn't been changed. Try again.");
      }
    } catch {
      setOutcome({ state: "failed", added: 0, horizonStart: null, horizonEnd: null, addedChannelFormats: [] });
      setError("Your existing plan hasn't been changed. Try again.");
    } finally {
      setBusy(false);
    }
  }

  const byDay = useMemo(() => groupByDay(snapshot.items), [snapshot.items]);
  const itemsPerDay = useMemo(() => new Map(byDay.map(([day, items]) => [day, items])), [byDay]);
  const uncovered = useMemo(() => new Set(uncoveredDates), [uncoveredDates]);
  const horizon = useMemo(() => horizonDates(snapshot.today, uncovered, itemsPerDay), [snapshot.today, uncovered, itemsPerDay]);
  const mix = useMemo(() => mixCounts(snapshot.items), [snapshot.items]);
  const attention = snapshot.items.filter((item) => ["failed", "missed", "media_delayed", "media_timed_out"].includes(item.status));
  const waiting = snapshot.items.filter((item) => item.status === "needs_approval" || item.status === "waiting_for_media" || item.status === "ready_for_review");
  const horizonLabel = `${shortDate(snapshot.today)} – ${shortDate(addDays(snapshot.today, DEFAULT_HORIZON_DAYS - 1))}`;
  const uncoveredInHorizon = horizon.filter((day) => day.uncovered && day.date >= snapshot.today);

  const [view, setView] = useState<"week" | "list">("week");
  const [channelFilter, setChannelFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [openId, setOpenId] = useState<string | null>(null);
  const { open: openModal } = useModal();
  const visible = (items: WorkflowView[]) => items.filter((item) =>
    (channelFilter === "all" || item.channel === channelFilter)
    && (statusFilter === "all" || stateGroup(item.status) === statusFilter));
  const statusOptions = [...new Set(snapshot.items.map((item) => stateGroup(item.status)))];
  const selected = openId ? snapshot.items.find((item) => item.draftId === openId) ?? null : null;
  const buildLabel = busy ? "Building…" : outcome?.state === "already_up_to_date" ? "✓ Plan up to date" : snapshot.items.length ? "Replenish plan" : "Build plan";
  const addContent = () => openModal(<CreateContentModal onChanged={() => window.dispatchEvent(new Event("voom:data-changed"))} />);

  return (
    <div className="min-w-0">
      <PageHeader
        title="Your next 7 days, planned."
        subtitle={snapshot.items.length
          ? "One plan across every channel. Review it, edit it, or let MARA replenish it."
          : "One plan across every channel. Build it, review it, or let MARA replenish it."}
        actions={<>
          <span className="voom-card flex items-center gap-3 px-4 py-2.5">
            <Icon name="cal" size={18} className="text-text-2" />
            <span><span className="block text-[14px] font-semibold text-text">Rolling 7-day · {horizonLabel}</span><span className="block text-[12.5px] text-text-2">{snapshot.items.length} post{snapshot.items.length === 1 ? "" : "s"} · {modeLabel(snapshot.mode)} · {snapshot.timeZone.replace("_", " ")}</span></span>
          </span>
          <button type="button" className={BTN.primary} disabled={busy} onClick={() => void build(cadence)}><Icon name="sparkle" size={14} />{buildLabel}</button>
        </>}
      />

      {snapshot.selectedChannels.length === 0 && (
        <div role="status" className="mb-4 rounded-[16px] border border-[var(--amber)]/30 bg-[var(--amber-soft)] px-4 py-3 text-[14px] text-[var(--amber)]">
          <p className="font-semibold">Choose your marketing channels</p>
          <p className="mt-0.5 text-text-2">Select at least one social channel before building your Marketing Plan. <a href="/app/settings" className="font-semibold underline">Update channel preferences</a>.</p>
        </div>
      )}

      {/* TEMPORARY: planning-only preview control — dev-flag gated. */}
      {SHOW_PLANNING_PREVIEW && <PlanningOnlyPreviewCard className="mb-4" />}

      {outcome && outcome.state !== "no_supported_social_channels_selected" && <PlanOutcomeNotice outcome={outcome} error={error} />}
      {error && !outcome && <p role="alert" className="mb-4 rounded-[16px] border border-[var(--red)]/30 bg-[var(--red-soft)] px-4 py-3 text-[14px] text-[var(--red)]">{error}</p>}
      {/* A blocked automatic generation is not an error: the plan and its drafts
          were created, and only the media waits for the owner's decision. */}
      {spendNotice && <p role="status" className="mb-4 rounded-[16px] border border-[var(--amber)]/30 bg-[var(--amber-soft)] px-4 py-3 text-[14px] text-[var(--amber)]">{spendNotice}</p>}

      <div className="mb-5 flex min-w-0 flex-wrap items-center gap-2.5">
        <div className="flex rounded-full border border-line bg-surface p-1" role="group" aria-label="Plan layout">
          {(["week", "list"] as const).map((mode) => (
            <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)}
              className={cx("rounded-full px-4 py-1.5 text-[14px] font-medium transition", view === mode ? "bg-[var(--brand-soft)] font-semibold text-[var(--brand-ink)]" : "text-text-2 hover:text-text")}>
              {mode === "week" ? "Week" : "List"}
            </button>
          ))}
        </div>
        <label className="sr-only" htmlFor="plan-channel">Channels</label>
        <select id="plan-channel" value={channelFilter} onChange={(event) => setChannelFilter(event.target.value)} className={cx(BTN.field, "rounded-full")}>
          <option value="all">Channels: All</option>
          {snapshot.selectedChannels.map((channel) => <option key={channel} value={channel}>{channelIdentity(channel).label}</option>)}
        </select>
        <label className="sr-only" htmlFor="plan-status">Status</label>
        <select id="plan-status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} className={cx(BTN.field, "rounded-full")}>
          <option value="all">Status: All</option>
          {statusOptions.map((group) => <option key={group} value={group}>{STATE_GROUP_LABELS[group]}</option>)}
        </select>
      </div>

      {view === "week" && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:gap-4 xl:grid-cols-4">
          <StatCard icon="cal" value={snapshot.items.length} label="Planned posts" tone="brand" />
          <StatCard icon="warn" value={uncoveredInHorizon.length} label="Days with no content" tone="coral" note={uncoveredInHorizon.length ? <span className="text-[var(--coral)]">Need your attention</span> : undefined} />
          <StatCard icon="checkCircle" value={waiting.length} label="Waiting on you" tone="blue" />
          <StatCard icon="bolt" value={attention.length} label="Need attention" tone={attention.length ? "coral" : "green"} />
        </div>
      )}

      <section className="voom-card min-w-0 p-4 sm:p-5" aria-labelledby="plan-title">
        <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="plan-title" className="text-[17px] font-semibold text-text">Seven-day plan · {horizonLabel}</h2>
          {mix.length > 0 && <div className="flex flex-wrap gap-1.5">{mix.map((entry) => <ChannelPill key={entry.key} channel={entry.channel} format={entry.format} dense />)}</div>}
        </div>
        {!snapshot.items.length ? (
          <QuietState icon="spark" title="Build your rolling marketing plan">
            <p>Voom creates one executable item per slot for the next 7 days, starting today, using your brand, goal and chosen posting frequency.</p>
            <p className="mt-1.5 text-text-3">{replenishPlanDescription(snapshot.mode)}</p>
            <div className="mt-4"><button type="button" className={BTN.primary} disabled={busy} onClick={() => void build(cadence)}><Icon name="sparkle" size={14} />{busy ? "Building your plan…" : "Build plan"}</button></div>
          </QuietState>
        ) : view === "week" ? (
          <div className="min-w-0">
            <ol className="grid grid-cols-[minmax(0,1fr)] gap-2 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7" aria-label="Seven-day plan by day">
              {horizon.map((day) => {
                const dayItems = visible(itemsPerDay.get(day.date) ?? []);
                return (
                  <li key={day.date} className="flex min-w-0 flex-col rounded-[16px] border border-line">
                    <div className="border-b border-line px-2 py-3 text-center">
                      <div className="text-[14px] font-semibold text-text">{day.weekday}</div>
                      <div className="text-[12.5px] text-text-2">{shortDate(day.date)}</div>
                      <span className={cx("mt-1.5 inline-block rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold",
                        day.isToday ? "voom-create-btn text-white" : day.uncovered ? "bg-[var(--coral-soft)] text-[var(--coral)]" : dayItems.length ? "bg-[var(--brand-soft)] text-[var(--brand-ink)]" : "bg-surface-3 text-text-3")}>
                        {dayItems.length ? `${dayItems.length} post${dayItems.length === 1 ? "" : "s"}` : day.uncovered ? "No content" : "Free"}{day.isToday ? " · Today" : ""}
                      </span>
                    </div>
                    <div className="flex flex-1 flex-col gap-2.5 p-2">
                      {dayItems.map((item) => <WeekCard key={item.draftId} item={item} onOpen={() => setOpenId(item.draftId)} />)}
                      {day.uncovered && dayItems.length === 0 ? (
                        <div className="rounded-[14px] border border-dashed border-[var(--coral)]/40 bg-[var(--coral-soft)] p-3 text-center">
                          <Icon name="warn" size={18} className="mx-auto text-[var(--coral)]" />
                          <p className="mt-1.5 text-[12.5px] font-medium text-[var(--coral)]">No content planned</p>
                          <button type="button" onClick={addContent} className="mt-2 w-full rounded-[10px] border border-[var(--brand-line)] bg-surface px-2 py-1.5 text-[12.5px] font-semibold text-[var(--brand-ink)]">Create post</button>
                          <button type="button" disabled={busy} onClick={() => void build(cadence)} className="mt-1.5 w-full text-[12.5px] font-semibold text-[var(--coral)] hover:underline">Fill with MARA</button>
                        </div>
                      ) : (
                        <button type="button" onClick={addContent} className="grid min-h-[96px] place-items-center rounded-[14px] border border-dashed border-line-2 text-[12.5px] text-text-2 transition hover:border-[var(--brand-line)] hover:text-[var(--brand-ink)]">
                          <span className="flex flex-col items-center gap-1.5"><span className="grid h-7 w-7 place-items-center rounded-full border border-line-2"><Icon name="plus" size={13} /></span>Add content</span>
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-[14px]">
              <thead className="text-[11.5px] uppercase tracking-[0.12em] text-text-3">
                <tr className="border-b border-line"><th className="py-3 pr-3 font-semibold">Content</th><th className="py-3 pr-3 font-semibold">Channel</th><th className="py-3 pr-3 font-semibold">Date and time</th><th className="py-3 pr-3 font-semibold">Status</th><th className="py-3 font-semibold"><span className="sr-only">Open</span></th></tr>
              </thead>
              <tbody>
                {visible(snapshot.items).map((item) => (
                  <tr key={item.draftId} className="border-b border-line last:border-b-0">
                    <td className="py-3 pr-3">
                      <span className="flex min-w-0 items-center gap-3">
                        <Thumb item={item} />
                        <span className="min-w-0"><span className="block max-w-[280px] truncate font-semibold text-text">{item.concept}</span><span className="block text-[12.5px] text-text-2">{item.contentTypeLabel}</span></span>
                      </span>
                    </td>
                    <td className="py-3 pr-3"><ChannelGlyph channel={item.channel} size={22} /></td>
                    <td className="py-3 pr-3 text-text-2">{item.dayLabel}, {formatLocalDate(item.localDate)}<span className="block text-[12.5px] text-text-3">{item.localTime || "No time set"}</span></td>
                    <td className="py-3 pr-3"><StatusChip status={item.status} label={item.statusLabel} small /></td>
                    <td className="py-3 text-right"><button type="button" onClick={() => setOpenId(item.draftId)} className="rounded-full border border-[var(--brand-line)] px-3.5 py-1.5 text-[13px] font-semibold text-[var(--brand-ink)] hover:bg-[var(--brand-soft-2)]">Open</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[13.5px] text-text-2">Showing {visible(snapshot.items).length} of {snapshot.items.length} posts in this plan</p>
          </div>
        )}
        {uncoveredInHorizon.length > 0 && (
          <div className="mt-4 flex min-w-0 flex-wrap items-start justify-between gap-3 rounded-[16px] bg-[var(--coral-soft)] p-4">
            <div className="min-w-0">
              <p className="text-[14px] font-semibold text-[var(--coral)]">{uncoveredInHorizon.length} uncovered date{uncoveredInHorizon.length === 1 ? "" : "s"} in this horizon</p>
              <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">{uncoveredInHorizon.map((day) => day.label).join(" · ")} — Voom has no executable item on these dates. Replenish asks the existing rolling planner to fill them.</p>
            </div>
            <button type="button" className={BTN.outline} disabled={busy} onClick={() => void build(cadence)}><Icon name="sparkle" size={14} /> Replenish plan</button>
          </div>
        )}
      </section>

      <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-2">
        <section className="voom-card p-5 sm:p-6" aria-labelledby="plan-mix">
          <h2 id="plan-mix" className="text-[16px] font-semibold text-text">This week’s mix</h2>
          <p className="mt-1 text-[13.5px] text-text-2">{CADENCE_LABELS[snapshot.cadence]} · {describeMix(mix)}</p>
          <ul className="mt-4 space-y-3">
            {(snapshot.selectedChannels.length ? snapshot.selectedChannels : [...new Set(snapshot.items.map((item) => item.channel))]).map((channel) => {
              const count = snapshot.items.filter((item) => item.channel === channel).length;
              const readiness = channelReadiness.find((entry) => entry.channel === channel);
              return (
                <li key={channel} className="flex items-center gap-3 text-[14px]">
                  <ChannelGlyph channel={channel} size={20} />
                  <span className="w-24 shrink-0 text-text">{channelIdentity(channel).label}</span>
                  <span className="h-2 flex-1 overflow-hidden rounded-full bg-surface-3"><span className="block h-full rounded-full bg-[linear-gradient(90deg,#8f5cfb,#d062f1)]" style={{ width: `${snapshot.items.length ? (count / snapshot.items.length) * 100 : 0}%` }} /></span>
                  <span className="w-8 text-right font-semibold text-text">{count}</span>
                  {readiness && <span className={cx("w-28 text-right text-[12px]", readiness.connected ? "text-[var(--green)]" : "text-text-3")}>{readiness.connected ? "connected" : readiness.configured ? "not connected" : "not configured"}</span>}
                </li>
              );
            })}
          </ul>
          {channelReadiness.length > 0 && <ReadinessNote readiness={channelReadiness} />}
        </section>

        <section className="voom-card p-5 sm:p-6" aria-labelledby="plan-frequency-title">
          <h2 id="plan-frequency-title" className="text-[16px] font-semibold text-text">Posting frequency</h2>
          <p className="mt-1 text-[13.5px] leading-relaxed text-text-2">{replenishPlanDescription(snapshot.mode)}</p>
          <div id="plan-frequency" className="mt-4 flex flex-wrap gap-2">
            {CADENCES.map((value) => (
              <button key={value} type="button" disabled={busy} onClick={() => { setCadence(value); void build(value); }} aria-pressed={value === cadence}
                className={cx("rounded-full border px-3.5 py-1.5 text-[13.5px] font-semibold transition disabled:opacity-50",
                  value === cadence ? "border-transparent voom-create-btn text-white" : "border-line bg-surface text-text-2 hover:border-[var(--brand-line)] hover:text-text")}>
                {CADENCE_LABELS[value]}
              </button>
            ))}
          </div>
          <p className="mt-3 text-[12.5px] leading-relaxed text-text-3">Changing this changes how many items Voom keeps ready in the next 7 days. Existing items for a date are reused, never duplicated.</p>
          {snapshot.planGoal && <p className="mt-3 text-[13px] text-text-2"><b className="font-semibold text-text">Goal:</b> {snapshot.planGoal}</p>}
        </section>
      </div>

      <p className="mt-5 text-[13px] leading-relaxed text-text-3">
        Every item above is the real item Voom will execute — produce, review, approve, schedule and publish it from here. It appears identically in{" "}
        <Link href="/app/today" className="font-semibold text-[var(--brand-ink)] hover:underline">Today</Link>,{" "}
        <Link href="/app/approvals" className="font-semibold text-[var(--brand-ink)] hover:underline">Approvals</Link> and the{" "}
        <Link href="/app/calendar" className="font-semibold text-[var(--brand-ink)] hover:underline">Content Calendar</Link>.
        Email keeps its own cadence in <Link href="/app/campaigns" className="font-semibold text-[var(--brand-ink)] hover:underline">Campaigns</Link> and{" "}
        <Link href="/app/automations" className="font-semibold text-[var(--brand-ink)] hover:underline">Email Flows</Link> — it never fills a social slot.
      </p>

      {selected && (
        <PlanItemDialog onClose={() => setOpenId(null)} title={selected.concept}>
          <ul className="min-w-0 divide-y divide-line">
            <PlanItemCard item={selected} mode={snapshot.mode} timeZone={snapshot.timeZone} onChanged={refresh} />
          </ul>
        </PlanItemDialog>
      )}
    </div>
  );
}

/** One plan item in the week grid; opening it shows the full item actions. */
function WeekCard({ item, onOpen }: { item: WorkflowView; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="min-w-0 overflow-hidden rounded-[14px] border border-line bg-surface text-left transition hover:border-[var(--brand-line)] hover:shadow-[var(--shadow)]">
      <span className="relative block h-[72px] bg-surface-3">
        {item.mediaPreviewUrl && !item.mediaMimeType?.startsWith("video")
          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
          ? <img src={item.mediaPreviewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
          : null}
        <span className="absolute bottom-1.5 left-1.5"><ChannelGlyph channel={item.channel} size={18} /></span>
      </span>
      <span className="block px-2.5 py-2">
        <span className="line-clamp-2 text-[13px] font-semibold leading-snug text-text">{item.concept}</span>
        <span className="mt-0.5 block text-[11.5px] text-text-3">{item.localTime || "No time set"}</span>
        <span className="mt-1.5 block"><StatusChip status={item.status} label={item.statusLabel} small /></span>
      </span>
    </button>
  );
}

function Thumb({ item }: { item: WorkflowView }) {
  return (
    <span className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-[var(--brand-soft)] text-[var(--brand-ink)]">
      {item.mediaPreviewUrl && !item.mediaMimeType?.startsWith("video")
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
        ? <img src={item.mediaPreviewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        : <Icon name={item.format === "post" ? "img" : "video"} size={16} />}
    </span>
  );
}

function PlanItemDialog({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-[rgba(26,31,48,0.35)] p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-label={title} onClick={onClose}>
      <div className="max-h-[88vh] w-full max-w-[720px] overflow-y-auto rounded-[22px] bg-surface p-4 shadow-[var(--shadow-lg)] sm:p-5" onClick={(event) => event.stopPropagation()}>
        <div className="mb-2 flex items-center justify-between gap-3">
          <h2 className="truncate text-[17px] font-semibold text-text">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-text-2 hover:bg-surface-3"><Icon name="x" size={16} /></button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ReadinessNote({ readiness }: { readiness: ChannelReadiness[] }) {
  const gaps = readiness.filter((entry) => !entry.connected);
  if (gaps.length === 0) return <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">Every planned social channel has a live provider connection, so approved items can publish.</p>;
  return <p className="mt-2 text-[11.5px] leading-relaxed text-text-3">
    {gaps.map((entry) => channelIdentity(entry.channel).label).join(", ")} {gaps.length === 1 ? "is" : "are"} not connected, so {gaps.length === 1 ? "its" : "their"} items keep planning here but cannot publish until you connect {gaps.length === 1 ? "it" : "them"} in{" "}
    <Link href="/app/connections" className="font-semibold text-brand hover:underline">Connections</Link>. Approved items are never queued for a provider that is not connected.
  </p>;
}

function PlanOutcomeNotice({ outcome, error }: { outcome: PlanReplenishOutcome; error: string }) {
  if (outcome.state === "failed") return <div role="alert" className="mb-3.5 rounded-2xl border border-red/35 bg-red/10 px-4 py-3 text-[13px] text-red">
    <p className="font-semibold">{"We couldn't replenish your plan"}</p>
    <p>{error || "Your existing plan hasn't been changed. Try again."}</p>
  </div>;
  if (outcome.state === "already_up_to_date") return <div role="status" className="mb-3.5 rounded-2xl border border-green/35 bg-green/10 px-4 py-3 text-[13px] text-green">
    <p className="font-semibold">Your marketing plan is already up to date</p>
    <p>You have complete marketing coverage{outcome.horizonEnd ? ` through ${formatLocalDate(outcome.horizonEnd)}` : " for the next 7 days"}. {"Voom will add more content when it's needed."}</p>
  </div>;
  if (outcome.state === "added") return <div role="status" className="mb-3.5 rounded-2xl border border-green/35 bg-green/10 px-4 py-3 text-[13px] text-green">
    <p className="font-semibold">Your plan is ready ✓</p>
    <p>Added {outcome.added} recommendation{outcome.added === 1 ? "" : "s"} for the next 7 days.</p>
    {outcome.addedChannelFormats.length > 0 && <p className="mt-1 text-xs">{outcome.addedChannelFormats.join(" · ")}</p>}
  </div>;
  return null;
}

/** The real dates of the rolling horizon, annotated from authoritative reads only. */
function horizonDates(today: string, uncovered: Set<string>, itemsPerDay: Map<string, WorkflowView[]>) {
  return Array.from({ length: DEFAULT_HORIZON_DAYS }, (_, index) => {
    const date = addDays(today, index);
    const items = itemsPerDay.get(date) ?? [];
    const channels = [...new Set(items.map((item) => item.channel))];
    return {
      date,
      label: formatLocalDate(date),
      weekday: new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(new Date(`${date}T12:00:00Z`)),
      dayNumber: String(Number(date.slice(-2))),
      channels,
      isToday: index === 0,
      uncovered: uncovered.has(date),
    };
  });
}

function groupByDay(items: WorkflowView[]): [string, WorkflowView[]][] {
  const map = new Map<string, WorkflowView[]>();
  for (const item of items) {
    const key = item.localDate || item.slotDate;
    map.set(key, [...(map.get(key) ?? []), item]);
  }
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** The native mix of the plan — one entry per real channel/format pair. */
function mixCounts(items: WorkflowView[]): { key: string; channel: string; format: string; count: number }[] {
  const map = new Map<string, { key: string; channel: string; format: string; count: number }>();
  for (const item of items) {
    const key = `${item.channel}:${item.format}`;
    const existing = map.get(key);
    map.set(key, existing ? { ...existing, count: existing.count + 1 } : { key, channel: item.channel, format: item.format, count: 1 });
  }
  return [...map.values()].sort((a, b) => b.count - a.count);
}

function describeMix(mix: { count: number; channel: string; format: string }[]): string {
  if (!mix.length) return "no content yet";
  return mix.map((entry) => `${entry.count} ${channelIdentity(entry.channel).label} ${formatWord(entry.format)}${entry.count === 1 ? "" : "s"}`).join(" · ");
}

function formatWord(format: string): string {
  if (format === "post") return "Post";
  if (format === "reel") return "Reel";
  if (format === "story") return "Story";
  if (format === "short") return "Short";
  return "Video";
}

function modeLabel(mode: WorkflowSnapshot["mode"]): string {
  return mode === "autopilot" ? "Autopilot" : mode === "assisted" ? "Assisted" : "Manual";
}

function shortDate(date: string): string {
  return formatLocalDate(date).replace(/\s+\d{4}$/, "");
}
