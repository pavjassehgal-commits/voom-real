"use client";

/**
 * The client store holds only real, user-owned state: the signed-in profile,
 * the business/brand record, the Instagram connection flag, UI state (theme,
 * sidebar, toasts) and the onboarding wizard. It seeds nothing from sample
 * data — every screen that shows content reads it from the server APIs, so
 * the UI can only ever show work that actually exists.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type {
  BusinessProfileInput,
  BusinessRecord,
  OnboardingAnswers,
  OnboardingInput,
  Toast,
} from "./types";
import { saveOnboarding as saveOnboardingAction, saveBrandSettings as saveBrandSettingsAction, saveMediaSpendSettings as saveMediaSpendAction, restartOnboarding as restartOnboardingAction } from "./mutations";
import { normalizeMediaSpendSettings, type MediaSpendSettings } from "@/lib/mara/media-spend";
import { brandFromBusiness, deriveHandle, type Brand } from "./brand-state";

const NAV_PATHS: Record<string, string> = {
  dash: "/app/today",
  today: "/app/today",
  approvals: "/app/approvals",
  plan: "/app/plan",
  // Voom 2.0 primary aliases
  "marketing-plan": "/app/plan",
  marketing_plan: "/app/plan",
  create: "/app/studio",
  studio: "/app/studio",
  calendar: "/app/calendar",
  campaigns: "/app/campaigns",
  ads: "/app/ads",
  automations: "/app/automations",
  performance: "/app/performance",
  connections: "/app/connections",
  contacts: "/app/contacts",
  instagram: "/app/instagram",
  tiktok: "/app/tiktok",
  youtube: "/app/youtube",
  reels: "/app/studio",
  mara: "/app/mara",
  pricing: "/app/pricing",
  settings: "/app/settings",
};

function emptyOnboard(): OnboardingAnswers {
  return {
    displayName: "",
    desc: "",
    name: "",
    site: "",
    industry: "",
    customer: [],
    goal: "",
    tone: [],
    channels: [],
    budget: "",
    freq: "",
    auto: "",
    permission: "",
  };
}

export function getInitials(name: string, email: string | null | undefined): string {
  const source = name.trim() || (email ?? "").split("@")[0] || "V";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  return (parts.length >= 2 ? parts[0][0] + parts[1][0] : source.slice(0, 2)).toUpperCase();
}

interface VoomState {
  displayName: string;
  email: string;
  theme: "light" | "dark";
  sideOpen: boolean;
  menuOpen: boolean;
  igConnected: boolean;
  plan: "free" | "pro" | "max";
  brand: Brand;
  /** AI Media Spending settings — the live value the settings screen edits. */
  mediaSpend: MediaSpendSettings;
  onboard: OnboardingAnswers;
  onboardStep: number;
  onboardSaving: boolean;
  onboardError: string | null;
  settingsSaving: boolean;
  settingsError: string | null;
  toasts: Toast[];
}

function normalizePlan(value: string | null | undefined): "free" | "pro" | "max" {
  if (value === "pro" || value === "max") return value;
  return "free";
}

function initialState(init: { displayName: string | null; email: string | null; business: BusinessRecord | null }): VoomState {
  // Voom 2.0 defaults to light (warm off-white workspace) — dark remains available via toggle
  const saved = typeof window !== "undefined" ? window.localStorage.getItem("voom-theme") : null;
  const initialTheme = saved === "dark" || saved === "light" ? (saved as "light" | "dark") : "light";
  return {
    displayName: init.displayName?.trim() ?? "",
    email: init.email ?? "",
    theme: initialTheme,
    sideOpen: false,
    menuOpen: false,
    igConnected: false,
    plan: normalizePlan(init.business?.plan),
    brand: brandFromBusiness(init.business),
    mediaSpend: normalizeMediaSpendSettings(init.business),
    onboard: { ...emptyOnboard(), displayName: init.displayName?.trim() ?? "" },
    onboardStep: 0,
    onboardSaving: false,
    onboardError: null,
    settingsSaving: false,
    settingsError: null,
    toasts: [],
  };
}

let toastId = 0;

interface VoomActions {
  goTo: (id: string) => void;
  toggleSidebar: (open?: boolean) => void;
  toggleMenu: () => void;
  closeMenu: () => void;
  setTheme: (t: "light" | "dark") => void;
  toast: (msg: string, kind?: Toast["kind"], proto?: boolean) => void;
  dismissToast: (id: number) => void;

  igDisconnect: () => void;

  toggleTone: (t: string) => void;
  saveBrandSettings: (input: BusinessProfileInput) => Promise<boolean>;
  saveMediaSpend: (input: MediaSpendSettings) => Promise<boolean>;

  setOnboardField: <K extends keyof OnboardingAnswers>(key: K, value: OnboardingAnswers[K]) => void;
  toggleOnboardArray: (key: "customer" | "tone" | "channels", value: string, max?: number) => boolean;
  setOnboardStep: (step: number) => void;
  finishOnboarding: (skipped: boolean) => Promise<boolean>;
  restartOnboarding: () => Promise<void>;
}

