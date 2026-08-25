"use client";

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import type {
  AdAllocation,
  ApprovedPlan,
  BusinessProfileInput,
  BusinessRecord,
  ChatMessage,
  EmailOrSms,
  OnboardingAnswers,
  Plan,
  Post,
  ReelQueueItem,
  Toast,
} from "./types";
import {
  CHANNEL_SHARE,
  KPIS,
  PACKS,
  SERIES,
  TMPLS,
  buildAdAlloc,
  buildAdHistory,
  buildCampaignsTable,
  buildEmails,
  buildInsights,
  buildPosts,
  buildReelQueue,
  buildSms,
  fmtTime,
} from "./demoData";
import { saveOnboarding as saveOnboardingAction, saveBrandSettings as saveBrandSettingsAction, restartOnboarding as restartOnboardingAction } from "./mutations";

const NAV_PATHS: Record<string, string> = {
  dash: "/app",
  mara: "/app/mara",
  calendar: "/app/calendar",
  reels: "/app/reels",
  campaigns: "/app/campaigns",
  ads: "/app/ads",
  instagram: "/app/instagram",
  pricing: "/app/pricing",
  settings: "/app/settings",
};

const FALLBACK_INDUSTRY = "Other";

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
    color: "#e8481f",
  };
}

interface Brand {
  name: string;
  handle: string;
  industry: string;
  audience: string[];
  goals: string[];
  tone: string[];
  channels: string[];
  budget: string;
  freq: string;
  auto: string;
  permission: string;
  color: string;
}

function deriveHandle(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18);
  return slug ? "@" + slug : "";
}

function emptyBrand(): Brand {
  return {
    name: "",
    handle: "",
    industry: "",
    audience: [],
    goals: [],
    tone: [],
    channels: [],
    budget: "",
    freq: "",
    auto: "",
    permission: "",
    color: "#e8481f",
  };
}

function brandFromBusiness(business: BusinessRecord | null): Brand {
  if (!business) return emptyBrand();
  const name = business.brand_name?.trim() ?? "";
  return {
    name,
    handle: deriveHandle(name),
    industry: business.industry ?? "",
    audience: business.target_customer ?? [],
    goals: business.main_goal ? [business.main_goal] : [],
    tone: business.brand_personality ?? [],
    channels: business.preferred_channels ?? [],
    budget: business.monthly_ad_budget ?? "",
    freq: business.content_frequency ?? "",
    auto: business.automation_level ?? "",
    permission: business.publishing_permission ?? "",
    color: "#e8481f",
  };
}

interface VoomState {
  hydrated: boolean;
  displayName: string;
  email: string;
  theme: "light" | "dark";
  sideOpen: boolean;
  menuOpen: boolean;
  notif: number;
  calMonth: number;
  calYear: number;
  calFilter: string;
  campTab: "email" | "sms";
  reelTmpl: number;
  reelTime: string;
  reelCaption: string;
  igConnected: boolean;
  igStep: number;
  plan: Plan["id"];
  brand: Brand;
  posts: Post[];
  reelQueue: ReelQueueItem[];
  campaignsTable: ReturnType<typeof buildCampaignsTable>;
  emails: EmailOrSms[];
  sms: EmailOrSms[];
  adAlloc: AdAllocation[];
  adTotal: number;
  adHistory: ReturnType<typeof buildAdHistory>;
  approvedPlan: ApprovedPlan | null;
  changeMode: boolean;
  insights: ReturnType<typeof buildInsights>;
  defaultCap: string;
  chat: ChatMessage[];
  typing: boolean;
  onboard: OnboardingAnswers;
  onboardStep: number;
  onboardSaving: boolean;
  onboardError: string | null;
  settingsSaving: boolean;
  settingsError: string | null;
  toasts: Toast[];
}

function seedChatFor(firstName: string, brandName: string, slot: string, slotWhy: string, cold: string): ChatMessage[] {
  const greetName = firstName ? ` ${firstName}` : "";
  const brandLabel = brandName || "your business";
  return [
    {
      r: "mara",
      h: `Hi${greetName} 👋 I'm <b>MARA</b>, your marketing manager.
      I've studied <b>${brandLabel}</b> and drafted your next 14 days.<br><br>
      Three things I'd tackle first:
      <ul><li>Move your Reels to the <b>${slot}</b> slot — ${slotWhy}</li>
      <li>Re-engage <b>1,284</b> ${cold}</li>
      <li>Review <b>AED 1,200</b> in optional ad budget I've drafted</li></ul>
      <span class="tag t-grey" style="margin-top:8px">Demo data</span>`,
      acts: [
        ["Show me the calendar", "calendar"],
        ["Review the budget", "ads"],
      ],
    },
  ];
}

