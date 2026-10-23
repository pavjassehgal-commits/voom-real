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
 * Content is the Batch 2 library (/app/content); MARA is the Batch 3 overview
 * (/app/mara) — a read-only view of MARA's work, not the retired chat.
 * No nav item may lead to a dead or placeholder destination.
 * Every existing route keeps resolving; nothing is orphaned.
 */
export const NAV: NavGroup[] = [
  {
    g: "Workspace",
    items: [
      { id: "today", n: "Today", i: "house" },
      { id: "studio", n: "Create", i: "pencil" },
      { id: "calendar", n: "Calendar", i: "cal" },
      { id: "content", n: "Content", i: "file" },
      { id: "performance", n: "Performance", i: "bars" },
    ],
  },
  {
    g: "Automation",
    items: [
      { id: "mara", n: "MARA", i: "sparkles" },
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
      { id: "contacts", n: "Contacts", i: "contacts" },
    ],
  },
  {
    g: "System",
    items: [
      { id: "settings", n: "Settings", i: "settings" },
    ],
  },
];

export const TITLES: Record<string, string> = {
  today: "Today",
  plan: "Marketing Plan",
  studio: "Create",
  create: "Create",
  calendar: "Calendar",
  content: "Content",
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
 * - /app/mara — MARA overview (read-only; the chat API stays retired)
 * - /app/pricing — via account menu (Plans & billing) and settings
 *
 * No route is silently orphaned; all existing functionality remains
 * accessible through either primary/secondary navigation, system group,
 * connections hub, account menu, or direct URL.
 */
