import type { ReactNode } from "react";
import { Icon } from "@/components/voom/icons";
import { cx } from "@/lib/voom/cx";
import { TONE_CLASSES, workflowTone } from "@/lib/voom/workflow/presentation";

/**
 * Shared redesign building blocks (Batch 1 design system, used by Batch 2).
 * Server-safe: no client hooks, so server and client screens can both use them.
 */

export type ChannelKey = "instagram" | "tiktok" | "youtube" | "email" | "other";

export function channelKey(value: string | null | undefined): ChannelKey {
  const key = (value ?? "").toLowerCase();
  if (key.startsWith("instagram") || key === "reel" || key === "story") return "instagram";
  if (key.startsWith("tiktok")) return "tiktok";
  if (key.startsWith("youtube")) return "youtube";
  if (key.startsWith("email")) return "email";
  return "other";
}

export const CHANNEL_NAMES: Record<ChannelKey, string> = {
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  email: "Email",
  other: "Channel",
};

/** Small network badges (Instagram, TikTok, YouTube, Email) in their own colours. */
export function ChannelGlyph({ channel, channelLabel, size = 20 }: { channel?: string; channelLabel?: string; size?: number }) {
  const kind = channelKey(channel ?? channelLabel);
  const label = kind === "other" ? channelLabel ?? "Channel" : CHANNEL_NAMES[kind];
  const frame = (background: string, children: ReactNode) => (
    <span className="grid shrink-0 place-items-center rounded-[6px] ring-2 ring-[var(--surface)]" style={{ width: size, height: size, background }} role="img" aria-label={label}>
      <svg viewBox="0 0 24 24" width={size * 0.62} height={size * 0.62} fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </span>
  );
  if (kind === "instagram") return frame("linear-gradient(135deg,#f9a03f 0%,#e1306c 50%,#833ab4 100%)", <><rect x="4" y="4" width="16" height="16" rx="5" /><circle cx="12" cy="12" r="3.6" /><circle cx="16.8" cy="7.2" r="0.9" fill="#fff" stroke="none" /></>);
  if (kind === "tiktok") return frame("#111111", <path d="M14 4v10.5a3.5 3.5 0 11-3.5-3.5M14 4c.6 2.6 2.4 4.1 5 4.3" />);
  if (kind === "youtube") return frame("#ff0033", <path d="M10 8.5l5.5 3.5-5.5 3.5z" fill="#fff" stroke="none" />);
  if (kind === "email") return frame("#2c6fb0", <><rect x="3.5" y="6" width="17" height="12" rx="2" /><path d="M4.5 7.5l7.5 5.5 7.5-5.5" /></>);
  return frame("var(--text-3)", <circle cx="12" cy="12" r="4" />);
}

/**
 * Status tone through the ONE shared mapping (lib/voom/workflow/presentation).
 * Publish-lifecycle states that the workflow vocabulary does not name are
 * first expressed as their workflow equivalent, so a state reads the same
 * colour on every screen.
 */
const PUBLISH_TO_WORKFLOW: Record<string, string> = {
  submitting: "publishing",
  provider_processing: "publishing",
  connection_required: "needs_approval",
  blocked: "waiting_for_media",
  rejected: "failed",
};

export function statusTone(status: string) {
  const tone = TONE_CLASSES[workflowTone(PUBLISH_TO_WORKFLOW[status] ?? status)];
  return `${tone.soft} ${tone.text}`;
}

export function StatusChip({ status, label, small = false, icon }: { status: string; label: string; small?: boolean; icon?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold", small ? "px-2 py-0.5 text-[11.5px]" : "px-3 py-1 text-[13px]", statusTone(status))}>
      {icon && <Icon name={icon} size={small ? 11 : 13} />}
      {label}
    </span>
  );
}

/** Page title block used across redesigned screens. */
export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <header className="mb-6 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
      <div className="min-w-0">
        {eyebrow && <div className="mb-1 text-[13px] text-text-2">{eyebrow}</div>}
        <h1 className="text-[clamp(1.75rem,3.2vw,2.25rem)] font-bold leading-[1.1] tracking-[-0.04em] text-text">{title}</h1>
        {subtitle && <div className="mt-1 text-[15.5px] text-text-2 sm:text-[16.5px]">{subtitle}</div>}
      </div>
      {actions && <div className="flex min-w-0 flex-wrap items-center gap-2.5">{actions}</div>}
    </header>
  );
}