function initialState(init: { displayName: string | null; email: string | null; business: BusinessRecord | null }): VoomState {
  const brand = brandFromBusiness(init.business);
  const pack = PACKS[brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
  const displayName = init.displayName?.trim() ?? "";
  const firstName = displayName.split(" ")[0] ?? "";
  return {
    hydrated: false,
    displayName,
    email: init.email ?? "",
    theme: "dark",
    sideOpen: false,
    menuOpen: false,
    notif: 3,
    calMonth: 7,
    calYear: 2026,
    calFilter: "All",
    campTab: "email",
    reelTmpl: 0,
    reelTime: "19:10",
    reelCaption: "",
    igConnected: false,
    igStep: 0,
    plan: "free",
    brand,
    posts: buildPosts(pack),
    reelQueue: buildReelQueue(pack),
    campaignsTable: buildCampaignsTable(pack),
    emails: buildEmails(pack),
    sms: buildSms(),
    adAlloc: buildAdAlloc(pack),
    adTotal: 1200,
    adHistory: buildAdHistory(pack),
    approvedPlan: null,
    changeMode: false,
    insights: buildInsights(pack),
    defaultCap: pack.cap,
    chat: seedChatFor(firstName, brand.name, pack.slot, pack.slotWhy, pack.cold),
    typing: false,
    onboard: { ...emptyOnboard(), displayName },
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
  openNotifs: () => void;
  toast: (msg: string, kind?: Toast["kind"], proto?: boolean) => void;
  dismissToast: (id: number) => void;
  logout: () => void;

  calMove: (n: number) => void;
  calToday: () => void;
  setCalFilter: (f: string) => void;

  askMara: (q: string, gotoChat: () => void) => void;
  sendMsg: (text: string) => void;
  approveAllDrafts: () => void;
  clearChat: () => void;

  addPost: (post: Post) => void;
  deletePost: (index: number) => void;
  schedulePost: (index: number) => void;

  setCampTab: (t: "email" | "sms") => void;
  sendCampaign: (kind: "email" | "sms", index: number) => void;
  openNewCampaign: () => number;

  setReelTmpl: (i: number) => void;
  setReelTime: (t: string) => void;
  setReelCaption: (c: string) => void;
  maraRewriteCaption: () => void;
  scheduleReel: () => boolean;
  saveReelDraft: () => void;
  reelDelete: (i: number) => void;
  reelSchedule: (i: number) => void;
  reelChangeTime: (i: number) => void;
  bestTimeAll: () => void;

  igConnect: () => void;
  igDisconnect: () => void;
  igSetStep: (n: number) => void;

  setAdTotal: (v: number) => boolean;
  setAdAlloc: (i: number, v: number) => boolean;
  resetAlloc: () => boolean;
  normalizeAlloc: () => boolean;
  declineAds: () => void;
  requestChange: () => void;
  cancelChange: () => void;
  confirmAds: (isChange: boolean) => void;
  pauseAds: () => void;
  resumeAds: () => void;

  setPlan: (id: Plan["id"]) => void;
  upgrade: (id: Plan["id"]) => void;

  toggleTone: (t: string) => void;
  saveBrandSettings: (input: BusinessProfileInput) => Promise<boolean>;

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

  const after = useCallback((ms: number, fn: () => void) => {
    const id = setTimeout(fn, ms);
    timers.current.push(id);
  }, []);

  const toast = useCallback<VoomActions["toast"]>((msg, kind = "ok", proto = false) => {
    const id = ++toastId;
    setState((s) => ({ ...s, toasts: [...s.toasts, { id, msg, kind, proto }] }));
    after(proto ? 4600 : 3000, () => {
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

  const openNotifs = useCallback<VoomActions["openNotifs"]>(() => {
    setState((s) => ({ ...s, notif: 0 }));
  }, []);

  const logout = useCallback<VoomActions["logout"]>(() => {
    toast("Signed out", "info");
  }, [toast]);

  const calMove = useCallback<VoomActions["calMove"]>((n) => {
    setState((s) => {
      let m = s.calMonth + n;
      let y = s.calYear;
      if (m < 0) {
        m = 11;
        y--;
      }
      if (m > 11) {
        m = 0;
        y++;
      }
      return { ...s, calMonth: m, calYear: y };
    });
  }, []);

  const calToday = useCallback<VoomActions["calToday"]>(() => {
    setState((s) => ({ ...s, calMonth: 7, calYear: 2026 }));
  }, []);

  const setCalFilter = useCallback<VoomActions["setCalFilter"]>((f) => {
    setState((s) => ({ ...s, calFilter: f }));
  }, []);

  const maraReply = useCallback((q: string, s: VoomState): ChatMessage => {
    const t = q.toLowerCase();
    const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
    const A = (h: string, acts?: [string, string][]): ChatMessage => ({ r: "mara", h, acts });
    if (/budget|ad|spend|paid|roas/.test(t))
      return A(
        `I've drafted <b>AED 1,200</b> across four campaigns for the next 14 days:
         <ul>${s.adAlloc.map((a) => `<li>${a.pct}% — ${a.n}</li>`).join("")}</ul>
         That's an <b>example projection</b> on demo data, not a promise. Nothing spends until you approve it —
         and ad money is charged by your own ad account, never by your Voom subscription.`,
        [
          ["Review & approve", "ads"],
          ["Lower to AED 800", "ads"],
        ],
      );
    if (/reel|hook|video|tiktok/.test(t))
      return A(
        `Here are three hooks in your voice — warm, a little cheeky, expert underneath:
         <ul>${pack.hooks.map((h) => `<li>${h}</li>`).join("")}</ul>
         Hook #1 lines up with ${pack.trend}, up 62% in this demo dataset.
         Want me to build the Reel and queue it for ${pack.slot}?`,
        [
          ["Build Reel #1", "reels"],
          ["See the calendar", "calendar"],
        ],
      );
    if (/week|plan|calendar|schedule/.test(t))
      return A(
        `Next week is drafted — <b>7 pieces</b>, weighted toward Reels since that's where your growth is:
         <ul><li><b>Mon</b> — Reel: ${pack.r[0]} · ${pack.slot}</li><li><b>Tue</b> — Email: ${pack.emailN} · 9:00 AM</li>
         <li><b>Wed</b> — Feed: ${pack.p[2]}</li><li><b>Thu</b> — Reel: ${pack.r[1]}</li>
         <li><b>Fri</b> — SMS: reminder message · 11:00 AM</li><li><b>Sat</b> — Reel: ${pack.r[2]}</li>
         <li><b>Sun</b> — Rest day (quietest day in this demo dataset)</li></ul>`,
        [
          ["Open calendar", "calendar"],
          ["Approve all drafts", "__approveAllDrafts"],
        ],
      );
    if (/email|win-?back|newsletter|flow/.test(t))
      return A(
        `<b>1,284</b> ${pack.cold}. I drafted a two-step win-back:<br><br>
         <b>Email 1</b> — "Did we lose you?" · soft re-intro, no discount<br>
         <b>Email 2</b> (4 days later) — "15% to come back" · expires in 48h<br><br>
         On this demo list that models out to roughly <b>AED 3,100</b> recovered — an example result, not a forecast.`,
        [
          ["Open campaigns", "campaigns"],
          ["Draft email 1 now", "campaigns"],
        ],
      );
    if (/sms|text|message/.test(t))
      return A(
        `In this demo dataset SMS is your strongest channel — <b>98.1% open</b>, 11.4% click.
         I'd send one broadcast on a genuinely useful day only. Over-texting is the fastest way to lose that list.`,
        [["Open SMS", "campaigns"]],
      );
    if (/time|when.*post|best time/.test(t))
      return A(
        `In this demo dataset your audience peaks <b>Tue–Thu evening, Gulf time</b> — ${pack.slotWhy}.
         Reels in that window averaged <b>41K views</b> against 12K outside it (example result).
         I've pinned <b>${pack.slot}</b> as your default slot.`,
        [["See Reel queue", "reels"]],
      );
    if (/reach|drop|down|why/.test(t))
      return A(
        `In this demo dataset reach is <b>up 18.4%</b> — revenue is what dipped 3.2%. Two causes:
         <ul><li>Paid retargeting paused on Aug 9 (biggest factor)</li>
         <li>Two Reels posted in the morning instead of the evening slot</li></ul>
         Approving the ad budget addresses the first; I've already moved the queue for the second.`,
        [
          ["Approve budget", "ads"],
          ["Check the queue", "reels"],
        ],
      );
    if (/instagram|connect/.test(t))
      return A(
        s.igConnected
          ? `Instagram is connected as <b>${s.brand.handle || "your account"}</b> in this prototype. In the real product I'd pull insights hourly and publish Reels directly.`
          : `I can't publish yet — Instagram isn't connected. It takes about 20 seconds and I'll need permission to publish and read insights.`,
        [[s.igConnected ? "View connection" : "Connect Instagram", "instagram"]],
      );
    if (/price|plan|upgrade|cost/.test(t)) {
      const planObj = { free: { name: "Free", m: 0 }, pro: { name: "Pro", m: 199 }, max: { name: "Max", m: 549 } }[s.plan];
      return A(
        `You're on <b>${planObj.name}</b> — AED ${planObj.m}/month.
         Paid ad management and unlimited scheduling live on <b>Max</b>. Remember the subscription only pays for the
         software; any advertising budget is paid through your own ad account.`,
        [["Compare plans", "pricing"]],
      );
    }
    return A(
      `Got it. Based on this demo dataset for <b>${s.brand.name || "your business"}</b>, the highest-leverage move
       is your <b>${pack.slot}</b> Reel slot — it outperforms every other time in the sample.
       Want me to build next week around it?`,
      [
        ["Yes, plan the week", "__ask:Plan next week"],
        ["Show performance", "dash"],
      ],
    );
  }, []);

  const sendMsg = useCallback<VoomActions["sendMsg"]>(
    (text) => {
      const v = text.trim();
      if (!v) return;
      setState((s) => ({ ...s, chat: [...s.chat, { r: "me", h: escapeHtml(v) }], typing: true }));
      after(900 + Math.random() * 700, () => {
        setState((s) => ({ ...s, typing: false, chat: [...s.chat, maraReply(v, s)] }));
      });
    },
    [after, maraReply],
  );

  const askMara = useCallback<VoomActions["askMara"]>(
    (q, gotoChat) => {
      gotoChat();
      after(60, () => sendMsg(q));
    },
    [after, sendMsg],
  );

  const approveAllDrafts = useCallback<VoomActions["approveAllDrafts"]>(() => {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p) => (p.st !== "Scheduled" ? { ...p, st: "Scheduled" } : p)),
      reelQueue: s.reelQueue.map((r) => (r.st === "Draft" ? { ...r, st: "Scheduled", t2: "t-green" } : r)),
      chat: [
        ...s.chat,
        { r: "mara" as const, h: "Done — everything is scheduled. I'll publish on your behalf and report back each morning." },
      ],
    }));
    toast("All drafts approved and scheduled", "ok", true);
  }, [toast]);

  const clearChat = useCallback<VoomActions["clearChat"]>(() => {
    setState((s) => {
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      const firstName = s.displayName.split(" ")[0] ?? "";
      return { ...s, chat: seedChatFor(firstName, s.brand.name, pack.slot, pack.slotWhy, pack.cold) };
    });
    toast("Conversation cleared", "info");
  }, [toast]);

  const addPost = useCallback<VoomActions["addPost"]>((post) => {
    setState((s) => ({ ...s, posts: [...s.posts, post] }));
  }, []);

  const deletePost = useCallback<VoomActions["deletePost"]>((index) => {
    setState((s) => ({ ...s, posts: s.posts.filter((_, i) => i !== index) }));
    toast("Post deleted", "info");
  }, [toast]);

  const schedulePost = useCallback<VoomActions["schedulePost"]>((index) => {
    setState((s) => ({
      ...s,
      posts: s.posts.map((p, i) => (i === index ? { ...p, st: "Scheduled" } : p)),
    }));
  }, []);

  const setCampTab = useCallback<VoomActions["setCampTab"]>((t) => {
    setState((s) => ({ ...s, campTab: t }));
  }, []);

  const sendCampaign = useCallback<VoomActions["sendCampaign"]>((kind, index) => {
    setState((s) => {
      const key = kind === "email" ? "emails" : "sms";
      const list = s[key].slice();
      const c = { ...list[index] };
      c.st = "Sent";
      c.t = "t-blue";
      c.when = "Just now";
      c.o = kind === "email" ? "38.9%" : "97.4%";
      c.c = kind === "email" ? "5.9%" : "10.2%";
      c.r = kind === "email" ? "AED 2,940" : "AED 2,180";
      list[index] = c;
      return { ...s, [key]: list };
    });
    toast(`${kind === "email" ? "Email" : "SMS"} simulated — sample results added`, "ok", true);
  }, [toast]);

  const openNewCampaign = useCallback<VoomActions["openNewCampaign"]>(() => {
    let idx = 0;
    setState((s) => {
      const em = s.campTab === "email";
      const draft: EmailOrSms = {
        n: em ? "Untitled email" : "Untitled SMS",
        seg: em ? "All subscribers · 8,412" : "SMS opt-ins · 3,190",
        st: "Draft",
        t: "t-grey",
        o: "—",
        c: "—",
        r: "—",
        when: "Not scheduled",
      };
      const key = em ? "emails" : "sms";
      idx = 0;
      return { ...s, [key]: [draft, ...s[key]] };
    });
    return idx;
  }, []);

  const setReelTmpl = useCallback<VoomActions["setReelTmpl"]>((i) => {
    setState((s) => ({ ...s, reelTmpl: i }));
  }, []);
  const setReelTime = useCallback<VoomActions["setReelTime"]>((t) => {
    setState((s) => ({ ...s, reelTime: t }));
  }, []);
  const setReelCaption = useCallback<VoomActions["setReelCaption"]>((c) => {
    setState((s) => ({ ...s, reelCaption: c }));
  }, []);

  const maraRewriteCaption = useCallback<VoomActions["maraRewriteCaption"]>(() => {
    setState((s) => {
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      return { ...s, reelCaption: pack.cap + "\n\n#dubai #smallbusiness " + s.brand.handle.replace("@", "#") };
    });
    toast("MARA rewrote your caption in brand voice");
  }, [toast]);

  const scheduleReel = useCallback<VoomActions["scheduleReel"]>(() => {
    let ok = true;
    setState((s) => {
      if (!s.igConnected) {
        ok = false;
        return s;
      }
      const cap = s.reelCaption || s.defaultCap;
      const item: ReelQueueItem = {
        t: cap.split("\n")[0].slice(0, 38),
        when: `Tue, Aug 25 · ${fmtTime(s.reelTime)}`,
        st: "Scheduled",
        t2: "t-green",
        g: TMPLS[s.reelTmpl].g,
        views: "—",
      };
      const post: Post = { d: 25, t: "Reel · " + TMPLS[s.reelTmpl].n, c: "#e8481f", ch: "Reel", time: fmtTime(s.reelTime), st: "Scheduled" };
      return { ...s, reelQueue: [item, ...s.reelQueue], posts: [...s.posts, post] };
    });
    if (ok) toast("Reel scheduled for Aug 25", "ok", true);
    return ok;
  }, [toast]);

  const saveReelDraft = useCallback<VoomActions["saveReelDraft"]>(() => {
    setState((s) => {
      const cap = s.reelCaption || s.defaultCap;
      const item: ReelQueueItem = {
        t: cap.split("\n")[0].slice(0, 38),
        when: "Not scheduled",
        st: "Draft",
        t2: "t-amber",
        g: TMPLS[s.reelTmpl].g,
        views: "—",
      };
      return { ...s, reelQueue: [item, ...s.reelQueue] };
    });
    toast("Saved as draft", "info");
  }, [toast]);

  const reelDelete = useCallback<VoomActions["reelDelete"]>((i) => {
    setState((s) => ({ ...s, reelQueue: s.reelQueue.filter((_, idx) => idx !== i) }));
    toast("Removed from queue", "info");
  }, [toast]);

  const reelSchedule = useCallback<VoomActions["reelSchedule"]>((i) => {
    setState((s) => {
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      const q = s.reelQueue.slice();
      q[i] = { ...q[i], st: "Scheduled", t2: "t-green", when: "Fri, Aug 28 · " + pack.slot };
      return { ...s, reelQueue: q };
    });
    toast("Reel scheduled", "ok", true);
  }, [toast]);

  const reelChangeTime = useCallback<VoomActions["reelChangeTime"]>((i) => {
    setState((s) => {
      const q = s.reelQueue.slice();
      q[i] = { ...q[i], when: q[i].when.replace(/· .*/, "· 7:10 PM") };
      return { ...s, reelQueue: q };
    });
    toast("Moved to your best slot — 7:10 PM");
  }, [toast]);

  const bestTimeAll = useCallback<VoomActions["bestTimeAll"]>(() => {
    setState((s) => {
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      return {
        ...s,
        reelQueue: s.reelQueue.map((r) => (r.st !== "Live" ? { ...r, when: r.when.replace(/· .*/, "· " + pack.slot) } : r)),
      };
    });
    toast("Whole queue moved to best slot", "ok", true);
  }, [toast]);

  const igConnect = useCallback<VoomActions["igConnect"]>(() => {
    setState((s) => ({ ...s, igConnected: true, igStep: 0 }));
    toast("Instagram connected — demo account", "ok", true);
  }, [toast]);

  const igDisconnect = useCallback<VoomActions["igDisconnect"]>(() => {
    setState((s) => ({ ...s, igConnected: false }));
    toast("Instagram disconnected", "info");
  }, [toast]);

  const igSetStep = useCallback<VoomActions["igSetStep"]>((n) => {
    setState((s) => ({ ...s, igStep: n }));
  }, []);

  const adGuard = useCallback((s: VoomState) => {
    if (!s.approvedPlan || s.changeMode) return true;
    toast('Budget is locked by your approval — use "Request budget change"', "err");
    return false;
  }, [toast]);

  const setAdTotal = useCallback<VoomActions["setAdTotal"]>((v) => {
    let ok = true;
    setState((s) => {
      if (!adGuard(s)) {
        ok = false;
        return s;
      }
      return { ...s, adTotal: v };
    });
    return ok;
  }, [adGuard]);

  const setAdAlloc = useCallback<VoomActions["setAdAlloc"]>((i, v) => {
    let ok = true;
    setState((s) => {
      if (!adGuard(s)) {
        ok = false;
        return s;
      }
      const a = s.adAlloc.slice();
      a[i] = { ...a[i], pct: v };
      return { ...s, adAlloc: a };
    });
    return ok;
  }, [adGuard]);

  const resetAlloc = useCallback<VoomActions["resetAlloc"]>(() => {
    let ok = true;
    setState((s) => {
      if (!adGuard(s)) {
        ok = false;
        return s;
      }
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      return { ...s, adAlloc: buildAdAlloc(pack) };
    });
    if (ok) toast("Reset to MARA's recommendation", "info");
    return ok;
  }, [adGuard, toast]);

  const normalizeAlloc = useCallback<VoomActions["normalizeAlloc"]>(() => {
    let ok = true;
    setState((s) => {
      if (!adGuard(s)) {
        ok = false;
        return s;
      }
      const sum = s.adAlloc.reduce((a, b) => a + b.pct, 0) || 1;
      const a = s.adAlloc.map((x) => ({ ...x, pct: Math.round((x.pct / sum) * 100) }));
      const d = 100 - a.reduce((acc, x) => acc + x.pct, 0);
      a[0] = { ...a[0], pct: a[0].pct + d };
      return { ...s, adAlloc: a };
    });
    if (ok) toast("Balanced to 100%");
    return ok;
  }, [adGuard, toast]);

  const declineAds = useCallback<VoomActions["declineAds"]>(() => {
    setState((s) => {
      if (s.approvedPlan) return s;
      const pack = PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
      return {
        ...s,
        adTotal: 600,
        adAlloc: [
          { n: pack.ad[1], ch: "Meta Advantage+", pct: 70, c: "#0f6f68", roas: "5.1×" },
          { n: pack.ad[0], ch: "Instagram Reels", pct: 30, c: "#e8481f", roas: "4.2×" },
        ],
        chat: [
          ...s.chat,
          {
            r: "mara" as const,
            h: `Understood — I've dropped the proposal to <b>AED 600</b> and shifted it into
            ${pack.ad[1].toLowerCase()}, the highest-ROAS line in this demo dataset. Still nothing spends until you approve it.`,
            acts: [["Review new budget", "ads"]] as [string, string][],
          },
        ],
      };
    });
    toast("Budget declined — MARA is rebuilding the plan", "info");
  }, [toast]);

  const requestChange = useCallback<VoomActions["requestChange"]>(() => {
    setState((s) => {
      if (!s.approvedPlan) return s;
      return { ...s, changeMode: true, adTotal: s.approvedPlan.limit, adAlloc: s.approvedPlan.alloc.map((a) => ({ ...a })) };
    });
    toast("Change request opened — nothing extra is spent until you approve it", "info");
  }, [toast]);

  const cancelChange = useCallback<VoomActions["cancelChange"]>(() => {
    setState((s) => {
      if (!s.approvedPlan) return s;
      return { ...s, changeMode: false, adTotal: s.approvedPlan.limit, adAlloc: s.approvedPlan.alloc.map((a) => ({ ...a })) };
    });
    toast("Change cancelled — your approved limit is unchanged", "info");
  }, [toast]);

  const confirmAds = useCallback<VoomActions["confirmAds"]>(
    (isChange) => {
      setState((s) => {
        const proj = s.adAlloc.reduce((a, b) => a + (s.adTotal * b.pct) / 100 * parseFloat(b.roas), 0);
        const roas = (proj / s.adTotal).toFixed(1);
        if (isChange && s.approvedPlan) {
          const prev = s.approvedPlan.limit;
          const newPlan: ApprovedPlan = { ...s.approvedPlan, limit: s.adTotal, alloc: s.adAlloc.map((a) => ({ ...a })) };
          return {
            ...s,
            approvedPlan: newPlan,
            changeMode: false,
            adHistory: [
              { n: "Budget change — approved", amt: "AED " + s.adTotal.toLocaleString("en-US"), st: "Active", t: "t-green", roas: roas + "×", when: "Changed just now" },
              ...s.adHistory,
            ],
            chat: [
              ...s.chat,
              {
                r: "mara" as const,
                h: `New limit approved — <b>AED ${s.adTotal.toLocaleString("en-US")}</b> (was AED ${prev.toLocaleString("en-US")}).
                I'll stay inside it and ask you again before any further increase.`,
                acts: [["See live spend", "ads"]] as [string, string][],
              },
            ],
          };
        }
        const newPlan: ApprovedPlan = {
          limit: s.adTotal,
          alloc: s.adAlloc.map((a) => ({ ...a })),
          spent: Math.round(s.adTotal * 0.34),
          start: "24 Aug 2026",
          end: "7 Sep 2026",
          paused: false,
        };
        return {
          ...s,
          approvedPlan: newPlan,
          changeMode: false,
          adHistory: [
            { n: "Sept sprint — MARA plan", amt: "AED " + s.adTotal.toLocaleString("en-US"), st: "Active", t: "t-green", roas: roas + "×", when: "Approved just now" },
            ...s.adHistory,
          ],
          chat: [
            ...s.chat,
            {
              r: "mara" as const,
              h: `Budget approved — <b>AED ${s.adTotal.toLocaleString("en-US")}</b> is live across ${s.adAlloc.length} campaigns.
              That limit is now fixed: I'll optimise and pause inside it, and I'll ask you again before spending a dirham more.`,
              acts: [["See live spend", "ads"]] as [string, string][],
            },
          ],
        };
      });
      toast(isChange ? "New limit approved" : "Budget approved — campaigns launching (simulated)", "ok", true);
    },
    [toast],
  );

  const pauseAds = useCallback<VoomActions["pauseAds"]>(() => {
    setState((s) => (s.approvedPlan ? { ...s, approvedPlan: { ...s.approvedPlan, paused: true } } : s));
    toast("All paid spend paused", "info", true);
  }, [toast]);

  const resumeAds = useCallback<VoomActions["resumeAds"]>(() => {
    setState((s) => (s.approvedPlan ? { ...s, approvedPlan: { ...s.approvedPlan, paused: false } } : s));
    toast("Spend resumed inside your approved limit", "info", true);
  }, [toast]);

  const setPlan = useCallback<VoomActions["setPlan"]>((id) => {
    setState((s) => ({ ...s, plan: id }));
  }, []);

  const upgrade = useCallback<VoomActions["upgrade"]>(
    (id) => {
      setState((s) => ({ ...s, plan: id }));
      toast(`Upgraded — simulated`, "ok", true);
    },
    [toast],
  );

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
      setState((s) => {
        const pack = PACKS[input.industry] ?? PACKS[FALLBACK_INDUSTRY];
        const brand: Brand = {
          name: input.brandName.trim(),
          handle: deriveHandle(input.brandName.trim()),
          industry: input.industry,
          audience: input.targetCustomer,
          goals: input.mainGoal ? [input.mainGoal] : [],
          tone: input.brandPersonality,
          channels: input.preferredChannels,
          budget: input.monthlyAdBudget,
          freq: input.contentFrequency,
          auto: input.automationLevel,
          permission: input.publishingPermission,
          color: s.brand.color,
        };
        return {
          ...s,
          settingsSaving: false,
          settingsError: null,
          displayName: input.displayName.trim(),
          brand,
          posts: buildPosts(pack),
          reelQueue: buildReelQueue(pack),
          campaignsTable: buildCampaignsTable(pack),
          emails: buildEmails(pack),
          sms: buildSms(),
          adAlloc: buildAdAlloc(pack),
          adHistory: buildAdHistory(pack),
          insights: buildInsights(pack),
          defaultCap: pack.cap,
        };
      });
      toast("Brand profile saved", "ok");
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

      const payload: BusinessProfileInput = {
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
      };

      const result = await saveOnboardingAction(payload);
      if (!result.ok) {
        setState((s) => ({ ...s, onboardSaving: false, onboardError: result.error }));
        return false;
      }

      setState((s) => {
        const industry = payload.industry;
        const pack = PACKS[industry] ?? PACKS[FALLBACK_INDUSTRY];
        const displayName = payload.displayName.trim();
        const firstName = displayName.split(" ")[0] ?? "";
        const brand: Brand = skipped
          ? s.brand
          : {
              name: payload.brandName.trim(),
              handle: deriveHandle(payload.brandName.trim()),
              industry,
              audience: payload.targetCustomer,
              goals: payload.mainGoal ? [payload.mainGoal] : [],
              tone: payload.brandPersonality,
              channels: payload.preferredChannels,
              budget: payload.monthlyAdBudget,
              freq: payload.contentFrequency,
              auto: payload.automationLevel,
              permission: payload.publishingPermission,
              color: o.color,
            };
        return {
          ...s,
          onboardSaving: false,
          onboardError: null,
          displayName,
          brand,
          posts: buildPosts(pack),
          reelQueue: buildReelQueue(pack),
          campaignsTable: buildCampaignsTable(pack),
          emails: buildEmails(pack),
          sms: buildSms(),
          adAlloc: buildAdAlloc(pack),
          adHistory: buildAdHistory(pack),
          insights: buildInsights(pack),
          defaultCap: pack.cap,
          chat: seedChatFor(firstName, brand.name, pack.slot, pack.slotWhy, pack.cold),
        };
      });
      return true;
    },
    [state.onboard],
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
      openNotifs,
      toast,
      dismissToast,
      logout,
      calMove,
      calToday,
      setCalFilter,
      askMara,
      sendMsg,
      approveAllDrafts,
      clearChat,
      addPost,
      deletePost,
      schedulePost,
      setCampTab,
      sendCampaign,
      openNewCampaign,
      setReelTmpl,
      setReelTime,
      setReelCaption,
      maraRewriteCaption,
      scheduleReel,
      saveReelDraft,
      reelDelete,
      reelSchedule,
      reelChangeTime,
      bestTimeAll,
      igConnect,
      igDisconnect,
      igSetStep,
      setAdTotal,
      setAdAlloc,
      resetAlloc,
      normalizeAlloc,
      declineAds,
      requestChange,
      cancelChange,
      confirmAds,
      pauseAds,
      resumeAds,
      setPlan,
      upgrade,
      toggleTone,
      saveBrandSettings,
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
      openNotifs,
      toast,
      dismissToast,
      logout,
      calMove,
      calToday,
      setCalFilter,
      askMara,
      sendMsg,
      approveAllDrafts,
      clearChat,
      addPost,
      deletePost,
      schedulePost,
      setCampTab,
      sendCampaign,
      openNewCampaign,
      setReelTmpl,
      setReelTime,
      setReelCaption,
      maraRewriteCaption,
      scheduleReel,
      saveReelDraft,
      reelDelete,
      reelSchedule,
      reelChangeTime,
      bestTimeAll,
      igConnect,
      igDisconnect,
      igSetStep,
      setAdTotal,
      setAdAlloc,
      resetAlloc,
      normalizeAlloc,
      declineAds,
      requestChange,
      cancelChange,
      confirmAds,
      pauseAds,
      resumeAds,
      setPlan,
      upgrade,
      toggleTone,
      saveBrandSettings,
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

export function useVoomState() {
  const ctx = useContext(StateCtx);
  if (!ctx) throw new Error("useVoomState must be used inside VoomProvider");
  return ctx;
}

export function useVoomActions() {
  const ctx = useContext(ActionsCtx);
  if (!ctx) throw new Error("useVoomActions must be used inside VoomProvider");
  return ctx;
}

export function useCurrentPack() {
  const s = useVoomState();
  return PACKS[s.brand.industry] ?? PACKS[FALLBACK_INDUSTRY];
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] as string);
}

export function getInitials(displayName: string, email: string): string {
  const name = displayName.trim();
  if (name) {
    const parts = name.split(/\s+/).filter(Boolean);
    const initials = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : parts[0].slice(0, 2);
    return initials.toUpperCase();
  }
  const emailName = email.trim().split("@")[0];
  if (emailName) return emailName.slice(0, 2).toUpperCase();
  return "?";
}

export { KPIS, SERIES, CHANNEL_SHARE };
