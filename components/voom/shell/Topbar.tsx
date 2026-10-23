"use client";

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { useVoomActions, useVoomState, getInitials } from "@/lib/voom/store";
import { getPlanConfig } from "@/lib/billing/plans";
import { Icon } from "../icons";
import { IconBtn } from "../ui/primitives";
import { VoomLogoMark } from "./VoomLogo";
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
 * Real workflow counts shared by the shell: the bell counts items that need
 * the user's decision or attention, and the sidebar's Approvals badge counts
 * items awaiting approval. Both come from ONE read of the same workflow model
 * the workflow screens use (`/api/voom/workflow`), refreshed whenever the app
 * reports a data change. No count is ever invented.
 */
type WorkflowCounts = { attention: number; approvals: number };
let workflowCounts: WorkflowCounts = { attention: 0, approvals: 0 };
let workflowCountsLoaded = false;
let workflowCountsInFlight: Promise<void> | null = null;
const workflowCountListeners = new Set<() => void>();

function refreshWorkflowCounts(): Promise<void> {
  if (workflowCountsInFlight) return workflowCountsInFlight;
  workflowCountsInFlight = (async () => {
    try {
      const response = await fetch("/api/voom/workflow", { cache: "no-store" });
      const body = (await response.json()) as { snapshot?: { items?: { status: string }[] } };
      if (response.ok && body.snapshot) {
        const items = body.snapshot.items ?? [];
        workflowCounts = {
          attention: items.filter(
            (item) =>
              item.status === "needs_approval" ||
              item.status === "failed" ||
              item.status === "media_delayed" ||
              item.status === "media_timed_out",
          ).length,
          approvals: items.filter((item) => item.status === "needs_approval").length,
        };
        workflowCountListeners.forEach((listener) => listener());
      }
    } catch {
      /* counts stay at their last known value */
    } finally {
      workflowCountsLoaded = true;
      workflowCountsInFlight = null;
    }
  })();
  return workflowCountsInFlight;
}

function onWorkflowDataChanged() {
  void refreshWorkflowCounts();
}

function subscribeWorkflowCounts(listener: () => void) {
  workflowCountListeners.add(listener);
  if (workflowCountListeners.size === 1) window.addEventListener("voom:data-changed", onWorkflowDataChanged);
  if (!workflowCountsLoaded) void refreshWorkflowCounts();
  return () => {
    workflowCountListeners.delete(listener);
    if (workflowCountListeners.size === 0) window.removeEventListener("voom:data-changed", onWorkflowDataChanged);
  };
}

const NO_COUNTS: WorkflowCounts = { attention: 0, approvals: 0 };

