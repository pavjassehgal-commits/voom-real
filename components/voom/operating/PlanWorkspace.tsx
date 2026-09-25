"use client";

import { useCallback, useMemo, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { replenishPlanDescription } from "@/lib/voom/automation";
import { CADENCES, CADENCE_LABELS, DEFAULT_HORIZON_DAYS, type Cadence } from "@/lib/voom/cadence";
import type { WorkflowSnapshot, WorkflowView } from "@/lib/voom/workflow/read";
import { addDays, formatLocalDate } from "@/lib/voom/timezone";
import { PlanItemCard } from "@/components/voom/operating/PlanItemCard";
// TEMPORARY: planning-only preview control, dev-flag gated. Remove with
// lib/voom/planning-only-preview.ts when the experiment ends.
import { PlanningOnlyPreviewCard } from "@/components/voom/operating/PlanningOnlyPreview";
import type { PlanReplenishOutcome } from "@/lib/voom/workflow/marketing-plan";
import {
  ChannelPill,
  MetaChip,
  Panel,
  PanelHead,
  QuietState,
  SectionLabel,
  WorkspaceFrame,
  WorkspaceHeader,
} from "@/components/voom/workspace/ui";
import { channelIdentity } from "@/lib/voom/workflow/presentation";

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

  return (
    <WorkspaceFrame>
      <WorkspaceHeader
        eyebrow="Marketing Plan"
        title="The next seven days, decided."
        question={snapshot.items.length
          ? `Voom's strategy for ${horizonLabel}: ${describeMix(mix)} across ${byDay.length} planned day${byDay.length === 1 ? "" : "s"}.`
          : "Voom's strategy for your next seven days: one executable piece per slot, on the platforms you chose."}
        description={snapshot.planGoal ? `Goal: ${snapshot.planGoal}` : "No goal set yet — Voom plans from your brand, channels and posting frequency."}
        meta={<>
          <MetaChip accent>
            <Icon name="cal" size={12} /> Rolling {DEFAULT_HORIZON_DAYS}-day · {horizonLabel}
          </MetaChip>
          <MetaChip>{CADENCE_LABELS[snapshot.cadence]}</MetaChip>
          <MetaChip>{snapshot.timeZone.replace("_", " ")}</MetaChip>
          <MetaChip>{modeLabel(snapshot.mode)}</MetaChip>
          {attention.length > 0 && <MetaChip><span className="text-[var(--amber)]">{attention.length} need{attention.length === 1 ? "s" : ""} attention</span></MetaChip>}
          {waiting.length > 0 && <MetaChip>{waiting.length} waiting on you</MetaChip>}
        </>}
        actions={<>
          <Btn variant="ghost" size="sm" onClick={() => document.getElementById("plan-frequency")?.scrollIntoView({ behavior: "smooth", block: "center" })}>
            <Icon name="cal" size={14} /> Posting frequency
          </Btn>
          <Btn variant="brand" size="sm" disabled={busy} onClick={() => void build(cadence)}>
            <Icon name="spark" size={14} />
            {busy ? "Building…" : outcome?.state === "already_up_to_date" ? "✓ Plan up to date" : snapshot.items.length ? "Replenish plan" : "Build plan"}
          </Btn>
        </>}
      />

      {snapshot.selectedChannels.length === 0 && (
        <div role="status" className="relative z-10 mb-4 rounded-2xl border border-amber/35 bg-amber/10 px-4 py-3 text-[13px] text-amber">
          <p className="font-semibold">Choose your marketing channels</p>
          <p className="mt-0.5 text-text-2">Select at least one social channel before building your Marketing Plan. <a href="/app/settings" className="font-semibold underline">Update channel preferences</a>.</p>
        </div>
      )}

      {/* ── Strategy surface: horizon, coverage, controls ───────────────── */}
      <Panel className="relative z-10 mb-3.5" padded={false}>
        <div className="grid min-w-0 gap-0 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="min-w-0 border-b border-line p-4 sm:p-5 lg:border-b-0 lg:border-r">
            <PanelHead
              icon="cal"
              title="Rolling horizon"
              hint={`Starts ${formatLocalDate(snapshot.today)} · every date below is the account's own local date`}
            />
            <div className="mt-4 grid grid-cols-7 gap-1 sm:gap-1.5" aria-label="Seven-day marketing coverage">
              {horizon.map((day) => (
                <div key={day.date} className="min-w-0">
                  <span className="block truncate text-center text-[9.5px] font-bold uppercase tracking-[0.08em] text-text-3">{day.weekday}</span>
                  <div
                    className={[
                      "mt-1.5 grid min-h-[52px] min-w-0 grid-rows-[auto_1fr] gap-1 rounded-[13px] border p-1.5 transition",
                      day.isToday ? "border-transparent voom-grad text-white shadow-[0_8px_20px_-12px_rgba(105,75,255,.9)]" : "border-line bg-surface-2",
                      !day.isToday && day.uncovered ? "border-amber/45 bg-[var(--amber-soft)]" : "",
                    ].join(" ")}
                  >
                    <span className={["text-[11.5px] font-bold leading-none", day.isToday ? "text-white" : "text-text-2"].join(" ")}>{day.dayNumber}</span>
                    <span className="flex min-w-0 flex-col justify-end gap-0.5">
                      {day.channels.map((channel) => (
                        <span key={channel} className="flex min-w-0 items-center gap-1">
                          <span aria-hidden="true" className="h-1.5 w-1.5 flex-none rounded-full" style={{ background: day.isToday ? "rgba(255,255,255,.92)" : channelIdentity(channel).accent }} />
                          <span className={["truncate text-[8.5px] font-semibold", day.isToday ? "text-white/90" : "text-text-3"].join(" ")}>{channelIdentity(channel).short}</span>
                        </span>
                      ))}
                      {day.channels.length === 0 && (
                        <span className={["text-[8.5px] font-semibold leading-tight", day.isToday ? "text-white/85" : day.uncovered ? "text-[var(--amber)]" : "text-text-3"].join(" ")}>
                          {day.uncovered ? "Open" : "Free"}
                        </span>
                      )}
                    </span>
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-[11.5px] text-text-3">
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-text-3" aria-hidden="true" /><span>Free — no slot planned</span></span>
              <span className="inline-flex items-center gap-1.5"><span className="h-1.5 w-1.5 rounded-full bg-[var(--amber)]" aria-hidden="true" /><span>Open — Voom has not covered this date</span></span>
              <span className="inline-flex items-center gap-1.5"><span className="voom-grad h-1.5 w-1.5 rounded-full" aria-hidden="true" /><span>Today</span></span>
            </div>
          </div>

          <div className="min-w-0 p-4 sm:p-5">
            <PanelHead
              icon="spark"
              title={snapshot.items.length ? "Replenish" : "Build the plan"}
              hint={replenishPlanDescription(snapshot.mode)}
            />
            <div id="plan-frequency" className="mt-4">
              <SectionLabel>Posting frequency</SectionLabel>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {CADENCES.map((value) => (
                  <button
                    key={value}
                    type="button"
                    disabled={busy}
                    onClick={() => { setCadence(value); void build(value); }}
                    aria-pressed={value === cadence}
                    className={[
                      "rounded-full border px-3 py-1.5 text-[12.5px] font-semibold transition disabled:opacity-50",
                      value === cadence
                        ? "border-transparent voom-grad text-white shadow-[0_8px_22px_-14px_rgba(104,79,255,.9)]"
                        : "border-line bg-surface-2 text-text-2 hover:border-line-2 hover:text-text",
                    ].join(" ")}
                  >
                    {CADENCE_LABELS[value]}
                  </button>
                ))}
              </div>
              <p className="mt-2 text-[12px] leading-relaxed text-text-3">
                Changing this changes how many items Voom keeps ready in the next 7 days. Existing items for a date are reused, never duplicated.
              </p>
            </div>
            <div className="mt-4">
              <Btn variant="outline" size="sm" disabled={busy} onClick={() => void build(cadence)} className="w-full sm:w-auto">
                <Icon name="spark" size={14} />{busy ? "Building…" : outcome?.state === "already_up_to_date" ? "✓ Plan up to date" : snapshot.items.length ? "Replenish plan" : "Build plan"}
              </Btn>
            </div>
            {channelReadiness.length > 0 && (
              <div className="mt-4 border-t border-line pt-3">
                <SectionLabel>Channel readiness</SectionLabel>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {channelReadiness.map((entry) => (
                    <span
                      key={entry.channel}
                      className={[
                        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11.5px] font-semibold ring-1",
                        entry.connected ? "bg-[var(--green-soft)] text-[var(--green)] ring-[var(--green)]/20" : "bg-surface-2 text-text-3 ring-line",
                      ].join(" ")}
                    >
                      <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: channelIdentity(entry.channel).accent }} />
                      {channelIdentity(entry.channel).label}
                      <span className="font-medium">{entry.connected ? "connected" : entry.configured ? "not connected" : "not configured"}</span>
                    </span>
                  ))}
                </div>
                <ReadinessNote readiness={channelReadiness} />
              </div>
            )}
          </div>
        </div>
      </Panel>

      {/* TEMPORARY: planning-only preview control — dev-flag gated. */}
      {SHOW_PLANNING_PREVIEW && <PlanningOnlyPreviewCard className="relative z-10 mb-3.5" />}

      {outcome && outcome.state !== "no_supported_social_channels_selected" && <div className="relative z-10"><PlanOutcomeNotice outcome={outcome} error={error} /></div>}

      {error && !outcome && <p role="alert" className="relative z-10 mb-3.5 rounded-2xl border border-red/35 bg-red/10 px-4 py-3 text-[13px] text-red">{error}</p>}

      {/* A blocked automatic generation is not an error: the plan and its drafts
          were created, and only the media waits for the owner's decision. */}
      {spendNotice && <p role="status" className="relative z-10 mb-3.5 rounded-2xl border border-amber/35 bg-amber/10 px-4 py-3 text-[13px] text-amber">{spendNotice}</p>}

      {/* ── The strategy timeline ────────────────────────────────────────── */}
      <Panel className="relative z-10">
        <PanelHead
          icon="film"
          title="Seven-day plan"
          hint={snapshot.items.length ? `${snapshot.items.length} executable item${snapshot.items.length === 1 ? "" : "s"} · newest state first per day · every item is the same record Voom executes` : undefined}
          action={mix.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {mix.map((entry) => (
                <ChannelPill key={entry.key} channel={entry.channel} format={entry.format} dense className="opacity-95" />
              ))}
            </div>
          ) : undefined}
        />

        {snapshot.items.length ? (
          <div className="mt-4 min-w-0">
            <ol className="min-w-0 space-y-4">
              {byDay.map(([day, items]) => (
                <PlanDay key={day} day={day} items={items} snapshot={snapshot} onChanged={refresh} />
              ))}
            </ol>
            {uncoveredInHorizon.length > 0 && (
              <div className="mt-4 rounded-2xl border border-amber/35 bg-[var(--amber-soft)] p-4">
                <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="text-[12.5px] font-bold text-[var(--amber)]">{uncoveredInHorizon.length} uncovered date{uncoveredInHorizon.length === 1 ? "" : "s"} in this horizon</p>
                    <p className="mt-1 text-[12.5px] leading-relaxed text-text-2">
                      {uncoveredInHorizon.map((day) => day.label).join(" · ")} — Voom has no executable item on these dates. Replenish asks the existing rolling planner to fill them.
                    </p>
                  </div>
                  <Btn variant="outline" size="sm" disabled={busy} onClick={() => void build(cadence)}>
                    <Icon name="spark" size={14} /> Replenish plan
                  </Btn>
                </div>
              </div>
            )}
            <p className="mt-4 text-[12px] leading-relaxed text-text-3">
              Every row above is the real item Voom will execute — produce, review, approve, schedule and publish it from here. It appears identically in{" "}
              <Link href="/app/today" className="font-semibold text-brand hover:underline">Today</Link>,{" "}
              <Link href="/app/approvals" className="font-semibold text-brand hover:underline">Approvals</Link> and the{" "}
              <Link href="/app/calendar" className="font-semibold text-brand hover:underline">Content Calendar</Link>.
              Email keeps its own cadence in <Link href="/app/campaigns" className="font-semibold text-brand hover:underline">Campaigns</Link> and{" "}
              <Link href="/app/automations" className="font-semibold text-brand hover:underline">Email Flows</Link> — it never fills a social slot.
            </p>
          </div>
        ) : (
          <QuietState icon="spark" title="Build your rolling marketing plan">
            <p>Voom creates one executable item per slot for the next 7 days, starting today, using your brand, goal and chosen posting frequency.</p>
            <p className="mt-1.5 text-text-3">{replenishPlanDescription(snapshot.mode)}</p>
            <div className="mt-4">
              <Btn variant="brand" disabled={busy} onClick={() => void build(cadence)}>
                <Icon name="spark" size={15} />{busy ? "Building your plan…" : "Build plan"}
              </Btn>
            </div>
          </QuietState>
        )}
      </Panel>
    </WorkspaceFrame>
  );
}

