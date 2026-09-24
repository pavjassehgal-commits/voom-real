"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useVoomActions, useVoomState, getInitials } from "@/lib/voom/store";
import { getPlanConfig } from "@/lib/billing/plans";
import { Icon } from "../icons";
import { IconBtn } from "../ui/primitives";
import { useModal } from "@/lib/voom/modal";
import { NotificationsModal } from "../modals/NotificationsModal";
import { CreateContentModal } from "../modals/CreateContentModal";
import { themeToggleIcon, themeToggleLabel } from "@/lib/voom/theme";
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
        const body = (await response.json()) as { groups?: SearchGroup[]; error?: string };
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
    <div className="relative hidden max-w-[400px] flex-1 md:block" ref={wrapRef}>
      <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-[11px] text-text-3" />
      <input
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search content, campaigns, contacts…"
        aria-label="Search your workspace"
        className="h-[40px] w-full rounded-[12px] border border-line bg-surface-2 pl-[40px] pr-3.5 text-[13.5px] outline-none placeholder:text-text-3 transition focus:border-text focus:bg-surface focus:shadow-[0_0_0_4px_var(--brand-soft)]"
      />
      {open && searchActive && (
        <div className="absolute left-0 right-0 top-[48px] z-[70] max-h-[440px] overflow-y-auto rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]">
          {state === "error" && (
            <p role="alert" className="px-3 py-3 text-[13px] text-red">
              Search couldn’t load right now. Please try again.
            </p>
          )}
          {state === "loading" && <p className="px-3 py-3 text-[13px] text-text-3">Searching…</p>}
          {state === "idle" && total === 0 && (
            <p className="px-3 py-3 text-[13px] text-text-3">No matches for “{query.trim()}”.</p>
          )}
          {visibleGroups.map((group) => (
            <div key={group.label} className="mb-1 last:mb-0">
              <div className="px-3 pb-1 pt-2 font-mono text-[10px] font-bold uppercase tracking-[0.09em] text-text-3">{group.label}</div>
              {group.items.map((item) => (
                <button
                  key={`${group.label}-${item.id}`}
                  type="button"
                  onClick={() => go(item.href)}
                  className="flex w-full flex-col rounded-[10px] px-3 py-2.5 text-left transition hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2"
                >
                  <span className="truncate text-[13.5px] font-semibold tracking-tight">{item.title}</span>
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
      const body = (await response.json()) as { snapshot?: { items?: { status: string }[] } };
      if (response.ok && body.snapshot) {
        const items = body.snapshot.items ?? [];
        setAttention(
          items.filter(
            (item) =>
              item.status === "needs_approval" ||
              item.status === "failed" ||
              item.status === "media_delayed" ||
              item.status === "media_timed_out",
          ).length,
        );
      }
    } catch {
      /* badge stays at its last known value */
    }
  }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => void syncAttention(), 0);
    window.addEventListener("voom:data-changed", syncAttention);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("voom:data-changed", syncAttention);
    };
  }, [syncAttention]);

  const planName = getPlanConfig(plan === "max" ? "max" : plan === "pro" ? "pro" : "free").name;

  function handleNotifOpen() {
    open(<NotificationsModal />);
  }

  return (
    <header className="sticky top-0 z-30 flex h-[64px] items-center gap-3 border-b border-[var(--topbar-line)] bg-[var(--topbar-bg)] px-4 backdrop-blur-[16px] supports-[backdrop-filter]:bg-[var(--topbar-bg)] sm:px-6">
      {/* Mobile: menu + wordmark */}
      <IconBtn
        className="md:hidden !h-9 !w-9 rounded-[10px] border border-line bg-surface-2"
        onClick={() => toggleSidebar(true)}
        aria-label="Open navigation"
      >
        <Icon name="menu" size={18} />
      </IconBtn>
      <div className="flex items-center gap-2 text-[16px] font-bold md:hidden">
        <span className="grid h-[28px] w-[28px] place-items-center rounded-[9px] bg-text text-surface">
          <Icon name="bolt" size={14} className="text-surface" />
        </span>
        <span className="font-display tracking-tight">Voom</span>
      </div>

      <AppSearch />

      <div className="flex-1" />

      {/* Create — restrained, not giant gradient. Dark graphite primary. */}
      <button
        onClick={() => open(<CreateContentModal />)}
        className="hidden h-[36px] items-center gap-1.5 rounded-[11px] bg-text px-3.5 text-[13px] font-semibold tracking-[-0.01em] text-surface shadow-[0_1px_2px_rgba(0,0,0,0.06),0_4px_12px_-4px_rgba(0,0,0,0.12)] transition hover:translate-y-[-1px] hover:shadow-[0_4px_16px_-6px_rgba(0,0,0,0.18)] active:translate-y-0 active:scale-[0.98] md:inline-flex"
      >
        <Icon name="plus" size={14} />
        Create
      </button>

      <div className="hidden h-5 w-px bg-line md:block" aria-hidden="true" />

      <IconBtn
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={themeToggleLabel(theme)}
        aria-label={themeToggleLabel(theme)}
        className="rounded-[10px] border border-transparent hover:border-line hover:bg-surface-2"
      >
        <Icon name={themeToggleIcon(theme)} size={18} />
      </IconBtn>

      <IconBtn
        className="relative rounded-[10px] border border-transparent hover:border-line hover:bg-surface-2"
        onClick={handleNotifOpen}
        title="Notifications"
        aria-label={attention > 0 ? `Notifications, ${attention} need attention` : "Notifications"}
      >
        <Icon name="bell" size={18} />
        {attention > 0 && (
          <span
            className="absolute -right-0.5 -top-0.5 grid h-[18px] min-w-[18px] place-items-center rounded-full bg-text px-1 text-[10px] font-bold text-surface ring-2 ring-[var(--topbar-bg)]"
            aria-label={`${attention} item${attention === 1 ? "" : "s"} need your attention`}
          >
            {attention > 9 ? "9+" : attention}
          </span>
        )}
      </IconBtn>

      <div className="relative" ref={menuRef}>
        <button
          onClick={toggleMenu}
          className="grid h-[36px] w-[36px] flex-none place-items-center rounded-full bg-text text-[12.5px] font-bold text-surface ring-1 ring-line transition hover:brightness-110 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-text focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--topbar-bg)]"
          aria-label="Account menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          {getInitials(displayName, email)}
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-[48px] z-[60] w-[240px] rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]"
            role="menu"
          >
            <div className="px-3 pb-3 pt-2.5">
              <div className="flex items-center gap-2.5">
                <div className="grid h-8 w-8 place-items-center rounded-full bg-text text-[12px] font-bold text-surface">
                  {getInitials(displayName, email)}
                </div>
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-[13.5px] font-semibold tracking-tight">{displayName || "Your account"}</b>
                  <span className="block truncate text-[11.5px] text-text-3">{email}</span>
                </div>
              </div>
              <div className="mt-2.5">
                <span className="inline-flex items-center gap-1.5 rounded-[8px] bg-surface-2 px-2.5 py-1 text-[11px] font-semibold tracking-wide text-text-2 ring-1 ring-line">
                  <span className="h-1.5 w-1.5 rounded-full bg-green" aria-hidden="true" />
                  {planName} plan
                </span>
              </div>
            </div>
            <div className="my-1 h-px bg-line" />
            <MenuBtn
              onClick={() => {
                closeMenu();
                open(<NotificationsModal />);
              }}
              icon="bell"
              label="Notifications"
            />
            <MenuBtn onClick={() => goTo("/app/settings", router, closeMenu)} icon="cog" label="Brand settings" />
            <MenuBtn onClick={() => goTo("/app/pricing", router, closeMenu)} icon="card" label="Plans & billing" />
            <MenuBtn onClick={() => goTo("/app/connections", router, closeMenu)} icon="globe" label="Connections" />
            <div className="my-1 h-px bg-line" />
            <form action={logoutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13px] font-medium text-red transition hover:bg-red-soft focus-visible:outline-none focus-visible:bg-red-soft"
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
      role="menuitem"
      className="flex w-full items-center gap-2.5 rounded-[10px] px-3 py-2.5 text-left text-[13px] font-medium transition hover:bg-surface-2 focus-visible:outline-none focus-visible:bg-surface-2"
    >
      <Icon name={icon} size={16} className="text-text-3" />
      {label}
    </button>
  );
}
