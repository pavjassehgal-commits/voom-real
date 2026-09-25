/**
 * Voom 2.0 workspace primitives — the shared presentation layer for the five
 * redesigned surfaces (Marketing Plan, Content Calendar, Create/Studio,
 * Performance, Approvals).
 *
 * Design rules inherited from the approved Today V2 page:
 *   - deep graphite glass in dark mode, luminous frosted glass in light mode;
 *   - refracted atmospheric light behind the workspace, never on top of it;
 *   - one restrained iridescent band per channel identity, semantic
 *     green/amber/red/blue reserved for real state;
 *   - strong hierarchy, concise copy, restrained depth.
 *
 * IMPORTANT (server/client boundary): this module is deliberately a SERVER-SAFE
 * module — no `"use client"`, no hooks, no event handlers. Server components
 * may render these directly (the bug we are guarding against is a server
 * component invoking a helper that only exists behind a client-module proxy),
 * and client components may use them too. Interactive behaviour belongs in the
 * calling client component, or in a native <details> element.
 */

import type { ReactNode } from "react";
import { Icon } from "@/components/voom/icons";
import { cx } from "@/lib/voom/cx";
import { channelClasses, channelIdentity, TONE_CLASSES, workflowTone } from "@/lib/voom/workflow/presentation";

/* ──────────────────────────────────────────────────────────────
   Atmosphere — decorative light volumes, inert and always behind content
   ────────────────────────────────────────────────────────────── */

export function WorkspaceAtmosphere({ className }: { className?: string }) {
  return (
    <div aria-hidden="true" className={cx("ws-atmosphere pointer-events-none absolute inset-0 -z-10 overflow-hidden rounded-[28px]", className)}>
      <div className="ws-spectrum absolute -right-20 -top-32 h-[300px] w-[460px] opacity-70 blur-[2px]" />
      <div className="ws-aurora absolute -left-24 top-[42%] h-[260px] w-[420px] opacity-50 blur-3xl" />
      <div className="ws-orbit absolute right-[8%] top-6 hidden h-20 w-20 rounded-full lg:block" />
    </div>
  );
}

