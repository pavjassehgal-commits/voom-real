"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navPath } from "@/lib/voom/store";
import { Icon } from "../icons";
import { cx } from "../ui/primitives";
import { pageIdFromPath } from "./nav";

/**
 * BottomBar — mobile navigation (restyled to the Batch 1 shell tokens)
 * Mirrors primary navigation: Today, Marketing Plan, Create, Calendar, Performance
 * Light surface, violet selected state, compact and accessible
 */
const ITEMS: [string, string, string][] = [
  ["today", "Today", "home"],
  ["plan", "Plan", "map"],
  ["studio", "Create", "pencil"],
  ["calendar", "Calendar", "cal"],
  ["performance", "Performance", "bars"],
];

export function BottomBar() {
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-[80] flex h-[68px] border-t border-[var(--sidebar-line)] bg-[var(--topbar-bg)] px-1 backdrop-blur-[16px] md:hidden"
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
            data-haptic="light"
            aria-current={isActive ? "page" : undefined}
            className={cx(
              "relative flex flex-1 flex-col items-center justify-center gap-1 rounded-[12px] px-1 py-1 text-[10px] font-medium tracking-wide transition",
              isActive ? "text-[var(--brand-ink)]" : "text-[var(--sidebar-text-3)]",
            )}
          >
            <span
              className={cx(
                "grid h-7 w-7 place-items-center rounded-[9px] transition",
                isActive ? "bg-[var(--brand-tile)] text-[var(--brand-ink)]" : "text-[var(--sidebar-text-3)]",
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
