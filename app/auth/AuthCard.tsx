import type { ReactNode } from "react";
import Link from "next/link";
import Logo from "../components/Logo";
export default function AuthCard({ title, children }: { title: string; children: ReactNode }) {
  return <main className="flex min-h-screen flex-col items-center justify-center px-5 py-12">
    <div className="mb-8"><Logo /></div>
    <section className="w-full max-w-md rounded-2xl border border-line bg-surface p-6 shadow-xl sm:p-8">
      <h1 className="font-display text-2xl font-semibold tracking-tight">{title}</h1>
      <div className="mt-4 space-y-4 text-sm text-text-2">{children}</div>
      <nav aria-label="Authentication" className="mt-7 flex flex-wrap gap-5 border-t border-line pt-5 text-xs text-text-2">
        <Link href="/login">Sign in</Link><Link href="/signup">Create account</Link>
      </nav>
    </section>
  </main>;
}
