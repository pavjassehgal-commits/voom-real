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

export const Q_BUDGET = ["AED 0 — organic only", "Under AED 1,000", "AED 1,000 – 3,000", "AED 3,000 – 10,000", "AED 10,000+"];

export const Q_FREQ = ["A few times a month", "2–3 times a week", "Daily", "Multiple times a day"];

export const Q_AUTO: [string, string, string][] = [
  ["🙋", "I decide everything", "MARA only suggests ideas"],
  ["✍️", "MARA drafts, I approve", "Nothing goes out unapproved"],
  ["⚡", "MARA drafts and schedules", "I can edit before it publishes"],
  ["🤖", "MARA runs it end-to-end", "Within the rules I set"],
];

export const Q_PERM: [string, string, string][] = [
  ["🔒", "Yes — always ask first", "Every post waits for my approval"],
  ["💳", "Ask for paid ads only", "Organic posts publish automatically"],
  ["🚦", "No — publish automatically", "MARA stays inside my brand rules"],
];

export const OB_STEPS = ["Your name", "Your brand", "Category", "Goals", "Voice & channels", "Budget & pace", "Working style", "Your channels"];
