"use client";

import { usePathname } from "next/navigation";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { Icon } from "../icons";
import { Btn, IconBtn, cx } from "../ui/primitives";
import Logo from "@/app/components/Logo";
import { NAV, pageIdFromPath } from "./nav";

export function Sidebar() {
  const { sideOpen, plan } = useVoomState();
  const { goTo, toggleSidebar } = useVoomActions();
  const pathname = usePathname();
  const active = pageIdFromPath(pathname);

  return (
    <>
      {sideOpen && (
        <div className="fixed inset-0 z-[85] bg-black/45 md:hidden" onClick={() => toggleSidebar(false)} />
      )}
      <aside
        className={cx(
          "flex w-[262px] flex-none flex-col border-r border-line bg-surface px-3 py-4.5",
          "fixed left-0 top-0 z-[90] h-dvh -translate-x-[105%] shadow-[var(--shadow-lg)] transition-transform duration-300 md:sticky md:top-0 md:h-dvh md:translate-x-0 md:shadow-none",
          sideOpen && "translate-x-0",
        )}
      >
        <div className="flex items-center justify-between px-2 pb-4.5 pt-1">
          <Logo />
          <IconBtn className="md:hidden" onClick={() => toggleSidebar(false)}>
            <Icon name="x" />
          </IconBtn>
        </div>
        <nav className="flex flex-1 flex-col gap-0.5 overflow-y-auto">
          {NAV.map((group) => (
            <div key={group.g}>
              <div className="px-2.5 pb-1.5 pt-4 font-mono text-[10px] font-bold uppercase tracking-[.09em] text-text-3">
                {group.g}
              </div>
              {group.items.map((item) => (
                <button
                  key={item.id}
                  onClick={() => goTo(item.id)}
                  className={cx(
                    "flex w-full items-center gap-2.5 rounded-[11px] px-2.5 py-2.5 text-left text-sm font-medium transition",
                    active === item.id
                      ? "bg-[var(--brand-soft)] font-semibold text-brand"
                      : "text-text-2 hover:bg-surface-2 hover:text-text",
                  )}
                >
                  <Icon name={item.i} size={18} />
                  <span className="min-w-0 flex-1 truncate">{item.n}</span>
                  {item.badge && (
                    <span className="ml-auto rounded-full bg-brand px-1.5 py-0.5 text-[10.5px] font-bold text-white">
                      {item.badge}
                    </span>
                  )}
                </button>
              ))}
            </div>
          ))}
        </nav>
        {plan !== "max" ? (
          <div className="voom-grad-deep relative mx-1.5 mt-3 overflow-hidden rounded-[15px] p-3.5 text-white">
            <b className="font-display text-[15px]">{plan === "free" ? "You’re on Free" : "You’re on Pro"}</b>
            <p className="my-0.5 mb-2.5 text-xs opacity-85">
              {plan === "free"
                ? "Your assisted marketing workspace is active."
                : "Unlock paid ad management with Max — AED 549/mo."}
            </p>
            <Btn
              variant="plain"
              size="sm"
              block
              className="h-[34px] bg-white/96 text-[13px] text-[#a82c08] hover:bg-white"
              onClick={() => goTo("pricing")}
            >
              <Icon name="crown" size={14} /> Upgrade
            </Btn>
          </div>
        ) : (
          <div className="mx-1.5 mt-3 rounded-[15px] bg-surface-2 p-3.5">
            <b className="flex items-center gap-1.5 text-[15px]">
              <Icon name="crown" size={14} /> Max plan
            </b>
            <p className="mt-0.5 text-xs opacity-70">Voom intelligence is coordinating your approved work.</p>
          </div>
        )}
      </aside>
    </>
  );
}
