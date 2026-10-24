import Image from "next/image";

/**
 * The designers' own 3D icons for every setup answer, extracted from the
 * Figma export (setup frames, PDF pages 11–17) at their highest available
 * resolution: raster icons at their native 48–100px, vector glyphs rendered
 * from the PDF at 8× (192px). Shown at ≤26px (30px for the stacked tiles),
 * so every icon is drawn at 2× density or better.
 *
 * Keyed by the stored answer label, so the answers themselves (and what is
 * saved) never change.
 */
export const ONBOARDING_ICONS: Record<string, string> = {
  // 1. What kind of business is this?
  "Restaurant / Café": "industry-restaurant",
  "Salon / Spa": "industry-salon",
  "Gym / Fitness studio": "industry-gym",
  "Clothing / Fashion": "industry-clothing",
  "Real estate": "industry-real-estate",
  "Online store": "industry-online-store",
  "Clinic / Healthcare": "industry-clinic",
  "Professional services": "industry-professional",
  Other: "industry-other",
  // Who is your target customer?
  "Local residents nearby": "customer-local",
  "Young adults (18–29)": "customer-young-adults",
  "Families with children": "customer-families",
  "Professionals (30–50)": "customer-professionals",
  "Tourists & visitors": "customer-tourists",
  "Businesses (B2B)": "customer-b2b",
  "Luxury / high-income": "customer-luxury",
  "Budget-conscious shoppers": "customer-budget",
  // What is your main marketing goal?
  "More walk-in customers": "goal-walk-in",
  "More online sales": "goal-online-sales",
  "More bookings & appointments": "goal-bookings",
  "More enquiries & leads": "goal-enquiries",
  "Grow followers & awareness": "goal-followers",
  "Launch something new": "goal-launch",
  // Brand personality
  Friendly: "tone-friendly",
  Premium: "tone-premium",
  Playful: "tone-playful",
  Professional: "tone-professional",
  Bold: "tone-bold",
  Calm: "tone-calm",
  Traditional: "tone-traditional",
  Modern: "tone-modern",
  // Budget (the reference uses one coin stack for every tier)
  "AED 0 — organic only": "budget-coins",
  "Under AED 1,000": "budget-coins",
  "AED 1,000 – 3,000": "budget-coins",
  "AED 3,000 – 10,000": "budget-coins",
  "AED 10,000+": "budget-coins",
  // Posting frequency
  "A few times a month": "freq-month",
  "2–3 times a week": "freq-week",
  Daily: "freq-daily",
  "Multiple times a day": "freq-many",
  // Automation level
  "I decide everything": "auto-decide",
  "MARA drafts, I approve": "auto-approve",
  "MARA drafts and schedules": "auto-schedule",
  "MARA runs it end-to-end": "auto-end-to-end",
  // Publishing permission
  "Yes — always ask first": "perm-ask-first",
  "Ask for paid ads only": "perm-paid-ads",
  "No — publish automatically": "perm-publish-auto",
  // "Need inspiration?" prompts
  "What you sell": "inspire-sell",
  "Your unique value": "inspire-unique",
  "Your target customers": "inspire-customers",
  "Your brand values": "inspire-values",
  "Your story or inspiration": "inspire-story",
  "What makes you different": "inspire-different",
  "Online or offline presence": "inspire-presence",
  "Anything else": "inspire-anything",
};

/** Decorative icon for one answer; renders nothing for a label without artwork. */
export function OnboardingIcon({ label, size = 24, className }: { label: string; size?: number; className?: string }) {
  const key = ONBOARDING_ICONS[label];
  if (!key) return null;
  return (
    <Image
      src={`/redesign/onboarding-icons/${key}.webp`}
      alt=""
      aria-hidden="true"
      width={size}
      height={size}
      unoptimized
      draggable={false}
      className={className ?? "select-none object-contain"}
      style={{ width: size, height: size }}
    />
  );
}
