import Link from "next/link";
import Logo from "./components/Logo";

export default function Home() {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="border-b border-line px-6 py-5">
        <Logo />
      </header>

      <main className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-20 text-center">
        <span className="rounded-full border border-line bg-surface-2 px-3.5 py-1.5 text-xs font-medium text-text-2">
          Meet MARA, your AI marketing manager
        </span>
        <h1 className="max-w-2xl font-display text-4xl font-bold tracking-tight text-balance sm:text-5xl">
          Marketing that runs itself.
        </h1>
        <p className="max-w-md text-text-2">
          Voom pairs your business with MARA, an AI marketing manager that
          plans, drafts, and reports on your campaigns — so you don&apos;t
          have to.
        </p>
        <div className="flex flex-wrap items-center justify-center gap-3 pt-2">
          <Link
            href="/login"
            className="voom-grad inline-flex h-[46px] items-center justify-center rounded-[11px] px-6 text-sm font-semibold text-white shadow-[0_6px_18px_-8px_var(--brand)] transition hover:brightness-110"
          >
            Get started
          </Link>
          <Link
            href="/app"
            className="inline-flex h-[46px] items-center justify-center rounded-[11px] border border-line-2 px-6 text-sm font-semibold text-text transition hover:bg-surface-2"
          >
            View dashboard
          </Link>
        </div>
      </main>

      <footer className="border-t border-line px-6 py-5 text-center text-xs text-text-3">
        Voom — placeholder build. No live integrations.
      </footer>
    </div>
  );
}
