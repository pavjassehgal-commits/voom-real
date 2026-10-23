import Image from "next/image";
import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "../icons";
import { VoomLogo } from "../shell/VoomLogo";

/**
 * Log in / Sign up / Check your email frame — redesign Batch 4A (Figma
 * "02 — Log in", "03 — Sign up", "05 — Forgot password", Keep).
 *
 * A dark brand panel with the reference's ribbon artwork beside a light form
 * card. The panel is decorative and hidden below `lg`; the form card carries
 * its own logo so small screens still read as Voom. Server-safe.
 */
export function AuthFrame({ title, subtitle, badge, children }: { title: string; subtitle?: ReactNode; badge?: ReactNode; children: ReactNode }) {
  return (
    <div className="voom-public grid min-h-dvh lg:grid-cols-[minmax(0,1.38fr)_minmax(0,1fr)]">
      <aside className="voom-auth-panel relative hidden overflow-hidden text-white [--text:#ffffff] lg:flex lg:flex-col">
        <Link href="/" aria-label="Voom home" className="relative z-10 ml-[6%] mt-11 w-fit rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40">
          <VoomLogo size={34} idPrefix="voom-mark-panel" />
        </Link>
        <div className="relative z-10 ml-[13.5%] mr-10 mt-[25vh] max-w-[420px]">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-[#e9e4ff] px-3 py-1 text-[11.5px] font-medium text-[#3b2f8f]">
            <Icon name="sparkles" size={12} /> Meet MARA, your AI marketing manager
          </span>
          <p className="mt-6 text-[clamp(2.6rem,3.7vw,3.3rem)] font-bold leading-[1.02] tracking-[-0.045em]">
            Marketing<br />that <span className="bg-[linear-gradient(90deg,#c7a6ff,#e3a6f3)] bg-clip-text text-transparent">runs itself.</span>
          </p>
          <p className="mt-6 max-w-[400px] text-[15px] leading-[1.6] text-white/70">
            Plan, create, schedule, and publish content across Instagram, TikTok, YouTube and email, all from one workspace.
          </p>
        </div>
        <Image src="/redesign/auth-ribbon.webp" alt="" width={1400} height={560} priority className="pointer-events-none absolute -left-[3%] bottom-0 w-[104%] max-w-none" />
      </aside>

      <main className="flex items-center justify-center bg-[linear-gradient(180deg,#fbfaff_0%,#f6f4fb_100%)] px-4 py-10 sm:px-8">
        <div className="w-full max-w-[472px] rounded-[24px] border border-[var(--line)] bg-white px-6 py-9 shadow-[0_24px_60px_-34px_rgba(44,38,92,0.35)] sm:px-9 sm:py-11">
          <div className="flex justify-center">
            <Link href="/" aria-label="Voom home" className="rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]">
              <VoomLogo size={32} />
            </Link>
          </div>
          {badge && <div className="mt-6 flex justify-center">{badge}</div>}
          <h1 className={`${badge ? "mt-4" : "mt-6"} text-center text-[27px] font-bold tracking-[-0.03em] text-text`}>{title}</h1>
          {subtitle && <p className="mt-1.5 text-center text-[14px] text-text-2">{subtitle}</p>}
          {children}
        </div>
      </main>
    </div>
  );
}

/** Shared field styling for the auth forms (matches the reference inputs). */
export const AUTH_INPUT =
  "h-12 w-full rounded-[11px] border border-[var(--line)] bg-[var(--surface-2)] pl-10 pr-3.5 text-[14px] text-text placeholder:text-text-3 transition focus:border-[var(--brand-line)] focus:bg-white focus:outline-none focus:ring-4 focus:ring-[var(--brand-soft)]";

export const AUTH_SUBMIT =
  "voom-create-btn mt-1 inline-flex h-12 w-full items-center justify-center gap-2 rounded-[10px] text-[14px] font-semibold text-white shadow-[0_10px_22px_-14px_rgba(134,69,250,.9)] transition hover:brightness-[1.05] disabled:opacity-60";

export function AuthField({ label, icon, error, errorId, children }: { label: string; icon: string; error?: string; errorId: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-2 block text-[13px] font-semibold text-text">{label}</span>
      <span className="relative block">
        <Icon name={icon} size={16} className="pointer-events-none absolute left-3.5 top-4 text-text-3" />
        {children}
      </span>
      {error && <p id={errorId} role="alert" className="mt-1.5 text-[12px] text-[var(--red)]">{error}</p>}
    </label>
  );
}

export function AuthAlert({ children }: { children: ReactNode }) {
  return <p role="alert" className="rounded-[10px] border border-[var(--red)]/25 bg-[var(--red-soft)] px-3.5 py-2.5 text-[13px] text-[var(--red)]">{children}</p>;
}

export function PasswordToggle({ shown, onToggle }: { shown: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="absolute right-2 top-2 grid h-8 w-8 place-items-center rounded-[8px] text-text-3 transition hover:bg-[var(--surface-3)] hover:text-text-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]"
      aria-label={shown ? "Hide password" : "Show password"}
      aria-pressed={shown}
    >
      <Icon name={shown ? "eyeOff" : "eye"} size={16} />
    </button>
  );
}
