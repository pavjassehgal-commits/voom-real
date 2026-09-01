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
      { id: "calendar", n: "Content Calendar", i: "cal" },
      { id: "reels", n: "Content Studio", i: "film" },
      { id: "campaigns", n: "Campaigns", i: "mail" },
    ],
  },
  {
    g: "Grow",
    items: [
      { id: "ads", n: "Paid Advertising", i: "target" },
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
  approvals: "Approvals",
  plan: "Marketing Plan",
  calendar: "Content Calendar",
  reels: "Content Studio",
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