export function useWorkflowCounts(): WorkflowCounts {
  return useSyncExternalStore(subscribeWorkflowCounts, () => workflowCounts, () => NO_COUNTS);
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
  const inputRef = useRef<HTMLInputElement>(null);
  const seq = useRef(0);

  // ⌘K / Ctrl+K focuses the real search field (the shortcut shown in it).
  useEffect(() => {
    function onShortcut(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
      }
    }
    document.addEventListener("keydown", onShortcut);
    return () => document.removeEventListener("keydown", onShortcut);
  }, []);

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
    <div className="relative hidden w-[476px] min-w-0 shrink md:block" ref={wrapRef}>
      <Icon name="search" size={17} className="pointer-events-none absolute left-4 top-[13px] text-text-3" />
      <input
        ref={inputRef}
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        placeholder="Search content, campaigns, contacts…"
        aria-label="Search your workspace"
        aria-keyshortcuts="Meta+K Control+K"
        className="h-[44px] w-full rounded-[14px] border border-line bg-surface pl-[44px] pr-14 text-[14px] text-text outline-none placeholder:text-text-3 transition focus:border-[var(--brand-line)] focus:shadow-[0_0_0_4px_var(--brand-soft)]"
      />
      <kbd aria-hidden="true" className="pointer-events-none absolute right-3 top-[11px] rounded-[7px] border border-line bg-surface-2 px-1.5 py-[2px] font-sans text-[11px] font-medium text-text-3">⌘K</kbd>
      {open && searchActive && (
        <div className="absolute left-0 right-0 top-[52px] z-[70] max-h-[440px] overflow-y-auto rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]">
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
  // The notification badge is real: it counts workflow items that need the
  // user's decision or attention (see useWorkflowCounts above).
  const { attention } = useWorkflowCounts();

  useEffect(() => {
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) closeMenu();
    }
    document.addEventListener("click", onClick, true);
    return () => document.removeEventListener("click", onClick, true);
  }, [closeMenu]);

  const planName = getPlanConfig(plan === "max" ? "max" : plan === "pro" ? "pro" : "free").name;

  function handleNotifOpen() {
    open(<NotificationsModal />);
  }

  return (
    <header className="sticky top-0 z-30 flex h-[72px] items-center gap-2 border-b border-[var(--topbar-line)] bg-[var(--topbar-bg)] px-4 backdrop-blur-[16px] supports-[backdrop-filter]:bg-[var(--topbar-bg)] sm:gap-3 sm:px-6 lg:px-8">
      {/* Mobile: menu + wordmark */}
      <IconBtn
        className="md:hidden !h-10 !w-10 rounded-[12px] border border-line bg-surface"
        onClick={() => toggleSidebar(true)}
        aria-label="Open navigation"
      >
        <Icon name="menu" size={18} />
      </IconBtn>
      <div className="flex items-center gap-2 md:hidden">
        <VoomLogoMark size={28} />
        <span className="text-[19px] font-bold tracking-[-0.03em] text-text">voom</span>
      </div>

      <AppSearch />

      <div className="flex-1" />

      <button
        onClick={() => open(<CreateContentModal />)}
        className="voom-create-btn hidden h-[44px] items-center gap-2 rounded-full px-[18px] text-[14.5px] font-semibold text-white shadow-[0_4px_12px_-6px_rgba(134,69,250,.6)] transition hover:brightness-[1.04] hover:shadow-[0_6px_16px_-8px_rgba(134,69,250,.75)] active:scale-[0.98] md:inline-flex"
      >
        <Icon name="plus" size={16} />
        Create
      </button>

      <IconBtn
        onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
        title={themeToggleLabel(theme)}
        aria-label={themeToggleLabel(theme)}
        className="!h-10 !w-10 rounded-full text-text-2 hover:bg-surface-3 hover:text-text sm:ml-2"
      >
        <Icon name={themeToggleIcon(theme)} size={19} />
      </IconBtn>

      <IconBtn
        className="relative !h-10 !w-10 rounded-full text-text-2 hover:bg-surface-3 hover:text-text"
        onClick={handleNotifOpen}
        title="Notifications"
        aria-label={attention > 0 ? `Notifications, ${attention} need attention` : "Notifications"}
      >
        <Icon name="bell" size={19} />
        {attention > 0 && (
          <span
            className="absolute right-[7px] top-[7px] h-2 w-2 rounded-full bg-[var(--coral)] ring-2 ring-[var(--bg)]"
            aria-label={`${attention} item${attention === 1 ? "" : "s"} need your attention`}
          />
        )}
      </IconBtn>

      <div className="relative" ref={menuRef}>
        <button
          onClick={toggleMenu}
          className="flex h-11 items-center gap-1.5 rounded-full pl-0.5 pr-1.5 text-text-2 transition hover:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]"
          aria-label="Account menu"
          aria-expanded={menuOpen}
          aria-haspopup="menu"
        >
          <span className="grid h-10 w-10 place-items-center rounded-full bg-surface-3 text-[13px] font-bold text-text">
            {getInitials(displayName, email)}
          </span>
          <Icon name="chevD" size={16} className="hidden sm:block" />
        </button>
        {menuOpen && (
          <div
            className="absolute right-0 top-[52px] z-[60] w-[248px] rounded-[18px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]"
            role="menu"
          >
            <div className="px-3 pb-3 pt-2.5">
              <div className="flex items-center gap-2.5">
                <div className="grid h-9 w-9 place-items-center rounded-full bg-surface-3 text-[12px] font-bold text-text">
                  {getInitials(displayName, email)}
                </div>
                <div className="min-w-0 flex-1">
                  <b className="block truncate text-[14px] font-semibold tracking-tight">{displayName || "Your account"}</b>
                  <span className="block truncate text-[12px] text-text-3">{email}</span>
                </div>
              </div>
              <div className="mt-2.5">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-[11.5px] font-semibold text-[var(--brand-ink)]">
                  <span className="h-1.5 w-1.5 rounded-full bg-[var(--green-dot)]" aria-hidden="true" />
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
            <MenuBtn onClick={() => goTo("/app/connections", router, closeMenu)} icon="share" label="Channels" />
            <div className="my-1 h-px bg-line" />
            <form action={logoutAction}>
              <button
                type="submit"
                role="menuitem"
                className="flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-[13.5px] font-medium text-red transition hover:bg-red-soft focus-visible:outline-none focus-visible:bg-red-soft"
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
      className="flex w-full items-center gap-2.5 rounded-[12px] px-3 py-2.5 text-left text-[13.5px] font-medium transition hover:bg-surface-3 focus-visible:outline-none focus-visible:bg-surface-3"
    >
      <Icon name={icon} size={16} className="text-text-3" />
      {label}
    </button>
  );
}