const StateCtx = createContext<VoomState | null>(null);
const ActionsCtx = createContext<VoomActions | null>(null);

export function VoomProvider({
  children,
  initialDisplayName,
  initialEmail,
  initialBusiness,
}: {
  children: ReactNode;
  initialDisplayName: string | null;
  initialEmail: string | null;
  initialBusiness: BusinessRecord | null;
}) {
  const [state, setState] = useState<VoomState>(() =>
    initialState({ displayName: initialDisplayName, email: initialEmail, business: initialBusiness }),
  );
  const router = useRouter();
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);

  // Voom 2.0: ensure theme dataset is synced on mount and on theme change
  useEffect(() => {
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = state.theme;
    }
  }, [state.theme]);

  useEffect(() => {
    let active = true;
    const syncInstagram = async () => {
      try {
        const response = await fetch("/api/integrations/instagram/status", { cache: "no-store" });
        const value = await response.json() as { connection?: { connected?: boolean } };
        if (active && response.ok) setState((current) => ({ ...current, igConnected: Boolean(value.connection?.connected) }));
      } catch { /* Connection status remains safely disconnected. */ }
    };
    void syncInstagram();
    window.addEventListener("voom:instagram-changed", syncInstagram);
    return () => { active = false; window.removeEventListener("voom:instagram-changed", syncInstagram); };
  }, []);

  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const toast = useCallback<VoomActions["toast"]>((msg, kind = "ok") => {
    const id = ++toastId;
    setState((s) => ({ ...s, toasts: [...s.toasts, { id, msg, kind }] }));
    after(3000, () => {
      setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
    });
  }, [after]);

  const dismissToast = useCallback<VoomActions["dismissToast"]>((id) => {
    setState((s) => ({ ...s, toasts: s.toasts.filter((t) => t.id !== id) }));
  }, []);

  const goTo = useCallback<VoomActions["goTo"]>(
    (id) => {
      setState((s) => ({ ...s, sideOpen: false, menuOpen: false }));
      router.push(NAV_PATHS[id] ?? "/app");
    },
    [router],
  );

  const toggleSidebar = useCallback<VoomActions["toggleSidebar"]>((open) => {
    setState((s) => ({ ...s, sideOpen: open ?? !s.sideOpen }));
  }, []);

  const toggleMenu = useCallback<VoomActions["toggleMenu"]>(() => {
    setState((s) => ({ ...s, menuOpen: !s.menuOpen }));
  }, []);

  const closeMenu = useCallback<VoomActions["closeMenu"]>(() => {
    setState((s) => (s.menuOpen ? { ...s, menuOpen: false } : s));
  }, []);

  const setTheme = useCallback<VoomActions["setTheme"]>((t) => {
    setState((s) => ({ ...s, theme: t }));
    if (typeof document !== "undefined") {
      document.documentElement.dataset.theme = t;
      window.localStorage.setItem("voom-theme", t);
    }
  }, []);

  const igDisconnect = useCallback<VoomActions["igDisconnect"]>(() => {
    setState((s) => ({ ...s, igConnected: false }));
  }, []);

  const toggleTone = useCallback<VoomActions["toggleTone"]>((t) => {
    setState((s) => {
      const has = s.brand.tone.includes(t);
      return { ...s, brand: { ...s.brand, tone: has ? s.brand.tone.filter((x) => x !== t) : [...s.brand.tone, t] } };
    });
  }, []);

  const saveBrandSettings = useCallback<VoomActions["saveBrandSettings"]>(
    async (input) => {
      setState((s) => ({ ...s, settingsSaving: true, settingsError: null }));
      const result = await saveBrandSettingsAction(input);
      if (!result.ok) {
        setState((s) => ({ ...s, settingsSaving: false, settingsError: result.error }));
        return false;
      }
      setState((s) => ({
        ...s,
        settingsSaving: false,
        settingsError: null,
        displayName: input.displayName.trim(),
        brand: {
          name: input.brandName.trim(),
          handle: deriveHandle(input.brandName.trim()),
          industry: input.industry,
          desc: input.brandDescription.trim(),
          audience: input.targetCustomer,
          goals: input.mainGoal ? [input.mainGoal] : [],
          tone: input.brandPersonality,
          channels: input.preferredChannels,
          budget: input.monthlyAdBudget,
          freq: input.contentFrequency,
          auto: input.automationLevel,
          permission: input.publishingPermission,
        },
      }));
      toast("Brand profile saved");
      return true;
    },
    [toast],
  );

  const saveMediaSpend = useCallback<VoomActions["saveMediaSpend"]>(
    async (input) => {
      setState((s) => ({ ...s, settingsSaving: true, settingsError: null }));
      const result = await saveMediaSpendAction(input);
      if (!result.ok) {
        setState((s) => ({ ...s, settingsSaving: false, settingsError: result.error }));
        return false;
      }
      setState((s) => ({
        ...s,
        settingsSaving: false,
        settingsError: null,
        // The saved value is the normalized value the server enforces.
        mediaSpend: normalizeMediaSpendSettings({
          allow_automatic_paid_media: input.allowAutomaticPaidMedia,
          monthly_media_budget_usd: input.monthlyMediaBudgetUsd,
        }),
      }));
      toast("AI media spending saved");
      return true;
    },
    [toast],
  );

  const setOnboardField = useCallback<VoomActions["setOnboardField"]>((key, value) => {
    setState((s) => ({ ...s, onboard: { ...s.onboard, [key]: value } }));
  }, []);

  const toggleOnboardArray = useCallback<VoomActions["toggleOnboardArray"]>((key, value, max) => {
    let ok = true;
    setState((s) => {
      const arr = s.onboard[key];
      const has = arr.includes(value);
      if (!has && max && arr.length >= max) {
        ok = false;
        return s;
      }
      const next = has ? arr.filter((v) => v !== value) : [...arr, value];
      return { ...s, onboard: { ...s.onboard, [key]: next } };
    });
    if (!ok) toast(`Pick up to ${max}`, "err");
    return ok;
  }, [toast]);

  const setOnboardStep = useCallback<VoomActions["setOnboardStep"]>((step) => {
    setState((s) => ({ ...s, onboardStep: step }));
  }, []);

  const finishOnboarding = useCallback<VoomActions["finishOnboarding"]>(
    async (skipped) => {
      const o = state.onboard;
      setState((s) => ({ ...s, onboardSaving: true, onboardError: null }));

      const payload: OnboardingInput = {
        displayName: o.displayName,
        brandName: skipped ? "" : o.name,
        brandDescription: skipped ? "" : o.desc,
        industry: skipped ? "" : o.industry,
        targetCustomer: skipped ? [] : o.customer,
        mainGoal: skipped ? "" : o.goal,
        brandPersonality: skipped ? [] : o.tone,
        preferredChannels: skipped ? [] : o.channels,
        monthlyAdBudget: skipped ? "" : o.budget,
        contentFrequency: skipped ? "" : o.freq,
        automationLevel: skipped ? "" : o.auto,
        publishingPermission: skipped ? "" : o.permission,
        // Stored through the existing email brand profile path, never on
        // `businesses` (see OnboardingInput).
        website: skipped ? "" : o.site,
      };

      const result = await saveOnboardingAction(payload);
      if (!result.ok) {
        setState((s) => ({ ...s, onboardSaving: false, onboardError: result.error }));
        return false;
      }
      if (result.notice) toast(result.notice, "info");

      const displayName = payload.displayName.trim();
      setState((s) => ({
        ...s,
        onboardSaving: false,
        onboardError: null,
        displayName,
        brand: skipped ? s.brand : {
          name: payload.brandName.trim(),
          handle: deriveHandle(payload.brandName.trim()),
          industry: payload.industry,
          desc: payload.brandDescription,
          audience: payload.targetCustomer,
          goals: payload.mainGoal ? [payload.mainGoal] : [],
          tone: payload.brandPersonality,
          channels: payload.preferredChannels,
          budget: payload.monthlyAdBudget,
          freq: payload.contentFrequency,
          auto: payload.automationLevel,
          permission: payload.publishingPermission,
        },
      }));
      return true;
    },
    [state.onboard, toast],
  );

  const restartOnboarding = useCallback<VoomActions["restartOnboarding"]>(async () => {
    const result = await restartOnboardingAction();
    if (!result.ok) {
      toast(result.error, "err");
      return;
    }
    setState((s) => ({ ...s, onboard: { ...emptyOnboard(), displayName: s.displayName }, onboardStep: 0, igConnected: false }));
    router.push("/app/onboarding");
  }, [router, toast]);

  const actions = useMemo<VoomActions>(
    () => ({
      goTo,
      toggleSidebar,
      toggleMenu,
      closeMenu,
      setTheme,
      toast,
      dismissToast,
      igDisconnect,
      toggleTone,
      saveBrandSettings,
      saveMediaSpend,
      setOnboardField,
      toggleOnboardArray,
      setOnboardStep,
      finishOnboarding,
      restartOnboarding,
    }),
    [
      goTo,
      toggleSidebar,
      toggleMenu,
      closeMenu,
      setTheme,
      toast,
      dismissToast,
      igDisconnect,
      toggleTone,
      saveBrandSettings,
      saveMediaSpend,
      setOnboardField,
      toggleOnboardArray,
      setOnboardStep,
      finishOnboarding,
      restartOnboarding,
    ],
  );

  return (
    <StateCtx.Provider value={state}>
      <ActionsCtx.Provider value={actions}>{children}</ActionsCtx.Provider>
    </StateCtx.Provider>
  );
}

export function useVoomState(): VoomState {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error("useVoomState must be used inside VoomProvider");
  return ctx;
}

export function useVoomActions(): VoomActions {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error("useVoomActions must be used inside VoomProvider");
  return ctx;
}