function PlanDay({ day, items, snapshot, onChanged }: {
  day: string;
  items: WorkflowView[];
  snapshot: WorkflowSnapshot;
  onChanged: (snapshot: WorkflowSnapshot) => void;
}) {
  const first = items[0];
  const priority = items.filter((item) => ["needs_approval", "missed", "failed", "media_delayed", "media_timed_out"].includes(item.status));
  return (
    <li className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/60">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-2 border-b border-line px-3.5 py-2.5 sm:px-4">
        <div className="flex min-w-0 items-baseline gap-2">
          <b className="font-display text-[14px] font-semibold tracking-[-0.02em]">{first.dayLabel}</b>
          <span className="text-[12px] text-text-3">{formatLocalDate(day)}</span>
          {priority.length > 0 && <Tag tone="t-amber">{priority.length} waiting on you</Tag>}
        </div>
        <span className="text-[11.5px] text-text-3">{items.length} item{items.length === 1 ? "" : "s"}</span>
      </div>
      <ul className="min-w-0 divide-y divide-line px-2.5 sm:px-3">
        {items.map((item) => (
          <PlanItemCard key={item.draftId} item={item} mode={snapshot.mode} timeZone={snapshot.timeZone} onChanged={onChanged} />
        ))}
      </ul>
    </li>
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
