"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";
import { Icon } from "../icons";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

/** Compact code-native Voom mark: one continuous refracted spectrum. */
export function VoomMark({ size = 30, className }: { size?: number; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cx("relative inline-block shrink-0 drop-shadow-[0_5px_12px_rgba(92,72,255,.28)]", className)}
      style={{ width: size, height: size }}
    >
      <span
        className="absolute left-[18%] top-[13%] h-[68%] w-[29%] -rotate-[27deg] rounded-full"
        style={{ background: "linear-gradient(180deg,#39dded 0%,#3878ff 54%,#7348ff 100%)" }}
      />
      <span
        className="absolute right-[17%] top-[9%] h-[76%] w-[31%] rotate-[28deg] rounded-full"
        style={{ background: "linear-gradient(180deg,#d83fe8 0%,#8d47ff 47%,#ff755f 100%)" }}
      />
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   Voom 2.0 — Surfaces
   Soft neutral surfaces, subtle border, restrained shadow,
   consistent radius, clear spacing hierarchy.
   Avoid excessive nested cards.
   ────────────────────────────────────────────────────────────── */
export function Card({ className, children, style }: { className?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className={cx(
        "rounded-[var(--r-lg)] border border-line bg-surface shadow-[var(--shadow)] backdrop-blur-[18px] backdrop-saturate-[1.18]",
        "transition-[border-color,box-shadow,transform] duration-200 hover:border-line-2",
        className,
      )}
      style={style}
    >
      {children}
    </div>
  );
}

export function Surface({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("rounded-[var(--r)] border border-line bg-surface-2 backdrop-blur-[14px]", className)}>{children}</div>;
}

type BtnVariant = "primary" | "dark" | "ghost" | "outline" | "danger" | "plain" | "brand";
type BtnSize = "sm" | "md" | "lg";

/**
 * Voom 2.0 Buttons — restrained, premium
 * primary = graphite (operational)
 * brand = the unified Voom iridescent spectrum for rare key CTAs
 * ghost/outline = neutral secondary
 */
const VARIANT_CLASSES: Record<BtnVariant, string> = {
  // Primary — graphite, restrained, premium
  primary: "bg-text text-surface shadow-[var(--shadow-sm)] hover:brightness-[1.08] active:brightness-[0.96]",
  dark: "bg-text text-surface shadow-[var(--shadow-sm)] hover:brightness-[1.08]",
  // Brand — use sparingly for key actions (Create, etc)
  brand: "voom-grad text-white shadow-[0_8px_24px_-10px_rgba(105,75,255,.72)] hover:brightness-110",
  ghost: "bg-surface-2 text-text border border-line hover:bg-surface-3 hover:border-line-2",
  outline: "border border-line-2 bg-surface text-text hover:bg-surface-2",
  danger: "bg-[var(--red-soft)] text-red hover:bg-red/15 border border-transparent",
  plain: "text-text-2 hover:text-text hover:bg-surface-2",
};

const SIZE_CLASSES: Record<BtnSize, string> = {
  sm: "h-[34px] px-3.5 text-[13px] rounded-[10px] gap-1.5",
  md: "h-[40px] px-4 text-[13.5px] rounded-[11px] gap-2",
  lg: "h-[46px] px-6 text-[14.5px] rounded-[12px] gap-2",
};

export function Btn({
  variant = "outline",
  size = "md",
  block,
  className,
  children,
  ...props
}: {
  variant?: BtnVariant;
  size?: BtnSize;
  block?: boolean;
} & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center font-[600] tracking-[-0.01em] whitespace-nowrap transition-all duration-150",
        "active:scale-[0.98] disabled:opacity-45 disabled:pointer-events-none",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand focus-visible:ring-offset-2 focus-visible:ring-offset-bg",
        VARIANT_CLASSES[variant],
        SIZE_CLASSES[size],
        block && "w-full",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function IconBtn({
  className,
  children,
  ...props
}: { children: ReactNode } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 transition",
        "hover:bg-surface-2 hover:text-text",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-1",
        "active:scale-[0.96]",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

export function Chip({
  active,
  className,
  children,
  ...props
}: { active?: boolean } & ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      className={cx(
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium tracking-[-0.01em] transition",
        active
          ? "border-transparent voom-grad font-semibold text-white shadow-[0_8px_22px_-12px_rgba(104,79,255,.7)]"
          : "border-line bg-surface-2 text-text-2 hover:border-line-2 hover:text-text hover:bg-surface-3",
        "disabled:pointer-events-none disabled:opacity-40",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-1",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const TAG_CLASSES: Record<string, string> = {
  "t-green": "bg-[var(--green-soft)] text-[var(--green)] ring-1 ring-[var(--green)]/10",
  "t-amber": "bg-[var(--amber-soft)] text-[var(--amber)] ring-1 ring-[var(--amber)]/10",
  "t-red": "bg-[var(--red-soft)] text-[var(--red)] ring-1 ring-[var(--red)]/10",
  "t-blue": "bg-[var(--blue-soft)] text-[var(--blue)] ring-1 ring-[var(--blue)]/10",
  "t-pink": "bg-pink/10 text-pink ring-1 ring-pink/10",
  "t-brand": "bg-[var(--brand-soft)] text-brand ring-1 ring-brand/10",
  "t-story": "bg-[var(--brand-2)]/10 text-[var(--brand-2)] ring-1 ring-[var(--brand-2)]/10",
  "t-grey": "bg-surface-2 text-text-3 ring-1 ring-line",
};

export function Tag({ tone = "t-grey", className, children }: { tone?: string; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-[8px] px-2.5 py-[3px] text-[11px] font-semibold tracking-[0.02em]",
        TAG_CLASSES[tone] ?? TAG_CLASSES["t-grey"],
        className,
      )}
    >
      {children}
    </span>
  );
}

/* ──────────────────────────────────────────────────────────────
   MARA Visual Language — calm, operational, ambient automation
   Not a chatbot. Green = active/healthy/connected/scheduled/complete
   ────────────────────────────────────────────────────────────── */
export function MaraDot({ active = true, className }: { active?: boolean; className?: string }) {
  return (
    <span
      className={cx(
        "inline-block h-2 w-2 rounded-full bg-[var(--green-dot)] shadow-[0_0_0_3px_var(--green-soft)]",
        active && "animate-[voom-mara-pulse_2.4s_ease-in-out_infinite]",
        className,
      )}
      aria-hidden="true"
    />
  );
}

export function MaraStatus({
  label = "MARA active",
  activity,
  className,
}: {
  label?: string;
  activity?: string;
  className?: string;
}) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 shadow-[var(--shadow-sm)]",
        className,
      )}
    >
      <MaraDot active />
      <span className="text-[12px] font-medium tracking-[-0.01em] text-text-2">
        <span className="font-semibold text-text">{label}</span>
        {activity && <span className="ml-1.5 text-text-3">· {activity}</span>}
      </span>
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-4 block">
      <span className="mb-1.5 block text-[12.5px] font-semibold tracking-[0.01em] text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs leading-relaxed text-text-3">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-[44px] w-full rounded-[12px] border border-line bg-surface-2 px-3.5 text-[14px] text-text outline-none placeholder:text-text-3",
        "transition focus:border-text focus:bg-surface focus:shadow-[0_0_0_4px_var(--brand-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cx(
        "w-full rounded-[12px] border border-line bg-surface-2 px-3.5 py-3 text-[14px] leading-[1.6] text-text outline-none placeholder:text-text-3",
        "transition focus:border-text focus:bg-surface focus:shadow-[0_0_0_4px_var(--brand-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function Sep({ className }: { className?: string }) {
  return <div className={cx("my-4 h-px bg-line", className)} />;
}

