"use client";

import { usePathname } from "next/navigation";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "../icons";
import { cx } from "../ui/primitives";
import { pageIdFromPath } from "./nav";

/**
 * Voom 2.0 BottomBar — mobile navigation
 * Mirrors Primary navigation: Today, Marketing Plan, Create, Calendar, Performance
 * Graphite shell, compact, accessible
 */
const ITEMS: [string, string, string][] = [
  ["today", "Today", "home"],
  ["plan", "Plan", "spark"],
  ["studio", "Create", "plus"],
  ["calendar", "Calendar", "cal"],
  ["performance", "Performance", "trend"],
];

export function BottomBar() {
  const { goTo } = useVoomActions();
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-[80] flex h-[68px] border-t border-[var(--sidebar-line)] bg-[var(--sidebar-bg)] px-1 backdrop-blur-[16px] md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Mobile primary navigation"
    >
      {ITEMS.map(([id, label, icon]) => {
        const isActive = active === id;
        return (
          <button
            key={id}
            onClick={() => goTo(id)}
            aria-current={isActive ? "page" : undefined}
            className={cx(
              "relative flex flex-1 flex-col items-center justify-center gap-1 rounded-[12px] px-1 py-1 text-[10px] font-medium tracking-wide transition",
              isActive ? "text-white" : "text-[var(--sidebar-text-3)]",
            )}
          >
            <span
              className={cx(
                "grid h-7 w-7 place-items-center rounded-[9px] transition",
                isActive ? "bg-white/[0.10] text-white" : "text-[var(--sidebar-text-3)]",
              )}
            >
              <Icon name={icon} size={20} />
            </span>
            <span className={cx("leading-none", isActive && "font-semibold")}>{label}</span>
            {isActive && (
              <span className="absolute top-1.5 h-1 w-1 rounded-full bg-[var(--sidebar-green-dot)]" aria-hidden="true" />
            )}
          </button>
        );
      })}
    </nav>
  );
}
