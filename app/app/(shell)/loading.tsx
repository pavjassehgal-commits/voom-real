import WorkspaceRouteSkeleton from "@/components/voom/workspace/WorkspaceSkeleton";

/**
 * Route-level loading boundary for every workspace screen (Today, Marketing
 * Plan, Create, Calendar, Performance, Approvals and the rest).
 *
 * Sits INSIDE the app shell layout, so navigation responds immediately with
 * the existing shell (sidebar/topbar) intact while the page's authoritative
 * server data streams in — never a frozen screen, and never invented data.
 */
export default function ShellLoading() {
  return <WorkspaceRouteSkeleton />;
}
