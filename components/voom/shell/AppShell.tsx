"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { BottomBar } from "./BottomBar";
import { PageTransition } from "../motion/PageTransition";

/**
 * Application shell — redesign Batch 1 (Figma "15 — Today · Dashboard home").
 *
 * - `.voom-shell` scopes the redesign tokens and DM Sans to the signed-in
 *   workspace (public/auth surfaces keep theirs until their own batches).
 * - Floating light sidebar card, translucent sticky topbar, flat neutral
 *   workspace — no decorative atmosphere layers.
 * - Responsive: the sidebar becomes an overlay drawer below `md`, and the
 *   bottom bar carries primary navigation on mobile.
 */
export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="voom-shell relative isolate flex min-h-dvh bg-bg text-text antialiased">
      <Sidebar />
      <div className="relative flex min-w-0 flex-1 flex-col bg-transparent">
        <Topbar />
        <main className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-4 pb-[96px] pt-6 sm:px-6 sm:pb-12 sm:pt-8 lg:px-10">
          {/* Only the page content animates, and only on in-app navigation. */}
          <div className="relative z-10 flex w-full flex-1 flex-col">
            <PageTransition>{children}</PageTransition>
          </div>
        </main>
      </div>
      <BottomBar />
    </div>
  );
}

/**
 * Page header — responsive by construction.
 *
 * The header used to hand its actions a `shrink-0` box, so a control whose
 * content has a wide intrinsic width (the automation segmented control's
 * "Current plan: …" line) stretched the page past the viewport. The actions
 * container now takes its own full-width row on small screens (where it may
 * wrap inside the viewport), and is only auto-sized and non-shrinking from
 * `sm` upwards — the desktop layout is unchanged.
 */
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
        <h1 className="font-display text-[26px] font-bold tracking-[-0.035em] text-text sm:text-[32px]">{title}</h1>
        {description && <p className="mt-1 max-w-2xl text-[15px] leading-relaxed text-text-2 sm:text-[16px]">{description}</p>}
        {tags && <div className="mt-3 flex flex-wrap items-center gap-1.5">{tags}</div>}
      </div>
      {actions && (
        <div className="flex w-full min-w-0 max-w-full flex-wrap items-center gap-2 sm:w-auto sm:shrink-0">
          {actions}
        </div>
      )}
    </div>
  );
}
