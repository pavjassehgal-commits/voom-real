export interface NavItem {
  id: string;
  n: string;
  i: string;
  badge?: string;
}

export interface NavGroup {
  g: string;
  items: NavItem[];
}

/**
 * Application shell navigation — redesign Batch 1 (Figma "15 — Today").
 *
 * Workspace: Today, Create, Calendar, Performance
 * Automation: Marketing Plan, Approvals, Automations
 * Manage: Channels (the existing Connections hub), Campaigns, Contacts
 * System: Settings
 *
 * The reference also shows "Content" and "MARA" entries. Neither has a real
 * screen yet (/app/mara only redirects to Today and the MARA chat API is
 * retired), so they are deliberately NOT listed: no nav item may lead to a
 * dead or placeholder destination. They return when their screens ship.
 * Every existing route keeps resolving; nothing is orphaned.
 */
export const NAV: NavGroup[] = [
  {
    g: "Workspace",
    items: [
      { id: "today", n: "Today", i: "home" },
      { id: "studio", n: "Create", i: "pencil" },
      { id: "calendar", n: "Calendar", i: "cal" },
      { id: "performance", n: "Performance", i: "bars" },
    ],
  },
  {
    g: "Automation",
    items: [
      { id: "plan", n: "Marketing Plan", i: "map" },
      { id: "approvals", n: "Approvals", i: "checkCircle" },
      { id: "automations", n: "Automations", i: "bolt" },
    ],
  },
  {
    g: "Manage",
    items: [
      { id: "connections", n: "Channels", i: "share" },
      { id: "campaigns", n: "Campaigns", i: "folder" },
      { id: "contacts", n: "Contacts", i: "user" },
    ],
  },
  {
    g: "System",
    items: [
      { id: "settings", n: "Settings", i: "cog" },
    ],
  },
];

export const TITLES: Record<string, string> = {
  today: "Today",
  plan: "Marketing Plan",
  studio: "Create",
  create: "Create",
  calendar: "Calendar",
  performance: "Performance",
  campaigns: "Campaigns",
  contacts: "Contacts",
  connections: "Channels",
  approvals: "Approvals",
  automations: "Automations",
  settings: "Settings",
  // Legacy routes that still resolve — kept for safe access, not in primary nav
  ads: "Paid Advertising",
  reels: "Create",
  instagram: "Instagram",
  tiktok: "TikTok",
  youtube: "YouTube",
  mara: "MARA",
  pricing: "Plans & Billing",
};

export function pageIdFromPath(pathname: string): string {
  if (pathname === "/app" || pathname === "/app/") return "today";
  const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
  // Normalize legacy aliases
  if (seg === "ads") return "ads";
  if (seg === "reels") return "studio";
  if (seg === "create") return "studio";
  return seg || "today";
}

/**
 * How legacy routes remain reachable (documented for PR):
 *
 * - /app/approvals — via System > Approvals in sidebar, direct URL, and
 *   search results (workflow items)
 * - /app/automations — via System > Automations in sidebar, direct URL
 * - /app/ads — via direct URL, no nav entry (truthful empty state, no fake numbers)
 * - /app/reels — redirects to /app/studio (real Create Content studio)
 * - /app/instagram, /app/tiktok, /app/youtube — via /app/connections hub,
 *   direct URLs, and settings/connections flows
 * - /app/mara — redirects to /app/today (MARA is ambient, not chatbot)
 * - /app/pricing — via account menu (Plans & billing) and settings
 *
 * No route is silently orphaned; all existing functionality remains
 * accessible through either primary/secondary navigation, system group,
 * connections hub, account menu, or direct URL.
 */
