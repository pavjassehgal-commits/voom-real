"use client";

import { useEffect, useRef } from "react";
import { useVoomActions, useVoomState, getInitials } from "@/lib/voom/store";
import { PLANS } from "@/lib/voom/demoData";
import { Icon } from "../icons";
import { IconBtn } from "../ui/primitives";
import { useModal } from "@/lib/voom/modal";
import { NotificationsModal } from "../modals/NotificationsModal";
import { ComposeModal } from "../modals/ComposeModal";
import { logout as logoutAction } from "@/app/app/actions";

export function Topbar() {
  const { theme, notif, menuOpen, plan, displayName, email } = useVoomState();
  const { toggleSidebar, setTheme, openNotifs, toggleMenu, closeMenu, goTo } = useVoomActions();
  const { open } = useModal();
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [closeMenu]);

  const planName = PLANS.find((p) => p.id === plan)?.name ?? "Free";

  function handleNotifOpen() {
    openNotifs();
    open(<NotificationsModal />);
  }

  return (
    <header className="sticky top-0 z-30 flex h-16 items-center gap-3.5 border-b border-line bg-[color-mix(in_srgb,var(--surface)_82%,transparent)] px-4 backdrop-blur-[14px] sm:px-[22px]">
      <IconBtn className="md:hidden" onClick={() => toggleSidebar(true)}>
        <Icon name="menu" />
      </IconBtn>
      <div className="flex items-center gap-2 text-[17px] font-bold md:hidden">
        <span className="voom-grad grid h-[27px] w-[27px] place-items-center rounded-[9px]">
          <Icon name="bolt" size={15} className="text-white" />
        </span>
      </div>
      <div className="relative hidden max-w-[380px] flex-1 md:block">
        <Icon name="search" size={16} className="absolute left-3 top-[11px] text-text-3" />
        <input
          placeholder="Search isn't available in this version"
          aria-label="Search isn't available in this version"
          title="Search isn't available in this version"
          className="h-[38px] w-full rounded-[11px] border border-line bg-surface-2 pl-[38px] pr-3 text-sm outline-none"
          readOnly
        />
      </div>
      <div className="flex-1" />
      <button
        onClick={() => open(<ComposeModal />)}
        className="voom-grad hidden h-[34px] items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-semibold text-white shadow-[0_6px_18px_-8px_var(--brand)] hover:brightness-110 md:inline-flex"
      >
        <Icon name="plus" size={14} /> Create
      </button>
      <IconBtn onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Theme">
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </IconBtn>
      <IconBtn className="relative" onClick={handleNotifOpen}>
        <Icon name="bell" />
        {notif > 0 && (
          <span className="absolute right-[7px] top-1.5 h-2 w-2 rounded-full border-2 border-surface bg-brand" />
        )}
      </IconBtn>
      <div className="relative" ref={menuRef}>
        <button
          onClick={toggleMenu}
          className="voom-grad grid h-[34px] w-[34px] flex-none place-items-center rounded-full text-[13px] font-bold text-white"
        >
          {getInitials(displayName, email)}
        </button>
        {menuOpen && (
          <div className="absolute right-0 top-[46px] z-[60] w-[216px] rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]">
            <div className="px-2.5 pb-2.5 pt-2">
              <b className="block text-[13.5px]">{displayName || "Your account"}</b>
              <span className="text-xs text-text-3">{email}</span>
              <div className="mt-1.5">
                <span className="inline-flex items-center rounded-[7px] bg-[var(--brand-soft)] px-2.5 py-[3px] text-[11.5px] font-semibold text-brand">
                  {planName} plan
                </span>
              </div>
            </div>
            <div className="my-1 h-px bg-line" />
            <MenuBtn onClick={() => goTo("settings")} icon="cog" label="Brand settings" />
            <MenuBtn onClick={() => goTo("pricing")} icon="card" label="Plans & billing" />
            <MenuBtn onClick={() => goTo("instagram")} icon="ig" label="Connections" />
            <div className="my-1 h-px bg-line" />
            <form action={logoutAction}>
              <button
                type="submit"
                className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left text-[13.5px] font-medium text-red transition hover:bg-surface-2"
              >
                <Icon name="logout" size={16} />
                Sign out
              </button>
            </form>
          </div>
        )}
      </div>
    </header>
  );
}

function MenuBtn({ onClick, icon, label }: { onClick: () => void; icon: string; label: string }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 rounded-[9px] px-2.5 py-2.5 text-left text-[13.5px] font-medium transition hover:bg-surface-2"
    >
      <Icon name={icon} size={16} className="text-text-3" />
      {label}
    </button>
  );
}
