"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navPath } from "@/lib/voom/store";
import { Icon } from "../icons";
import { cx } from "../ui/primitives";
import { pageIdFromPath } from "./nav";

/**
 * Voom 2.0 BottomBar — mobile navigation
 * Mirrors Primary navigation: Today, Marketing Plan, Create, Calendar, Performance
 * Graphite glass shell, iridescent selected state, compact and accessible
 */
const ITEMS: [string, string, string][] = [
  ["today", "Today", "home"],
  ["plan", "Plan", "spark"],
  ["studio", "Create", "plus"],
  ["calendar", "Calendar", "cal"],
  ["performance", "Performance", "trend"],
];

export function BottomBar() {
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-[80] flex h-[68px] border-t border-[var(--sidebar-line)] bg-[rgba(8,10,18,.88)] px-1 shadow-[0_-18px_38px_-28px_rgba(94,75,255,.75)] backdrop-blur-[20px] md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Mobile primary navigation"
    >
      {ITEMS.map(([id, label, icon]) => {
        const isActive = active === id;
        return (
          <Link
            key={id}
            href={navPath(id)}
            prefetch
            aria-current={isActive ? "page" : undefined}
            className={cx(
              "relative flex flex-1 flex-col items-center justify-center gap-1 rounded-[12px] px-1 py-1 text-[10px] font-medium tracking-wide transition",
              isActive ? "text-white" : "text-[var(--sidebar-text-3)]",
            )}
          >
            <span
              className={cx(
                "grid h-7 w-7 place-items-center rounded-[9px] transition",
                isActive ? "voom-grad text-white shadow-[0_8px_22px_-10px_rgba(103,75,255,.82)]" : "text-[var(--sidebar-text-3)]",
              )}
            >
              <Icon name={icon} size={20} />
            </span>
            <span className={cx("leading-none", isActive && "font-semibold")}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
