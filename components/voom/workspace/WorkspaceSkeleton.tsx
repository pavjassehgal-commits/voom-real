import type { ReactNode } from "react";
import { cx } from "@/lib/voom/cx";

/**
 * Voom 2.0 workspace loading skeleton — the route-level `loading.tsx` face.
 *
 * Uses the same workspace building blocks and design tokens as the real
 * screens (surface/line tokens, display type scale, restrained rounding) so a
 * streamed navigation shows a shell that already looks like Voom while the
 * authoritative server data loads. It contains NO invented content — no fake
 * numbers, names, statuses or dates — only neutral placeholder geometry.
 */
function Block({ className }: { className?: string }) {
  return (
    <div
      className={cx("animate-pulse rounded-[10px] bg-surface-2 ring-1 ring-line motion-reduce:animate-none", className)}
      aria-hidden="true"
    />
  );
}

export function WorkspaceSkeleton({ label = "Loading", children }: { label?: string; children?: ReactNode }) {
  return (
    <div role="status" aria-busy="true" aria-live="polite" className="min-w-0">
      <span className="sr-only">{label}…</span>
      {children}
    </div>
  );
}

/** Page-header skeleton matching `PageHead`/`WorkspaceHeader` rhythm. */
export function WorkspaceHeaderSkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-3 sm:mb-8">
      <Block className="h-[26px] w-[220px] max-w-full" />
      <Block className="h-[14px] w-[min(420px,80%)]" />
    </div>
  );
}

/** A workspace panel skeleton: header line plus stacked content rows. */
export function WorkspacePanelSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <section
      className={cx(
        "rounded-[var(--r-lg)] border border-line bg-surface p-4 shadow-[var(--shadow-sm)] sm:p-5",
        className,
      )}
    >
      <Block className="mb-4 h-[16px] w-[140px]" />
      <div className="flex flex-col gap-2.5">
        {Array.from({ length: rows }, (_, index) => (
          <Block key={index} className="h-[52px] w-full" />
        ))}
      </div>
    </section>
  );
}

/** Default route skeleton: header + two-column panels, like the workspaces. */
export default function WorkspaceRouteSkeleton() {
  return (
    <WorkspaceSkeleton label="Loading workspace">
      <WorkspaceHeaderSkeleton />
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_320px]">
        <WorkspacePanelSkeleton rows={4} />
        <div className="flex flex-col gap-4">
          <WorkspacePanelSkeleton rows={2} />
          <WorkspacePanelSkeleton rows={2} />
        </div>
      </div>
    </WorkspaceSkeleton>
  );
}
