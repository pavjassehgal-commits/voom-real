"use client";

import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { Topbar } from "./Topbar";
import { BottomBar } from "./BottomBar";

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="flex min-h-dvh">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="mx-auto w-full max-w-[1320px] flex-1 px-3.5 pb-[92px] pt-4.5 sm:px-[22px] sm:pb-[90px] sm:pt-6">
          {children}
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
    <div className="mb-5 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-[21px] font-bold tracking-tight sm:text-2xl">{title}</h1>
        {description && <p className="mt-1 text-sm text-text-2">{description}</p>}
        {tags && <div className="mt-2.5 flex flex-wrap items-center gap-1.5">{tags}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}
