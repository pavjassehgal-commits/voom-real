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
    g: "Workspace",
    items: [
      { id: "dash", n: "Dashboard", i: "home" },
      { id: "mara", n: "MARA", i: "spark", badge: "AI" },
    ],
  },
  {
    g: "Content",
    items: [
      { id: "calendar", n: "Content calendar", i: "cal" },
      { id: "reels", n: "Reel scheduling", i: "film" },
      { id: "campaigns", n: "Email & SMS", i: "mail" },
    ],
  },
  {
    g: "Growth",
    items: [
      { id: "ads", n: "Paid advertising", i: "target" },
      { id: "instagram", n: "Instagram", i: "ig" },
    ],
  },
  {
    g: "Account",
    items: [
      { id: "pricing", n: "Plans & billing", i: "card" },
      { id: "settings", n: "Settings", i: "cog" },
    ],
  },
];

export const TITLES: Record<string, string> = {
  dash: "Dashboard",
  mara: "MARA",
  calendar: "Content calendar",
  reels: "Reel scheduling",
  campaigns: "Email & SMS",
  ads: "Paid advertising",
  instagram: "Instagram",
  pricing: "Plans & billing",
  settings: "Settings",
};

export function pageIdFromPath(pathname: string): string {
  if (pathname === "/app" || pathname === "/app/") return "dash";
  const seg = pathname.replace(/^\/app\/?/, "").split("/")[0];
  return seg || "dash";
}
