"use client";

import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, TextareaHTMLAttributes } from "react";

export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}

export function Card({ className, children, style }: { className?: string; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <div
      className={cx("rounded-[var(--r-lg)] border border-line bg-surface shadow-[var(--shadow)]", className)}
      style={style}
    >
      {children}
    </div>
  );
}

type BtnVariant = "primary" | "dark" | "ghost" | "outline" | "danger" | "plain";
type BtnSize = "sm" | "md" | "lg";

const VARIANT_CLASSES: Record<BtnVariant, string> = {
  primary: "voom-grad text-white shadow-[0_6px_18px_-8px_var(--brand)] hover:brightness-110",
  dark: "bg-text text-surface",
  ghost: "bg-surface-2 text-text border border-line hover:bg-surface-3",
  outline: "border border-line-2 text-text hover:bg-surface-2",
  danger: "bg-red/10 text-red hover:bg-red/15",
  plain: "text-text-2 hover:text-text",
};

const SIZE_CLASSES: Record<BtnSize, string> = {
  sm: "h-[34px] px-3.5 text-[13px] rounded-[9px] gap-1.5",
  md: "h-[42px] px-[18px] text-sm rounded-[11px] gap-2",
  lg: "h-[50px] px-[26px] text-[15px] rounded-[13px] gap-2",
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
        "inline-flex items-center justify-center font-semibold whitespace-nowrap transition active:scale-[.975] disabled:opacity-45 disabled:pointer-events-none",
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
        "grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 transition hover:bg-surface-2 hover:text-text",
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
        "inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition",
        active
          ? "border-brand bg-[var(--brand-soft)] font-semibold text-brand"
          : "border-line bg-surface-2 text-text-2 hover:border-brand hover:text-text",
        "disabled:pointer-events-none disabled:opacity-40",
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}

const TAG_CLASSES: Record<string, string> = {
  "t-green": "bg-green/15 text-green",
  "t-amber": "bg-amber/15 text-amber",
  "t-red": "bg-red/15 text-red",
  "t-blue": "bg-blue/15 text-blue",
  "t-pink": "bg-pink/15 text-pink",
  "t-brand": "bg-[var(--brand-soft)] text-brand",
  "t-grey": "bg-surface-2 text-text-3",
};

export function Tag({ tone = "t-grey", className, children }: { tone?: string; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 rounded-[7px] px-2.5 py-[3px] text-[11.5px] font-semibold tracking-[.01em]",
        TAG_CLASSES[tone] ?? TAG_CLASSES["t-grey"],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="mb-3.5 block">
      <span className="mb-1.5 block text-[12.5px] font-semibold tracking-[.01em] text-text-2">{label}</span>
      {children}
      {hint && <span className="mt-1.5 block text-xs text-text-3">{hint}</span>}
    </label>
  );
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none placeholder:text-text-3",
        "focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]",
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
        "w-full rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[14.5px] leading-[1.55] text-text outline-none placeholder:text-text-3",
        "focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]",
        className,
      )}
      {...props}
    />
  );
}

export function Sep({ className }: { className?: string }) {
  return <div className={cx("my-3.5 h-px bg-line", className)} />;
}

export function StatMini({ value, label }: { value: string; label: string }) {
  return (
    <div className="rounded-xl bg-surface-2 p-2.5 text-center">
      <b className="block font-display text-[19px]">{value}</b>
      <span className="text-[11px] text-text-3">{label}</span>
    </div>
  );
}

export function Orb({ size = "md", className }: { size?: "sm" | "md" | "lg"; className?: string }) {
  const dims = { sm: 26, md: 34, lg: 64 }[size];
  const inset1 = { sm: 4, md: 6, lg: 11 }[size];
  const inset2 = { sm: 7, md: 10, lg: 18 }[size];
  return (
    <span
      className={cx("relative flex-none rounded-full", className)}
      style={{
        width: dims,
        height: dims,
        background: "conic-gradient(from 200deg,#e8481f,#f2a516,#0f6f68,#e8481f)",
        boxShadow: "0 0 0 3px var(--surface), 0 6px 18px -6px rgba(232,72,31,.6)",
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
