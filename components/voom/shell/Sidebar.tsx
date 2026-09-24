"use client";

import { usePathname } from "next/navigation";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { Icon } from "../icons";
import { Btn, IconBtn, VoomMark, cx } from "../ui/primitives";
import { automationModeStatusLine } from "@/lib/voom/automation";
import { NAV, pageIdFromPath } from "./nav";

/**
 * Voom 2.0 Sidebar — near-black refracted-glass navigation shell
 *
 * - Neutral light / refracted dark workspace is handled by AppShell/main
 * - Sidebar is always graphite, independent of theme
 * - Compact icon + label, clear selected state, subtle section separation
 * - Settings toward bottom, business context preserved
 * - No mock data, no decorative imagery
 * - Accessible: semantic nav, keyboard focus, aria-current
 */
export function Sidebar() {
  const { sideOpen, plan, automationMode, displayName, email } = useVoomState();
  const { goTo, toggleSidebar } = useVoomActions();
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  // Split groups for layout: primary/secondary/system in scrollable area,
  // utility (Settings) pinned at bottom
  const mainGroups = NAV.filter((g) => g.g !== "Utility");
  const utilityGroups = NAV.filter((g) => g.g === "Utility");

  return (
    <>
      {sideOpen && (
        <div
          className="fixed inset-0 z-[85] bg-black/50 backdrop-blur-[2px] md:hidden"
          onClick={() => toggleSidebar(false)}
          aria-hidden="true"
        />
      )}
      <aside
        className={cx(
          "flex w-[268px] flex-none flex-col border-r bg-[var(--sidebar-bg)] text-[var(--sidebar-text)]",
          "border-[var(--sidebar-line)]",
          "fixed left-0 top-0 z-[90] h-dvh -translate-x-[105%] shadow-[var(--shadow-lg)] transition-transform duration-300 ease-[cubic-bezier(.32,.72,0,1)]",
          "md:sticky md:top-0 md:h-dvh md:translate-x-0 md:shadow-none",
          sideOpen && "translate-x-0",
        )}
        aria-label="Primary navigation"
      >
        {/* Brand — Voom at top, compact */}
        <div className="flex h-[64px] shrink-0 items-center justify-between gap-2 border-b border-[var(--sidebar-line)] px-[18px]">
          <div className="flex items-center gap-2.5">
            <VoomMark size={31} />
            <span className="font-display text-[18px] font-bold tracking-tight text-white">Voom</span>
          </div>
          <IconBtn
            className="md:hidden !h-8 !w-8 !text-[var(--sidebar-text-2)] hover:!bg-[var(--sidebar-bg-2)] hover:!text-white"
            onClick={() => toggleSidebar(false)}
            aria-label="Close navigation"
          >
            <Icon name="x" size={16} />
          </IconBtn>
        </div>

        {/* Navigation — scrollable */}
        <div className="flex flex-1 flex-col overflow-y-auto px-3 py-4">
          <nav className="flex flex-col gap-6" aria-label="Main">
            {mainGroups.map((group) => (
              <div key={group.g}>
                <div className="mb-2 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sidebar-text-3)]">
                  {group.g}
                </div>
                <div className="flex flex-col gap-0.5">
                  {group.items.map((item) => {
                    const isActive = active === item.id;
                    return (
                      <button
                        key={item.id}
                        onClick={() => goTo(item.id)}
                        aria-current={isActive ? "page" : undefined}
                        className={cx(
                          "group flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left text-[13.5px] font-[500] leading-none transition-all duration-150",
                          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20 focus-visible:ring-offset-0",
                          isActive
                            ? "voom-iridescent-border bg-[linear-gradient(100deg,var(--sidebar-bg-active),var(--sidebar-bg-active-2))] text-[var(--sidebar-text-active)] font-[600] shadow-[inset_0_1px_0_0_rgba(255,255,255,0.08),0_9px_24px_-16px_rgba(91,79,255,.8)]"
                            : "text-[var(--sidebar-text-2)] hover:bg-[var(--sidebar-bg-hover)] hover:text-[var(--sidebar-text)]",
                        )}
                      >
                        <span
                          className={cx(
                            "grid h-[22px] w-[22px] place-items-center rounded-[7px] transition-colors",
                            isActive ? "bg-white/[0.10] text-white shadow-[inset_0_0_12px_rgba(101,104,255,.14)]" : "text-[var(--sidebar-text-3)] group-hover:text-[var(--sidebar-text-2)]",
                          )}
                        >
                          <Icon name={item.i} size={16} />
                        </span>
                        <span className="min-w-0 flex-1 truncate tracking-[-0.01em]">{item.n}</span>
                        {isActive && (
                          <span className="voom-grad ml-auto h-1.5 w-1.5 rounded-full shadow-[0_0_0_3px_rgba(111,78,255,0.18)]" aria-hidden="true" />
                        )}
                        {item.badge && !isActive && (
                          <span className="voom-grad ml-auto rounded-full px-1.5 py-0.5 text-[10px] font-bold text-white">
                            {item.badge}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>

          {/* Spacer pushes utility to bottom on large screens, but keeps scroll natural */}
          <div className="flex-1" />

          {/* Utility — Settings toward bottom, subtle separation */}
          {utilityGroups.length > 0 && (
            <div className="mt-6 border-t border-[var(--sidebar-line)] pt-4">
              {utilityGroups.map((group) => (
                <div key={group.g}>
                  <div className="mb-2 px-2.5 font-mono text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--sidebar-text-3)]">
                    {group.g}
                  </div>
                  <div className="flex flex-col gap-0.5">
                    {group.items.map((item) => {
                      const isActive = active === item.id;
                      return (
                        <button
                          key={item.id}
                          onClick={() => goTo(item.id)}
                          aria-current={isActive ? "page" : undefined}
                          className={cx(
                            "flex w-full items-center gap-2.5 rounded-[10px] px-2.5 py-[9px] text-left text-[13.5px] font-[500] transition",
                            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/20",
                            isActive
                              ? "voom-iridescent-border bg-[linear-gradient(100deg,var(--sidebar-bg-active),var(--sidebar-bg-active-2))] text-white font-semibold"
                              : "text-[var(--sidebar-text-2)] hover:bg-[var(--sidebar-bg-hover)] hover:text-white",
                          )}
                        >
                          <span className="grid h-[22px] w-[22px] place-items-center rounded-[7px] text-[var(--sidebar-text-3)]">
                            <Icon name={item.i} size={16} />
                          </span>
                          <span className="truncate">{item.n}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Business / Account context — preserved near bottom, compact */}
        <div className="shrink-0 border-t border-[var(--sidebar-line)] p-3">
          <div className="rounded-[14px] bg-[var(--sidebar-bg-2)] p-3 shadow-[inset_0_1px_0_rgba(255,255,255,.05),0_16px_34px_-25px_rgba(72,104,255,.75)] ring-1 ring-white/[0.07] backdrop-blur-xl">
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--sidebar-green-dot)]" aria-hidden="true" />
                  {/*
                    Billing plan display — deliberately separate from the
                    automation state below, and built as ONE string so the
                    server and the client render identical text nodes.
                  */}
                  <span className="font-display text-[13px] font-semibold text-white tracking-tight">
                    {`${plan === "max" ? "Max" : plan === "pro" ? "Pro" : "Free"} workspace`}
                  </span>
                </div>
                {/*
                  Operational copy comes from the account's SAVED automation
                  mode (the same authoritative value the mode control saves and
                  the plan engine enforces) — never from the billing tier. A Max
                  account running Manual must read Manual here, and an account
                  with nothing stored yet is told exactly that.
                */}
                <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.4] text-[var(--sidebar-text-2)]">
                  {automationModeStatusLine(automationMode)}
                </p>
              </div>
            </div>
            {displayName || email ? (
              <div className="mt-2.5 flex items-center gap-2 rounded-[9px] bg-[var(--sidebar-bg-3)] px-2.5 py-2 ring-1 ring-white/[0.03]">
                <div className="grid h-7 w-7 place-items-center rounded-full bg-white/[0.08] text-[11px] font-bold text-white">
                  {(displayName?.[0] || email?.[0] || "V").toUpperCase()}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-medium text-white">{displayName || "Your account"}</div>
                  <div className="truncate text-[10.5px] text-[var(--sidebar-text-3)]">{email}</div>
                </div>
              </div>
            ) : null}
            <Btn
              variant="plain"
              size="sm"
              block
              className="mt-2.5 h-[32px] !bg-white/[0.08] !text-[12.5px] !font-medium !text-white hover:!bg-white/[0.12] focus-visible:!ring-white/20"
              onClick={() => goTo("pricing")}
            >
              <Icon name="card" size={13} /> Plans & billing
            </Btn>
          </div>
        </div>
      </aside>
    </>
  );
}
