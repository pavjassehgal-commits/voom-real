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

/**
 * Page-header skeleton matching the redesign `PageHeader`: a title line the
 * height of its clamp(28px→36px) heading, a subtitle line, and the same mb-6,
 * so the real header replaces it without the page jumping.
 */
export function WorkspaceHeaderSkeleton() {
  return (
    <div className="mb-6 flex flex-col gap-2">
      <Block className="h-[31px] w-[200px] max-w-full sm:h-[40px] sm:w-[240px]" />
      <Block className="h-[19px] w-[min(420px,80%)]" />
    </div>
  );
}

/** A workspace panel skeleton in the real `voom-card` frame: a title line plus stacked tile rows. */
export function WorkspacePanelSkeleton({ rows = 3, className }: { rows?: number; className?: string }) {
  return (
    <section className={cx("voom-card min-w-0 p-5", className)}>
      <Block className="mb-4 h-[20px] w-[140px]" />
      <div className="flex flex-col gap-3">
        {Array.from({ length: rows }, (_, index) => (
          <Block key={index} className="h-[56px] w-full" />
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
