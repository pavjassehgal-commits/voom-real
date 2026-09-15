/**
 * Static, user-facing reference data that is legitimately hardcoded:
 * the subscription plan catalogue and the lightweight industry detector used
 * by onboarding. Nothing here is presented as account data — all real content
 * comes from the server APIs.
 */

export interface Plan {
  id: "free" | "pro" | "max";
  name: string;
  m: number;
  y: number;
  blurb: string;
  hot: boolean;
  f: string[];
  off: string[];
}

/** "1200" -> "1,200". */
export function nfc(value: number): string {
  return value.toLocaleString("en-US");
}

export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    m: 0,
    y: 0,
    blurb: "Manual only. You control execution. MARA helps when you ask.",
    hot: false,
    f: [
      "Manual mode only — You control execution. MARA helps when you ask.",
      "Plan, draft and upload your own media",
      "No AI image/video generation (0 credits)",
      "No Autopilot",
      "Approvals & Content Calendar",
      "Instagram Posts, Reels & Stories (own assets)",
    ],
    off: ["AI generation with MARA", "Assisted mode", "Autopilot mode", "Automatic paid media"],
  },
  {
    id: "pro",
    name: "Pro",
    m: 29,
    y: 29,
    blurb: "Manual + Assisted. 150 AI media credits/month. You approve execution.",
    hot: true,
    f: [
      "Manual + Assisted — MARA prepares your marketing. You approve execution.",
      "150 AI media credits / month",
      "Generate image with MARA · 5 credits",
      "Generate video with MARA · 40 credits",
      "Credits are used only when Voom generates AI images or videos",
      "Explicit generation allowed (Create with MARA)",
      "No automatic paid media — deliberate safety",
      "Priority media generation",
    ],
    off: ["Autopilot mode", "Automatic paid media generation"],
  },
  {
    id: "max",
    name: "Max",
    m: 79,
    y: 79,
    blurb: "Manual + Assisted + Autopilot. 500 credits/month. MARA runs within your limits.",
    hot: false,
    f: [
      "Manual + Assisted + Autopilot — MARA runs your marketing within your limits.",
      "500 AI media credits / month",
      "Generate image with MARA · 5 credits",
      "Generate video with MARA · 40 credits",
      "Automatic paid media allowed ONLY if: Max plan + Autopilot mode + toggle ON + enough credits + safety allows",
      "Planning continues when media is blocked — never silent failure",
      "Deeper performance reporting",
    ],
    off: [],
  },
];

const INDUSTRY_RULES: [RegExp, string][] = [
  [/restaurant|caf[eé]|coffee|bakery|food|kitchen|dine|dining|menu|pizza|shawarma|brunch/i, "Restaurant / Café"],
  [/salon|spa|hair|nails|barber|lash|brow|beauty|grooming/i, "Salon / Spa"],
  [/gym|fitness|yoga|pilates|crossfit|padel|personal train|studio class/i, "Gym / Fitness studio"],
  [/cloth|fashion|boutique|abaya|apparel|wear|shoes|jewel/i, "Clothing / Fashion"],
  [/real estate|property|properties|villa|apartment|broker|listing|landlord/i, "Real estate"],
  [/online store|e-?commerce|shopify|web ?shop|ship orders|deliver orders/i, "Online store"],
  [/clinic|dental|dentist|doctor|medical|physio|aesthetic|therap/i, "Clinic / Healthcare"],
  [/consult|agency|law|legal|account|bookkeep|tutor|repair|cleaning|service business/i, "Professional services"],
];

/**
 * Lightweight keyword detection from the brand description the owner wrote,
 * used only to pre-select the industry picker during onboarding. The owner
 * always confirms or changes it — no data is inferred silently.
 */
export function detectIndustry(text: string): string {
  for (const [re, name] of INDUSTRY_RULES) {
    if (re.test(text)) return name;
  }
  return "";
}
