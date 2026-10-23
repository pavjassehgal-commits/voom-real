"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";
import { useVoomActions, useVoomState, navPath } from "@/lib/voom/store";
import { Icon } from "../icons";
import { IconBtn, cx } from "../ui/primitives";
import { automationModeStatusLine } from "@/lib/voom/automation";
import { NAV, pageIdFromPath } from "./nav";
import { useWorkflowCounts } from "./Topbar";
import { VoomLogo } from "./VoomLogo";

/**
 * Sidebar — redesign Batch 1 (Figma "15 — Today · Dashboard home").
 *
 * A light, floating navigation card: logo, grouped navigation with a clear
 * selected state, and the workspace card (plan, real channel connections,
 * the SAVED automation mode) with Plans & billing at the bottom.
 * - No mock data: the Approvals badge and channel progress are real reads.
 * - Accessible: semantic nav, keyboard focus, aria-current.
 * - Responsive: an overlay drawer below `md`, sticky card from `md` up.
 */
export function Sidebar() {
  const { sideOpen, plan, automationMode, displayName, email } = useVoomState();
  const { brand } = useVoomState();
  const { goTo, toggleSidebar } = useVoomActions();
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);
  const { approvals } = useWorkflowCounts();
  const channels = useConnectedChannels();

  const planLabel = plan === "max" ? "Max" : plan === "pro" ? "Pro" : "Free";
  const workspaceName = brand.name?.trim() || displayName || "Your";
  const initial = (brand.name?.trim()?.[0] || displayName?.[0] || email?.[0] || "V").toUpperCase();

  return (
    <>
      {sideOpen && (
        <div
          className="fixed inset-0 z-[85] bg-[rgba(26,31,48,0.32)] backdrop-blur-[2px] md:hidden"
          onClick={() => toggleSidebar(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={cx(
          "flex w-[264px] flex-none flex-col bg-[var(--bg)] p-3 md:p-4 md:pr-0",
          "fixed left-0 top-0 z-[90] h-dvh -translate-x-[105%] transition-transform duration-300 ease-[cubic-bezier(.32,.72,0,1)]",
          "md:sticky md:top-0 md:h-dvh md:translate-x-0",
          sideOpen && "translate-x-0",
        )}
        aria-label="Primary navigation"
      >
        <div className="flex h-full min-h-0 flex-col rounded-[24px] border border-[var(--sidebar-line)] bg-[var(--sidebar-bg)] text-[var(--sidebar-text)] shadow-[var(--shadow-sm)]">
          {/* Brand */}
          <div className="flex shrink-0 items-center justify-between gap-2 px-6 pb-4 pt-7">
            <Link href="/app/today" className="rounded-[10px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]" aria-label="Voom — Today">
              <VoomLogo />
            </Link>
            <IconBtn
              className="md:hidden !h-8 !w-8 !text-[var(--sidebar-text-3)] hover:!bg-[var(--sidebar-bg-hover)]"
              onClick={() => toggleSidebar(false)}
              aria-label="Close navigation"
            >
              <Icon name="x" size={16} />
            </IconBtn>
          </div>

          {/* Navigation */}
          <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
            <nav className="flex flex-col gap-5" aria-label="Main">
              {NAV.map((group) => (
                <div key={group.g}>
                  <div className="mb-1.5 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-[var(--sidebar-text-3)]">
                    {group.g}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const isActive = active === item.id;
                      const badge = item.id === "approvals" && approvals > 0 ? String(approvals) : item.badge;
                      return (
                        <Link
                          key={item.id}
                          href={navPath(item.id)}
                          prefetch
                          aria-current={isActive ? "page" : undefined}
                          className={cx(
                            "group flex w-full items-center gap-3 rounded-[14px] px-2.5 py-[7px] text-left text-[14.5px] leading-none transition-colors duration-150",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
                            isActive
                              ? "bg-[var(--sidebar-bg-active)] font-semibold text-[var(--sidebar-text-active)]"
                              : "font-medium text-[var(--sidebar-text-2)] hover:bg-[var(--sidebar-bg-hover)] hover:text-[var(--sidebar-text)]",
                          )}
                        >
                          <span
                            className={cx(
                              "grid h-[30px] w-[30px] place-items-center rounded-[9px] transition-colors",
                              isActive
                                ? "border border-[var(--brand-line)] bg-[var(--brand-tile)] text-[var(--sidebar-text-active)]"
                                : "text-[var(--sidebar-text-2)]",
                            )}
                          >
                            <Icon name={item.i} size={18} />
                          </span>
                          <span className="min-w-0 flex-1 truncate tracking-[-0.01em]">{item.n}</span>
                          {isActive && !badge && (
                            <span className="ml-auto mr-1 h-2 w-2 rounded-full bg-[#b464f6] shadow-[0_0_0_3px_rgba(180,100,246,0.18)]" aria-hidden="true" />
                          )}
                          {badge && (
                            <span
                              className="ml-auto grid h-[22px] min-w-[22px] place-items-center rounded-full bg-[var(--brand-soft)] px-1.5 text-[11.5px] font-bold text-[var(--brand-ink)] ring-1 ring-[var(--brand-line)]"
                              aria-label={`${badge} awaiting approval`}
                            >
                              {badge}
                            </span>
                          )}
                        </Link>
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
          </div>

          {/* Workspace context */}
          <div className="shrink-0 space-y-2.5 p-3">
            <div className="rounded-[16px] border border-[var(--sidebar-line)] bg-[var(--sidebar-bg-2)] p-3">
              <div className="flex items-center gap-2.5">
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-[linear-gradient(135deg,#8f5cfb,#d062f1)] text-[13px] font-bold text-white">
                  {initial}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-[13.5px] font-semibold tracking-[-0.01em] text-[var(--sidebar-text)]">
                    {`${workspaceName}${workspaceName === "Your" ? "" : "’s"} workspace`}
                  </div>
                  {/*
                    Billing plan display — deliberately separate from the
                    automation state below.
                  */}
                  <div className="truncate text-[12px] text-[var(--sidebar-text-3)]">{`${planLabel} plan`}</div>
                </div>
              </div>
              {channels && (
                <div className="mt-3">
                  <div className="h-1.5 overflow-hidden rounded-full bg-[var(--sidebar-bg-3)]" role="progressbar" aria-valuemin={0} aria-valuemax={channels.total} aria-valuenow={channels.connected} aria-label="Channels connected">
                    <div className="h-full rounded-full bg-[linear-gradient(90deg,#8f5cfb,#d062f1)]" style={{ width: `${(channels.connected / channels.total) * 100}%` }} />
                  </div>
                  <div className="mt-1.5 text-[11.5px] text-[var(--sidebar-text-3)]">{`${channels.connected}/${channels.total} channels connected`}</div>
                </div>
              )}
              {/*
                Operational copy comes from the account's SAVED automation
                mode — never from the billing tier.
              */}
              <p className="mt-2 line-clamp-2 text-[11.5px] leading-[1.4] text-[var(--sidebar-text-3)]">
                {automationModeStatusLine(automationMode)}
              </p>
            </div>
            <button
              type="button"
              onClick={() => goTo("pricing")}
              className="flex h-[42px] w-full items-center justify-center gap-2 rounded-[14px] border border-[var(--sidebar-line)] bg-[var(--sidebar-bg-3)] text-[13.5px] font-medium text-[var(--sidebar-text)] transition hover:bg-[var(--sidebar-bg-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]"
            >
              <Icon name="card" size={16} /> Plans & billing
            </button>
          </div>
        </div>
      </aside>
    </>
  );
}

/**
 * Real social connection status for the workspace card: Instagram, TikTok
 * and YouTube, read from their own status routes once per page session and
 * again when a connection changes. TikTok and YouTube count as connected
 * only with the publishing scope — the same rule the Channels screen uses.
 * Returns null until known, so nothing is shown rather than a guess.
 */
type ChannelCount = { connected: number; total: number } | null;
let channelCount: ChannelCount = null;
let channelInFlight: Promise<void> | null = null;
const channelListeners = new Set<() => void>();

async function readStatus(path: string, scope?: string): Promise<boolean> {
  try {
    const response = await fetch(path, { cache: "no-store" });
    if (!response.ok) return false;
    const body = (await response.json()) as { connection?: { connected?: boolean; scopes?: string[] } | null };
    const connection = body.connection;
    if (!connection?.connected) return false;
    return scope ? Boolean(connection.scopes?.includes(scope)) : true;
  } catch {
    return false;
  }
}

function refreshChannels() {
  if (channelInFlight) return;
  channelInFlight = (async () => {
    const results = await Promise.all([
      readStatus("/api/integrations/instagram/status"),
      readStatus("/api/integrations/tiktok/status", "video.publish"),
      readStatus("/api/integrations/youtube/status", "https://www.googleapis.com/auth/youtube.upload"),
    ]);
    channelCount = { connected: results.filter(Boolean).length, total: results.length };
    channelListeners.forEach((listener) => listener());
    channelInFlight = null;
  })();
}

function subscribeChannels(listener: () => void) {
  channelListeners.add(listener);
  if (channelListeners.size === 1) window.addEventListener("voom:instagram-changed", refreshChannels);
  if (!channelCount) refreshChannels();
  return () => {
    channelListeners.delete(listener);
    if (channelListeners.size === 0) window.removeEventListener("voom:instagram-changed", refreshChannels);
  };
}

function useConnectedChannels(): ChannelCount {
  return useSyncExternalStore(subscribeChannels, () => channelCount, () => null);
}
