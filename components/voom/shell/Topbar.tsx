"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVoomActions, useVoomState, getInitials } from "@/lib/voom/store";
import { PLANS } from "@/lib/voom/demoData";
import { Icon } from "../icons";
import { IconBtn } from "../ui/primitives";
import { useModal } from "@/lib/voom/modal";
import { NotificationsModal } from "../modals/NotificationsModal";
import { CreateContentModal } from "../modals/CreateContentModal";
import { logout as logoutAction } from "@/app/app/actions";

interface SearchGroup {
  label: string;
  href: string;
  items: { id: string; title: string; subtitle: string; href: string }[];
}

/**
 * Real app search over the signed-in account's own content, calendar items,
 * campaigns, contacts and audiences (server route `/api/search`). No demo
 * data and no dead control: results link to the real screens.
 */
function AppSearch() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [groups, setGroups] = useState<SearchGroup[]>([]);
  const [state, setState] = useState<"idle" | "loading" | "error">("idle");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const seq = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (trimmed.length < 2) return;
    const request = ++seq.current;
    const timer = window.setTimeout(async () => {
      setState("loading");
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(trimmed)}`, { cache: "no-store" });
        const body = await response.json() as { groups?: SearchGroup[]; error?: string };
        if (request !== seq.current) return;
        if (!response.ok) throw new Error(body.error ?? "Search couldn't load right now.");
        setGroups(body.groups ?? []);
        setState("idle");
      } catch {
        if (request === seq.current) setState("error");
      }
    }, 220);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    function onClick(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, []);

  const searchActive = query.trim().length >= 2;
  const visibleGroups = useMemo(() => (searchActive ? groups : []), [searchActive, groups]);
  const total = useMemo(() => visibleGroups.reduce((sum, group) => sum + group.items.length, 0), [visibleGroups]);

  function go(href: string) {
    setOpen(false);
    setQuery("");
    router.push(href);
  }

  return (
    <div className="relative hidden max-w-[380px] flex-1 md:block" ref={wrapRef}>
      <Icon name="search" size={16} className="absolute left-3 top-[11px] text-text-3" />
      <input
        value={query}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        placeholder="Search content, campaigns, contacts…"
        aria-label="Search your workspace"
        className="h-[38px] w-full rounded-[11px] border border-line bg-surface-2 pl-[38px] pr-3 text-sm outline-none placeholder:text-text-3 focus:border-brand"
      />
      {open && searchActive && (
        <div className="absolute left-0 right-0 top-[44px] z-[70] max-h-[420px] overflow-y-auto rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]">
          {state === "error" && (
            <p role="alert" className="px-2.5 py-3 text-[13px] text-red">Search couldn’t load right now. Please try again.</p>
          )}
          {state === "loading" && (
            <p className="px-2.5 py-3 text-[13px] text-text-3">Searching…</p>
          )}
          {state === "idle" && total === 0 && (
            <p className="px-2.5 py-3 text-[13px] text-text-3">No matches for “{query.trim()}”.</p>
          )}
          {visibleGroups.map((group) => (
            <div key={group.label} className="mb-1 last:mb-0">
              <div className="px-2.5 pb-1 pt-2 font-mono text-[10px] font-bold uppercase tracking-[.09em] text-text-3">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={`${group.label}-${item.id}`}
                  type="button"
                  onClick={() => go(item.href)}
                  className="flex w-full flex-col rounded-[9px] px-2.5 py-2 text-left transition hover:bg-surface-2"
                >
                  <span className="truncate text-[13.5px] font-semibold">{item.title}</span>
                  {item.subtitle && <span className="truncate text-[11.5px] text-text-3">{item.subtitle}</span>}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Topbar() {
  const router = useRouter();
  const { theme, menuOpen, plan, displayName, email } = useVoomState();
  const { toggleSidebar, setTheme, toggleMenu, closeMenu } = useVoomActions();
  const { open } = useModal();
  const menuRef = useRef<HTMLDivElement>(null);
  const [attention, setAttention] = useState(0);

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [closeMenu]);

  // The notification badge is real: it counts workflow items that need the
  // user's decision or attention, from the same read model the workflow
  // screens use.
  const syncAttention = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/workflow", { cache: "no-store" });
      const body = await response.json() as { snapshot?: { items?: { status: string }[] } };
      if (response.ok && body.snapshot) {
        const items = body.snapshot.items ?? [];
        setAttention(items.filter((item) => item.status === "needs_approval" || item.status === "failed").length);
      }
    } catch { /* badge stays at its last known value */ }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void syncAttention(), 0);
    window.addEventListener("voom:data-changed", syncAttention);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("voom:data-changed", syncAttention);
    };
  }, [syncAttention]);

  const planName = PLANS.find((p) => p.id === plan)?.name ?? "Free";

  function handleNotifOpen() {
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
      <AppSearch />
      <div className="flex-1" />
      <button
        onClick={() => open(<CreateContentModal />)}
        className="voom-grad hidden h-[34px] items-center gap-1.5 rounded-[9px] px-3.5 text-[13px] font-semibold text-white shadow-[0_6px_18px_-8px_var(--brand)] hover:brightness-110 md:inline-flex"
      >
        <Icon name="plus" size={14} /> Create
      </button>
      <IconBtn onClick={() => setTheme(theme === "dark" ? "light" : "dark")} title="Theme">
        <Icon name={theme === "dark" ? "sun" : "moon"} />
      </IconBtn>
      <IconBtn className="relative" onClick={handleNotifOpen} title="Notifications">
        <Icon name="bell" />
        {attention > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 grid h-[17px] min-w-[17px] place-items-center rounded-full bg-brand px-1 text-[10px] font-bold text-white"
            aria-label={`${attention} item${attention === 1 ? "" : "s"} need your attention`}
          >
            {attention > 9 ? "9+" : attention}
          </span>
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
            <MenuBtn onClick={() => { closeMenu(); open(<NotificationsModal />); }} icon="bell" label="Notifications" />
            <MenuBtn onClick={() => goTo("/app/settings", router, closeMenu)} icon="cog" label="Brand settings" />
            <MenuBtn onClick={() => goTo("/app/pricing", router, closeMenu)} icon="card" label="Plans & billing" />
            <MenuBtn onClick={() => goTo("/app/instagram", router, closeMenu)} icon="ig" label="Connections" />
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

function goTo(href: string, router: ReturnType<typeof useRouter>, close: () => void) {
  close();
  router.push(href);
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
