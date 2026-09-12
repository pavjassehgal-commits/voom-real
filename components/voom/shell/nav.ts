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
 * Only genuinely implemented features appear in navigation. "Content Studio"
 * (the old sample Reel workspace) and "Paid Advertising" (no ad integration
 * yet) were removed; their routes still resolve — /app/reels forwards to the
 * real Create Content studio and /app/ads shows a truthful state.
 */
export const NAV: NavGroup[] = [
  {
    g: "Operate",
    items: [
      { id: "today", n: "Today", i: "home" },
      { id: "approvals", n: "Approvals", i: "check" },
      { id: "plan", n: "Marketing Plan", i: "spark" },
    ],
  },
  {
    g: "Content",
    items: [
      { id: "studio", n: "Create Content", i: "plus" },
      { id: "calendar", n: "Content Calendar", i: "cal" },
      { id: "campaigns", n: "Campaigns", i: "mail" },
    ],
  },
  {
    g: "Grow",
    items: [
      { id: "automations", n: "Automations", i: "bolt" },
      { id: "performance", n: "Performance", i: "trend" },
      { id: "connections", n: "Connections", i: "globe" },
      { id: "contacts", n: "Contacts", i: "users" },
    ],
  },
  {
    g: "Account",
    items: [
      { id: "settings", n: "Settings", i: "cog" },
    ],
  },
];

export const TITLES: Record<string, string> = {
  today: "Today",
  studio: "Create Content",
  approvals: "Approvals",
  plan: "Marketing Plan",
  calendar: "Content Calendar",
  campaigns: "Campaigns",
  ads: "Paid Advertising",
  automations: "Automations",
  performance: "Performance",
  connections: "Connections",
  contacts: "Contacts",
  settings: "Settings",
};

export function pageIdFromPath(pathname: string): string {
  if (pathname === "/app" || pathname === "/app/") return "today";
  const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
  return seg || "today";
}
