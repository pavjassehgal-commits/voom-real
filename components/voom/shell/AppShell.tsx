"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { BottomBar } from "./BottomBar";

/**
 * Voom 2.0 Application Shell
 *
 * - Graphite sidebar (near-black) + warm off-white workspace
 * - Restrained topbar, contextual
 * - Generous but efficient whitespace, premium rounded surfaces
 * - Responsive: sidebar collapses to overlay on mobile, bottom bar for primary nav
 * - Atmospheric accent: extremely subtle glow via CSS (globals.css body::before)
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh bg-bg text-text antialiased">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col bg-bg">
        <Topbar />
        <main
          className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pb-[88px] pt-6 sm:px-6 sm:pb-10 sm:pt-8 lg:px-8"
          style={{ animation: "voom-fade-in 0.32s ease" }}
        >
          {/* Subtle atmospheric header glow — restrained */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 top-0 h-[280px] opacity-[0.5]"
            style={{
              background:
                "radial-gradient(900px 220px at 20% 0%, rgba(232,72,31,0.06), transparent 60%), radial-gradient(700px 200px at 80% 0%, rgba(15,111,104,0.04), transparent 60%)",
            }}
          />
          <div className="relative w-full flex-1">{children}</div>
        </main>
      </div>
      <BottomBar />
    </div>
  );
}

export function PageHead({
  title,
  description,
  tags,
  actions,
}: {
  title: string;
  description?: ReactNode;
  tags?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4 sm:mb-8">
      <div className="min-w-0">
        <h1 className="font-display text-[22px] font-bold tracking-tight text-text sm:text-[26px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[14px] leading-relaxed text-text-2">{description}</p>}
        {tags && <div className="mt-3 flex flex-wrap items-center gap-1.5">{tags}</div>}
      </div>
      {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