/** The workspace page shell: atmosphere + the one header treatment. */
export function WorkspaceFrame({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("ws-frame relative isolate -mx-1 overflow-hidden rounded-[28px] px-1 pb-2 lg:-mt-1", className)}>
      <WorkspaceAtmosphere />
      {children}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────
   Header
   ────────────────────────────────────────────────────────────── */

export function WorkspaceHeader({
  eyebrow,
  title,
  question,
  description,
  meta,
  actions,
}: {
  eyebrow: string;
  title: ReactNode;
  /** The primary question this page answers, in one short sentence. */
  question?: ReactNode;
  description?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="relative z-10 flex min-w-0 flex-col gap-4 pb-5 pt-1 lg:flex-row lg:items-end lg:justify-between lg:gap-6">
      <div className="min-w-0">
        <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-[0.16em] text-text-3">{eyebrow}</p>
        <h1 className="font-display text-[clamp(1.6rem,3.1vw,2.5rem)] font-semibold leading-[1.02] tracking-[-0.05em] text-text">{title}</h1>
        {question && <p className="mt-2 max-w-3xl text-[clamp(0.95rem,1.5vw,1.1rem)] leading-snug text-text-2">{question}</p>}
        {description && <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-3">{description}</p>}
        {meta && <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">{meta}</div>}
      </div>
      {actions && <div className="flex w-full min-w-0 flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">{actions}</div>}
    </header>
  );
}

export function MetaChip({ children, accent }: { children: ReactNode; accent?: boolean }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11.5px] font-semibold tracking-[-0.01em]",
        accent
          ? "border-transparent bg-[var(--brand-soft)] text-brand"
          : "border-line bg-[var(--surface)]/70 text-text-2 backdrop-blur",
      )}
    >
      {children}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Panels & sections
   ────────────────────────────────────────────────────────────── */

export function Panel({
  children,
  className,
  padded = true,
  as: Tag = "section",
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
  as?: "section" | "div" | "article";
}) {
  return (
    <Tag className={cx("ws-panel relative min-w-0 rounded-[22px] border border-line", padded && "p-4 sm:p-5", className)}>
      {children}
    </Tag>
  );
}

export function PanelHead({
  icon,
  title,
  hint,
  action,
  className,
}: {
  icon?: string;
  title: ReactNode;
  hint?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex min-w-0 flex-wrap items-start justify-between gap-2.5", className)}>
      <div className="flex min-w-0 items-start gap-2.5">
        {icon && (
          <span className="mt-0.5 grid h-8 w-8 flex-none place-items-center rounded-xl bg-[var(--brand-soft)] text-brand">
            <Icon name={icon} size={15} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="font-display text-[15px] font-semibold leading-tight tracking-[-0.02em] text-text">{title}</h2>
          {hint && <p className="mt-1 text-[12px] leading-relaxed text-text-3">{hint}</p>}
        </div>
      </div>
      {action && <div className="flex min-w-0 flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
  return <p className={cx("text-[11px] font-bold uppercase tracking-[0.13em] text-text-3", className)}>{children}</p>;
}

/* ──────────────────────────────────────────────────────────────
   Channel + state identity
   ────────────────────────────────────────────────────────────── */

/** One channel/format identity, recognisable across every surface. */
export function ChannelPill({
  channel,
  format,
  dense,
  className,
}: {
  channel: string;
  format?: string;
  dense?: boolean;
  className?: string;
}) {
  const identity = channelIdentity(channel);
  const classes = channelClasses(channel);
  const formatLabel = format ? channelFormatLabelSafe(channel, format) : null;
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full ring-1",
        dense ? "px-2 py-[2px] text-[11px]" : "px-2.5 py-1 text-[11.5px]",
        "font-semibold tracking-[-0.01em]",
        classes.soft,
        classes.text,
        classes.ring,
        className,
      )}
    >
      <span aria-hidden="true" className={cx("h-1.5 w-1.5 flex-none rounded-full", classes.dot)} />
      <span className="truncate">{identity.label}</span>
      {formatLabel && <span className="truncate font-medium opacity-90">{formatLabel}</span>}
    </span>
  );
}

function channelFormatLabelSafe(channel: string, format: string): string | null {
  if (channel === "instagram") return format === "post" ? "Post" : format === "reel" ? "Reel" : format === "story" ? "Story" : null;
  if (channel === "tiktok") return format === "video" ? "Video" : null;
  if (channel === "youtube") return format === "short" ? "Short" : format === "video" ? "Video" : null;
  return null;
}

/**
 * The one workflow state pill. The label always comes from the shared
 * vocabulary (`WORKFLOW_STATUS_LABELS` / the queue-derived native label); the
 * tone always comes from the one presentation mapping.
 */
export function StatePill({ status, label, dense, className }: { status: string; label: string; dense?: boolean; className?: string }) {
  const classes = TONE_CLASSES[workflowTone(status)];
  return (
    <span
      className={cx(
        "inline-flex max-w-full items-center gap-1.5 rounded-full ring-1",
        dense ? "px-2 py-[2px] text-[11px]" : "px-2.5 py-1 text-[11.5px]",
        "font-semibold tracking-[-0.005em]",
        classes.soft,
        classes.text,
        classes.ring,
        className,
      )}
    >
      <span aria-hidden="true" className={cx("h-1.5 w-1.5 flex-none rounded-full", classes.dot)} />
      <span className="truncate">{label}</span>
    </span>
  );
}

/** Provider confirmation, shown only when the read model says it happened. */
export function ConfirmedPill({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--green-soft)] px-2.5 py-1 text-[11px] font-semibold text-[var(--green)] ring-1 ring-[var(--green)]/20">
      <Icon name="shield" size={11} />
      {label}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Small data displays — every mark is one real, already-computed value
   ────────────────────────────────────────────────────────────── */

export interface BarPoint {
  key: string;
  /** Real value; null renders as an intentional gap, never as zero. */
  value: number | null;
  label: string;
  accent?: string;
}

/**
 * Compact bar row: one bar per real measured item (or per real bucket). No
 * interpolation, no smoothing, no synthetic points — a missing value is a
 * hairline gap that keeps the timeline honest.
 */
export function MiniBars({ points, max, height = 64, className }: { points: BarPoint[]; max?: number; height?: number; className?: string }) {
  const peak = max ?? Math.max(1, ...points.map((point) => point.value ?? 0));
  return (
    <div className={cx("flex min-w-0 items-end gap-[3px] sm:gap-1", className)} style={{ height }} role="img"
      aria-label={points.map((point) => `${point.label}: ${point.value ?? "no value"}`).join("; ")}>
      {points.map((point) => {
        const ratio = point.value === null ? 0 : Math.max(0.04, point.value / peak);
        return (
          <span key={point.key} className="relative flex h-full min-w-0 flex-1 items-end" title={`${point.label}: ${point.value ?? "—"}`}>
            {point.value === null
              ? <span className="block h-[2px] w-full rounded-full bg-line-2" />
              : <span
                  className="block w-full rounded-t-[3px] transition-[height] duration-500"
                  style={{ height: `${Math.round(ratio * 100)}%`, background: point.accent ?? "var(--iridescent)" }}
                />}
          </span>
        );
      })}
    </div>
  );
}

/** A two-bar comparison (recent vs previous) built only from real numbers. */
export function ComparisonBar({
  recent, previous, recentLabel, previousLabel, accent = "var(--brand)",
}: {
  recent: number;
  previous: number;
  recentLabel: string;
  previousLabel: string;
  accent?: string;
}) {
  const peak = Math.max(recent, previous, 1);
  const rows = [
    { label: recentLabel, value: recent, muted: false },
    { label: previousLabel, value: previous, muted: true },
  ];
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.label} className="flex items-center gap-3">
          <span className="w-[92px] flex-none text-[11.5px] font-medium text-text-3">{row.label}</span>
          <span className="h-2.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-2">
            <span
              className="block h-full rounded-full"
              style={{ width: `${Math.max(2, Math.round((row.value / peak) * 100))}%`, background: row.muted ? "var(--line-strong)" : accent }}
            />
          </span>
          <span className="w-[64px] flex-none text-right text-[12px] font-semibold tabular-nums text-text">{formatCompact(row.value)}</span>
        </div>
      ))}
    </div>
  );
}

