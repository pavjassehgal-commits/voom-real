/** "1200" -> "1,200". */
export function nfc(value: number): string {
  return value.toLocaleString("en-US");
}

/**
 * Static, user-facing reference data that is legitimately hardcoded:
 * the subscription plan catalogue and the lightweight industry detector used
 * by onboarding. Nothing here is presented as account data — all real content
 * comes from the server APIs.
 */

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