export function StatMini({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-[12px] bg-surface-2 p-3 text-center ring-1 ring-line">
      <b className="block font-display text-[18px] font-semibold tracking-tight">{value}</b>
      <span className="mt-0.5 block text-[11px] font-medium text-text-3">{label}</span>
    </div>
  );
}

export function Orb({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = { sm: 24, md: 32, lg: 56 }[size];
  const inset1 = { sm: 4, md: 5, lg: 10 }[size];
  const inset2 = { sm: 6, md: 8, lg: 16 }[size];
  return (
    <span
      className={cx("relative flex-none rounded-full", className)}
      style={{
        width: dims,
        height: dims,
        background: "conic-gradient(from 205deg,#2dd7ee,#3578ff,#7447ff,#db3ee5,#ff5d86,#ff9b4a,#2dd7ee)",
        boxShadow: "0 0 0 3px var(--surface), 0 8px 24px -7px rgba(101,72,255,.62)",
      }}
    >
      <span className="absolute rounded-full bg-surface" style={{ inset: inset1, opacity: 0.92 }} />
      <span className="voom-grad absolute animate-pulse rounded-full" style={{ inset: inset2 }} />
    </span>
  );
}

export function Between({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex items-center justify-between gap-3", className)}>{children}</div>;
}

export function Row({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cx("flex items-center gap-2.5", className)}>{children}</div>;
}

/**
 * Empty state — truthful, consistent hierarchy
 */
export function EmptyState({
  icon = "spark",
  title,
  reason,
  action,
  className,
}: {
  icon?: string;
  title: string;
  reason: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-12 text-center sm:py-16", className)}>
      <span className="grid h-14 w-14 place-items-center rounded-[16px] bg-surface-2 text-text-2 ring-1 ring-line">
        <Icon name={icon} size={24} />
      </span>
      <h2 className="mt-5 font-display text-[18px] font-semibold tracking-tight sm:text-[20px]">{title}</h2>
      <p className="mx-auto mt-2.5 max-w-xl text-[13.5px] leading-relaxed text-text-2">{reason}</p>
      {action && <div className="mt-6 flex flex-wrap justify-center gap-2.5">{action}</div>}
    </div>
  );
}
