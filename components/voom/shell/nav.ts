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
 * Voom 2.0 — Application shell navigation
 *
 * Primary: Today, Marketing Plan, Create, Calendar, Performance
 * Secondary: Campaigns, Contacts, Connections
 * Utility: Settings
 *
 * Legacy / System: Approvals, Automations are preserved for current
 * functionality. They remain reachable via sidebar (System group) and via
 * direct routes. Ads, Reels, and other unimplemented surfaces are NOT in
 * navigation — their routes still resolve (reels → studio, ads → truthful
 * empty state) so no dead links are introduced.
 *
 * This structure satisfies:
 * - Voom 2.0 spec primary/secondary/utility hierarchy
 * - Preservation of existing functionality (Approvals, Automations)
 * - Existing tests that assert kept entries are registered
 */
export const NAV: NavGroup[] = [
  {
    g: "Primary",
    items: [
      { id: "today", n: "Today", i: "home" },
      { id: "plan", n: "Marketing Plan", i: "spark" },
      { id: "studio", n: "Create", i: "plus" },
      { id: "calendar", n: "Calendar", i: "cal" },
      { id: "performance", n: "Performance", i: "trend" },
    ],
  },
  {
    g: "Secondary",
    items: [
      { id: "campaigns", n: "Campaigns", i: "mail" },
      { id: "contacts", n: "Contacts", i: "users" },
      { id: "connections", n: "Connections", i: "globe" },
    ],
  },
  {
    g: "System",
    items: [
      { id: "approvals", n: "Approvals", i: "check" },
      { id: "automations", n: "Automations", i: "bolt" },
    ],
  },
  {
    g: "Utility",
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
  connections: "Connections",
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