const STAT_TONES = {
  brand: "bg-[var(--brand-soft)] text-[var(--brand-ink)]",
  blue: "bg-[var(--blue-soft)] text-[var(--blue)]",
  green: "bg-[var(--green-soft)] text-[var(--green)]",
  coral: "bg-[var(--coral-soft)] text-[var(--coral)]",
} as const;

export function StatCard({ icon, value, label, tone = "brand", note }: { icon: string; value: ReactNode; label: string; tone?: keyof typeof STAT_TONES; note?: ReactNode }) {
  return (
    <div className="voom-card flex min-w-0 items-center gap-4 p-5">
      <span className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-[14px]", STAT_TONES[tone])}><Icon name={icon} size={21} /></span>
      <div className="min-w-0">
        <div className="text-[26px] font-bold leading-none tracking-[-0.03em] text-text">{value}</div>
        <div className="mt-1 truncate text-[13.5px] text-text-2">{label}</div>
        {note && <div className="mt-1 text-[12px] font-semibold">{note}</div>}
      </div>
    </div>
  );
}

/** Compose → Preview → Schedule progress for the Create flow. */
export function CreateStepper({ step }: { step: 1 | 2 | 3 }) {
  const steps = ["Compose", "Preview", "Schedule"];
  return (
    <ol className="flex min-w-0 flex-wrap items-center gap-2 text-[14px]" aria-label="Create steps">
      {steps.map((label, index) => {
        const number = index + 1;
        const done = number < step;
        const current = number === step;
        return (
          <li key={label} className="flex items-center gap-2" aria-current={current ? "step" : undefined}>
            {index > 0 && <span className="h-px w-6 bg-line-2" aria-hidden="true" />}
            <span className={cx("inline-flex items-center gap-2 rounded-full px-3 py-1.5", current && "border border-[var(--brand-line)] bg-surface shadow-[var(--shadow-sm)]")}>
              <span className={cx("grid h-6 w-6 place-items-center rounded-full text-[12px] font-bold",
                current ? "voom-create-btn text-white" : done ? "text-[var(--green)]" : "bg-surface-3 text-text-2")}>
                {done ? <Icon name="check" size={13} /> : number}
              </span>
              <span className={cx(current ? "font-semibold text-text" : "text-text-2")}>{label}</span>
            </span>
          </li>
        );
      })}
    </ol>
  );
}

export function EmptyPanel({ icon, title, children, actions }: { icon: string; title: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-col items-center px-4 py-14 text-center">
      <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={icon} size={22} /></span>
      <h2 className="mt-4 text-[17px] font-semibold text-text">{title}</h2>
      {children && <div className="mt-1.5 max-w-md text-[14px] leading-relaxed text-text-2">{children}</div>}
      {actions && <div className="mt-5 flex flex-wrap justify-center gap-2.5">{actions}</div>}
    </div>
  );
}

/** Shared button looks for redesigned screens (links or buttons pass className). */
export const BTN = {
  primary: "voom-create-btn inline-flex h-11 items-center justify-center gap-2 rounded-full px-5 text-[14.5px] font-semibold text-white shadow-[0_8px_20px_-10px_rgba(140,82,240,.85)] transition hover:brightness-[1.04] disabled:cursor-not-allowed disabled:opacity-50",
  outline: "inline-flex h-11 items-center justify-center gap-2 rounded-full border border-[var(--brand-line)] bg-surface px-5 text-[14.5px] font-semibold text-[var(--brand-ink)] transition hover:bg-[var(--brand-soft-2)] disabled:cursor-not-allowed disabled:opacity-50",
  quiet: "inline-flex h-11 items-center justify-center gap-2 rounded-[14px] border border-line bg-surface px-4 text-[14px] font-semibold text-text transition hover:border-[var(--line-2)] hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50",
  field: "h-11 rounded-[14px] border border-line bg-surface px-3.5 text-[14px] text-text outline-none transition focus:border-[var(--brand-line)] focus:shadow-[0_0_0_4px_var(--brand-soft)]",
} as const;

export function formatShortDateTime(iso: string | null | undefined, timeZone?: string) {
  if (!iso) return null;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-GB", { timeZone, weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(date).replace(",", " ·");
}
