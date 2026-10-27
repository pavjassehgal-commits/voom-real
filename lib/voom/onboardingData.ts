import { SOCIAL_CHANNELS, SOCIAL_CHANNEL_LABELS } from "@/lib/social/channels";

export const Q_INDUSTRY: [string, string][] = [
  ["🍽️", "Restaurant / Café"],
  ["💇", "Salon / Spa"],
  ["🏋️", "Gym / Fitness studio"],
  ["👗", "Clothing / Fashion"],
  ["🏠", "Real estate"],
  ["🛍️", "Online store"],
  ["🩺", "Clinic / Healthcare"],
  ["💼", "Professional services"],
  ["✨", "Other"],
];

export const Q_CUSTOMER = [
  "Local residents nearby",
  "Young adults (18–29)",
  "Families with children",
  "Professionals (30–50)",
  "Tourists & visitors",
  "Businesses (B2B)",
  "Luxury / high-income",
  "Budget-conscious shoppers",
];

export const Q_GOAL: [string, string][] = [
  ["🚶", "More walk-in customers"],
  ["🛒", "More online sales"],
  ["📅", "More bookings & appointments"],
  ["📩", "More enquiries & leads"],
  ["📈", "Grow followers & awareness"],
  ["🚀", "Launch something new"],
];

export const OB_TONE = ["Friendly", "Premium", "Playful", "Professional", "Bold", "Calm", "Traditional", "Modern"];

/**
 * The channels onboarding may offer: exactly the channels Voom genuinely
 * supports in V1, derived from the ONE canonical channel vocabulary
 * (lib/social/channels.ts) so this list can never drift from the product.
 * Historical `businesses.preferred_channels` values outside this list are
 * preserved as stored — Settings round-trips them verbatim and nothing
 * rewrites them.
 */
export const Q_CHANNELS: string[] = SOCIAL_CHANNELS.map((channel) => SOCIAL_CHANNEL_LABELS[channel]);

/**
 * The channels the onboarding wizard offers (Brand Kit v2): the two the new
 * flow leads with, plus LinkedIn shown as "coming soon" and not selectable.
 * Deliberately separate from `Q_CHANNELS` (the full supported list Settings
 * and the Brand Hub use) so an existing account keeps YouTube and Email.
 */
export const ONBOARDING_CHANNELS: { label: string; available: boolean }[] = [
  { label: SOCIAL_CHANNEL_LABELS.instagram, available: true },
  { label: SOCIAL_CHANNEL_LABELS.tiktok, available: true },
  { label: "LinkedIn", available: false },
];

export const Q_FREQ = ["A few times a month", "2–3 times a week", "Daily", "Multiple times a day"];
/** Preselected on the pace screen so Skip is safe; matches the planner's default cadence. */
export const DEFAULT_FREQ = "2–3 times a week";

/**
 * The three REAL automation modes (`businesses.automation_level`), each with
 * the plan it needs. The old four title-text cards saved their title into the
 * column, which every reader then treated as Assisted; the wizard now saves
 * `value` (DECISIONS 2026-10-22).
 */
export const AUTOMATION_CHOICES: { value: "manual" | "assisted" | "autopilot"; emoji: string; title: string; sub: string; plan: string }[] = [
  { value: "manual", emoji: "🙋", title: "Manual", sub: "MARA helps only when you ask. Nothing runs on a schedule.", plan: "Free plan" },
  { value: "assisted", emoji: "✍️", title: "Assisted", sub: "MARA plans and drafts on schedule; you approve before anything goes out.", plan: "Pro plan" },
  { value: "autopilot", emoji: "🤖", title: "Autopilot", sub: "MARA runs your marketing end-to-end, inside your limits and brand rules.", plan: "Max plan" },
];

export const OB_STEPS = [
  "Your name",
  "Logo & photos",
  "Your brand",
  "The basics",
  "Audience & goal",
  "Your voice",
  "What to avoid",
  "Pace",
  "Working style",
  "Brand Brief",
  "Your channels",
];
