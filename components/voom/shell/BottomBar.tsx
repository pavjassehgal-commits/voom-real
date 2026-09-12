"use client";

import { usePathname } from "next/navigation";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "../icons";
import { cx } from "../ui/primitives";
import { pageIdFromPath } from "./nav";

const ITEMS: [string, string, string][] = [
  ["today", "Today", "home"],
  ["approvals", "Approvals", "check"],
  ["plan", "Plan", "spark"],
  ["calendar", "Calendar", "cal"],
  ["studio", "Create", "plus"],
];

export function BottomBar() {
  const { goTo } = useVoomActions();
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  return (
    <nav
      className="fixed bottom-0 left-0 right-0 z-[80] flex h-[62px] border-t border-line bg-[color-mix(in_srgb,var(--surface)_92%,transparent)] backdrop-blur-[16px] md:hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      {ITEMS.map(([id, label, icon]) => (
        <button
          key={id}
          onClick={() => goTo(id)}
          className={cx(
            "flex flex-1 flex-col items-center justify-center gap-[3px] text-[10px] font-semibold transition",
            active === id ? "text-brand" : "text-text-3",
          )}
        >
          <Icon name={icon} size={20} />
          <span>{label}</span>
        </button>
      ))}
    </nav>
  );
}
