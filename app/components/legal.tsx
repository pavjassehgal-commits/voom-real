import Link from "next/link";
import type { ReactNode } from "react";
import Logo from "./Logo";
import { LEGAL_LAST_UPDATED, SUPPORT_EMAIL } from "@/lib/legal/contact";

/**
 * Shared layout and typography for Voom's public legal pages
 * (/privacy, /terms, /data-deletion). Server components only — these pages
 * are static, unauthenticated, and never redirect to /login or /app.
 */

export function LegalEmailLink() {
  return (
    <a
      href={`mailto:${SUPPORT_EMAIL}`}
      className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
    >
      {SUPPORT_EMAIL}
    </a>
  );
}

export function LegalPage({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line px-5 py-5 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4">
          <Link href="/" aria-label="Voom home" className="flex-none">
            <Logo />
          </Link>
          <Link
            href="/"
            className="rounded-[10px] border border-line px-3 py-1.5 text-xs font-medium text-text-2 transition hover:bg-surface-2 hover:text-text"
          >
            Back to home
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-5 py-10 sm:px-6 sm:py-14">
        <span className="inline-flex items-center rounded-full border border-line bg-surface-2 px-3 py-1 text-xs font-medium text-text-2">
          Last updated {LEGAL_LAST_UPDATED}
        </span>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight text-balance sm:text-4xl">
          {title}
        </h1>
        <p className="mt-4 text-[15px] leading-relaxed text-text-2 sm:text-base">
          {lead}
        </p>
        <div className="mt-10 space-y-10">{children}</div>
      </main>

      <footer className="border-t border-line px-5 py-6 sm:px-6">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center justify-between gap-3 text-xs text-text-3 sm:flex-row">
          <span className="flex-none">Voom</span>
          <nav className="flex flex-wrap items-center justify-center gap-x-5 gap-y-1">
            <Link href="/privacy" className="transition hover:text-text-2">
              Privacy Policy
            </Link>
            <Link href="/terms" className="transition hover:text-text-2">
              Terms of Service
            </Link>
            <Link href="/data-deletion" className="transition hover:text-text-2">
              Data Deletion
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}

export function LegalSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section>
      <h2 className="font-display text-lg font-semibold text-text sm:text-xl">
        {title}
      </h2>
      <div className="mt-3 space-y-3 text-[14.5px] leading-relaxed text-text-2 sm:text-[15px]">
        {children}
      </div>
    </section>
  );
}

export function LegalList({ items }: { items: ReactNode[] }) {
  return (
    <ul className="space-y-2">
      {items.map((item, index) => (
        <li key={index} className="flex gap-2.5">
          <span
            aria-hidden
            className="mt-[9px] h-1.5 w-1.5 flex-none rounded-full bg-brand"
          />
          <span>{item}</span>
        </li>
      ))}
    </ul>
  );
}

export function LegalNote({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-[14px] border border-line-2 bg-surface-2 p-4">
      <span className="flex items-center gap-2 text-[13.5px] font-semibold text-text">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-brand-2" />
        Important
      </span>
      <div className="mt-1.5 text-[13.5px] leading-relaxed text-text-2">
        {children}
      </div>
    </div>
  );
}