export function formatCompact(value: number): string {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(value % 1_000_000 === 0 ? 0 : 1)}M`;
  if (Math.abs(value) >= 10_000) return `${(value / 1000).toFixed(value % 1000 === 0 ? 0 : 1)}K`;
  return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** "How close is it to ready" — one dot per real precondition. */
export function ProgressDots({ steps, className }: { steps: { label: string; done: boolean; note?: string }[]; className?: string }) {
  const completed = steps.filter((step) => step.done).length;
  return (
    <div className={cx("min-w-0", className)}>
      <div className="flex items-center gap-2">
        <span className="flex items-center gap-1" aria-hidden="true">
          {steps.map((step) => (
            <span
              key={step.label}
              className={cx("h-1.5 w-4 rounded-full", step.done ? "voom-grad" : "bg-line-2")}
            />
          ))}
        </span>
        <span className="text-[11px] font-semibold text-text-3">{completed}/{steps.length} ready</span>
      </div>
      <span className="sr-only">
        {steps.map((step) => `${step.label}: ${step.done ? "done" : "not done"}`).join("; ")}
      </span>
    </div>
  );
}

/** A compact fact line: label above value, used instead of metric-card spam. */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <dt className="text-[11px] font-semibold uppercase tracking-[0.08em] text-text-3">{label}</dt>
      <dd className="mt-0.5 min-w-0 text-[13px] leading-snug text-text-2">{children}</dd>
    </div>
  );
}

/** The intentional empty / unavailable panel. */
export function QuietState({
  icon = "spark",
  title,
  children,
  action,
  className,
}: {
  icon?: string;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-start gap-3 px-1 py-6 sm:py-8", className)}>
      <span className="grid h-11 w-11 place-items-center rounded-2xl bg-surface-2 text-text-2 ring-1 ring-line">
        <Icon name={icon} size={19} />
      </span>
      <div className="min-w-0">
        <h3 className="font-display text-[16px] font-semibold tracking-[-0.02em] text-text">{title}</h3>
        {children && <div className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-text-2">{children}</div>}
      </div>
      {action && <div className="flex flex-wrap items-center gap-2">{action}</div>}
    </div>
  );
}

/** Native, dependency-free disclosure (works in server components). */
export function Disclosure({ summary, children, className }: { summary: ReactNode; children: ReactNode; className?: string }) {
  return (
    <details className={cx("ws-disclosure group min-w-0", className)}>
      <summary className="ws-disclosure-summary">
        <span className="min-w-0 truncate">{summary}</span>
        <Icon name="down" size={13} className="ws-disclosure-caret flex-none text-text-3" />
      </summary>
      <div className="mt-2.5 min-w-0">{children}</div>
    </details>
  );
}
