/**
 * Trend Intelligence — industry and market signals from plain text.
 *
 * Deterministic and pure. It reads only the words a business wrote about
 * itself (industry, description, audience, goal) or the words a source
 * published (a holiday name, a Wikipedia title), and maps them onto a small
 * shared taxonomy. Nothing is inferred beyond what the text says: a business
 * that names no industry keyword gets no industry, and a business that names
 * no place gets no market (the caller then uses worldwide signals only).
 */

export const INDUSTRIES = [
  "food_beverage",
  "fashion_apparel",
  "automotive",
  "beauty_personal_care",
  "home_living",
  "fitness_sports",
  "health_wellness",
  "travel_hospitality",
  "retail_gifting",
  "technology_gaming",
  "education",
  "events_entertainment",
  "pets",
  "real_estate",
  "professional_services",
] as const;
export type Industry = (typeof INDUSTRIES)[number];

/** Lower-case keywords and phrases; matched on word boundaries. */
const LEXICON: Record<Industry, readonly string[]> = {
  food_beverage: [
    "restaurant", "restaurants", "cafe", "café", "coffee", "bakery", "bakeries", "food", "foods", "dining", "cuisine", "chef",
    "pizza", "burger", "burgers", "sushi", "dessert", "desserts", "catering", "kitchen", "recipe", "recipes", "brunch",
    "tea", "juice", "grill", "steak", "steakhouse", "vegan", "halal", "shawarma", "pastry", "patisserie", "chocolate",
    "cake", "cakes", "ice cream", "cocktail", "barbecue", "bbq", "noodle", "noodles", "ramen", "taco", "tacos",
    "bistro", "eatery", "takeaway", "food truck", "pumpkin spice", "beverage", "beverages", "meal", "meals", "snack", "snacks",
  ],
  fashion_apparel: [
    "fashion", "clothing", "clothes", "apparel", "boutique", "dress", "dresses", "shoes", "sneaker", "sneakers",
    "streetwear", "jewelry", "jewellery", "handbag", "handbags", "accessories", "couture", "garment", "garments",
    "abaya", "abayas", "modest wear", "textile", "textiles", "fashion week", "met gala", "runway", "denim", "tailor",
    "tailoring", "outfit", "outfits", "wardrobe", "menswear", "womenswear", "kidswear", "lingerie", "swimwear", "eyewear",
  ],
  automotive: [
    "car", "cars", "auto repair", "auto parts", "auto detailing", "automotive", "vehicle", "vehicles", "detailing", "garage", "mechanic", "mechanics", "tyre",
    "tyres", "tire", "tires", "motor", "motors", "motorsport", "motorsports", "formula one", "formula 1", "grand prix",
    "nascar", "electric vehicle", "electric vehicles", "dealership", "ceramic coating", "car wash", "rally", "supercar",
    "supercars", "motorcycle", "motorcycles", "paint correction", "windscreen", "windshield", "car rental",
  ],
  beauty_personal_care: [
    "beauty", "salon", "salons", "spa", "skincare", "skin care", "cosmetics", "makeup", "make-up", "hair", "hairdresser",
    "barber", "barbershop", "nail", "nails", "lash", "lashes", "brow", "brows", "fragrance", "fragrances", "perfume",
    "perfumes", "facial", "facials", "massage", "aesthetics", "grooming", "manicure", "pedicure", "serum", "sunscreen",
  ],
  home_living: [
    "homeware", "homewares", "furniture", "decor", "décor", "interior", "interiors", "interior design",
    "kitchenware", "bedding", "mattress", "mattresses", "garden", "gardening", "cleaning", "appliance", "appliances",
    "diy", "renovation", "candle", "candles", "rug", "rugs", "lighting", "houseplant", "houseplants", "cookware", "sofa",
    "sofas", "home products", "home decor", "home goods", "household",
  ],
  fitness_sports: [
    "gym", "gyms", "fitness", "yoga", "pilates", "crossfit", "sport", "sports", "athlete", "athletes", "running",
    "marathon", "football", "soccer", "cricket", "tennis", "padel", "boxing", "martial arts", "cycling", "workout",
    "workouts", "personal trainer", "bodybuilding", "basketball", "golf", "swimming",
  ],
  health_wellness: [
    "clinic", "clinics", "dental", "dentist", "pharmacy", "doctor", "doctors", "physiotherapy", "physio", "medical",
    "healthcare", "nutrition", "nutritionist", "wellness", "therapy", "therapist", "mental health", "supplements",
  ],
  travel_hospitality: [
    "hotel", "hotels", "travel", "tourism", "resort", "resorts", "airline", "airlines", "tour", "tours", "staycation",
    "hostel", "holiday rental", "vacation", "cruise ship", "cruise line", "desert safari", "travel agency",
  ],
  retail_gifting: [
    "gift", "gifts", "gifting", "florist", "flowers", "toy", "toys", "stationery", "black friday", "cyber monday",
    "ecommerce", "e-commerce", "online store", "retail",
  ],
  technology_gaming: [
    "software", "saas", "technology", "tech", "gadget", "gadgets", "smartphone", "smartphones", "iphone", "android",
    "video game", "video games", "gaming", "esports", "electronics", "laptop", "laptops", "mobile app", "artificial intelligence",
  ],
  education: [
    "school", "schools", "tutoring", "tutor", "tutors", "course", "courses", "academy", "education", "university",
    "learning", "training centre", "training center", "nursery", "kindergarten",
  ],
  events_entertainment: [
    "events", "wedding", "weddings", "photography", "photographer", "music", "concert", "concerts", "festival",
    "festivals", "film", "films", "cinema", "movie", "movies", "party", "parties", "dj", "theatre", "theater",
  ],
  pets: ["pet", "pets", "dog", "dogs", "cat", "cats", "veterinary", "vet", "puppy", "puppies", "kitten", "pet grooming"],
  real_estate: [
    "real estate", "property", "properties", "realtor", "apartment", "apartments", "villa", "villas", "mortgage",
    "brokerage", "letting", "estate agent",
  ],
  professional_services: [
    "consulting", "consultancy", "agency", "legal", "lawyer", "accounting", "accountant", "bookkeeping", "recruitment",
    "marketing agency", "insurance", "finance", "financial",
  ],
};

/**
 * Seasonal and cultural moments any business can relate to without claiming
 * an industry connection (a restaurant and a garage can both mark Eid).
 */
const UNIVERSAL_MOMENTS: readonly string[] = [
  "new year", "new year's day", "christmas", "christmas day", "boxing day", "eid", "eid al-fitr", "eid al-adha", "ramadan",
  "diwali", "deepavali", "holi", "halloween", "valentine's day", "mother's day", "father's day", "thanksgiving",
  "easter", "good friday", "easter monday", "national day", "independence day", "lunar new year", "chinese new year",
  "back to school", "summer", "winter", "spring", "autumn", "black friday", "cyber monday", "women's day",
  "earth day", "labour day", "labor day", "commemoration day", "hanukkah", "mawlid", "islamic new year", "bank holiday",
];

/**
 * Words that make a topic unsuitable for brand marketing. A title containing
 * one is never offered to a business, whatever else it matches.
 */
const UNSAFE = /\b(death|deaths|dies|died|killing|killed|murder|shooting|massacre|war|wars|attack|attacks|terror|terrorism|bomb|bombing|suicide|abuse|assault|rape|porn|pornography|sex|nude|scandal|disease|outbreak|pandemic|epidemic|crash|disaster|earthquake|flood|hurricane|election|elections|president|prime minister|party \(politics\)|politics|political|conservative|conservatives|liberal|liberals|republican|republicans|democrat|democrats|senator|congress|parliament|protest|protests|genocide|execution|trial|cancer|overdose|drug|drugs|weapon|weapons|gun|guns|isis|hamas|nazi|holocaust|obituary)\b/i;

export function normalizeText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replaceAll("_", " ")
    .replace(/[’`]/g, "'")
    .replace(/[^\p{L}\p{N}' &-]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function containsTerm(normalized: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").test(normalized);
}

export type TextClassification = {
  industries: Industry[];
  /** The exact lexicon terms that matched, per industry (for auditability). */
  matchedTerms: Partial<Record<Industry, string[]>>;
  universalMoment: string | null;
  unsafe: boolean;
};

export function classifyText(...parts: (string | null | undefined)[]): TextClassification {
  const raw = parts.filter((part): part is string => typeof part === "string" && part.trim().length > 0).join(" • ");
  const normalized = normalizeText(raw);
  const matchedTerms: Partial<Record<Industry, string[]>> = {};
  for (const industry of INDUSTRIES) {
    const hits = LEXICON[industry].filter((term) => containsTerm(normalized, term));
    if (hits.length > 0) matchedTerms[industry] = hits;
  }
  const universalMoment = UNIVERSAL_MOMENTS.find((term) => containsTerm(normalized, term)) ?? null;
  return {
    industries: INDUSTRIES.filter((industry) => matchedTerms[industry] !== undefined),
    matchedTerms,
    universalMoment,
    unsafe: UNSAFE.test(raw.replaceAll("_", " ")),
  };
}

/**
 * The cultural moment a title IS (not merely mentions): after removing a
 * parenthetical qualifier and a leading or trailing year, the whole title must
 * be a moment term. "Halloween" and "Diwali 2026" qualify; "Summer H. Howell"
 * (a person) and "National Day of Spain" (a specific country's day) do not.
 */
export function momentTitle(text: string): string | null {
  const base = normalizeText(text.replace(/\([^)]*\)/g, " ")).replace(/^\d{4} /, "").replace(/ \d{4}$/, "").trim();
  return UNIVERSAL_MOMENTS.includes(base) ? base : null;
}

/** Moments tied to particular countries: only businesses in those markets get them. */
export const REGIONAL_MOMENTS: Readonly<Record<string, readonly string[]>> = {
  thanksgiving: ["US", "CA"],
  "bank holiday": ["GB", "IE"],
  "commemoration day": ["AE"],
  "national day": [],
  "independence day": [],
  "labor day": ["US", "CA"],
};

const MEDIA_QUALIFIER = /\b(film|tv series|series|miniseries|tv program|video game|album|song|musical|novel|book|franchise)\b/i;

/**
 * Signals from a Wikipedia article title, stricter than classifyText because
 * daily top lists are full of people, films and franchises:
 *   - a "(film)"/"(TV series)"-style qualifier makes it an entertainment topic only;
 *   - any other qualifier that is not a year or a place ("(American football)",
 *     "(software engineer)") marks a person or unrelated subject: no signal;
 *   - a multi-word Title Case name ("Zay Flowers", "Grand Theft Auto VI")
 *     counts only if the whole name is a known phrase ("Met Gala") or it is a
 *     dated event ("2026 Chicago Marathon").
 */
export function attentionSignals(title: string): { industries: Industry[]; moment: string | null; unsafe: boolean } {
  const unsafe = classifyText(title).unsafe;
  const moment = momentTitle(title);
  const qualifiers = [...title.matchAll(/\(([^)]*)\)/g)].map((m) => m[1].trim());
  const base = title.replace(/\s*\([^)]*\)/g, "").trim();
  if (qualifiers.some((q) => MEDIA_QUALIFIER.test(q))) return { industries: ["events_entertainment"], moment: null, unsafe };
  if (qualifiers.some((q) => !/^\d{4}$/.test(q) && marketsMentioned(q).length === 0)) return { industries: [], moment: null, unsafe };
  const normalizedBase = normalizeText(base);
  const exact = INDUSTRIES.filter((industry) => LEXICON[industry].includes(normalizedBase));
  if (exact.length > 0) return { industries: exact, moment, unsafe };
  const words = base.split(/\s+/).filter(Boolean);
  const titleCase = words.length >= 2 && words.every((w) => /^[\p{Lu}\p{N}]/u.test(w) || ["of", "the", "and", "de", "la"].includes(w));
  const dated = words.some((w) => /^\d{4}$/.test(w));
  if (titleCase && !dated) return { industries: [], moment, unsafe };
  return { industries: classifyText(base).industries, moment, unsafe };
}

/* ── Markets: only places the business itself names ───────────────── */

const PLACES: readonly [string, string][] = [
  ["united arab emirates", "AE"], ["uae", "AE"], ["dubai", "AE"], ["abu dhabi", "AE"], ["sharjah", "AE"], ["ajman", "AE"],
  ["ras al khaimah", "AE"], ["fujairah", "AE"], ["al ain", "AE"],
  ["united kingdom", "GB"], ["uk", "GB"], ["britain", "GB"], ["england", "GB"], ["scotland", "GB"], ["wales", "GB"],
  ["london", "GB"], ["manchester", "GB"], ["birmingham", "GB"], ["edinburgh", "GB"], ["glasgow", "GB"],
  ["united states", "US"], ["usa", "US"], ["new york", "US"], ["los angeles", "US"], ["california", "US"], ["texas", "US"],
  ["chicago", "US"], ["miami", "US"], ["florida", "US"], ["san francisco", "US"], ["seattle", "US"], ["boston", "US"],
  ["canada", "CA"], ["toronto", "CA"], ["vancouver", "CA"], ["montreal", "CA"],
  ["australia", "AU"], ["sydney", "AU"], ["melbourne", "AU"], ["brisbane", "AU"], ["perth", "AU"],
  ["new zealand", "NZ"], ["auckland", "NZ"],
  ["ireland", "IE"], ["dublin", "IE"],
  ["germany", "DE"], ["berlin", "DE"], ["munich", "DE"], ["hamburg", "DE"],
  ["france", "FR"], ["paris", "FR"], ["lyon", "FR"],
  ["spain", "ES"], ["madrid", "ES"], ["barcelona", "ES"],
  ["italy", "IT"], ["rome", "IT"], ["milan", "IT"],
  ["netherlands", "NL"], ["amsterdam", "NL"], ["rotterdam", "NL"],
  ["india", "IN"], ["mumbai", "IN"], ["delhi", "IN"], ["new delhi", "IN"], ["bangalore", "IN"], ["bengaluru", "IN"],
  ["hyderabad", "IN"], ["chennai", "IN"], ["kolkata", "IN"], ["pune", "IN"],
  ["saudi arabia", "SA"], ["riyadh", "SA"], ["jeddah", "SA"],
  ["qatar", "QA"], ["doha", "QA"], ["kuwait", "KW"], ["bahrain", "BH"], ["oman", "OM"], ["muscat", "OM"],
  ["egypt", "EG"], ["cairo", "EG"], ["south africa", "ZA"], ["johannesburg", "ZA"], ["cape town", "ZA"],
  ["nigeria", "NG"], ["lagos", "NG"], ["kenya", "KE"], ["nairobi", "KE"],
  ["singapore", "SG"], ["malaysia", "MY"], ["kuala lumpur", "MY"], ["indonesia", "ID"], ["jakarta", "ID"],
  ["philippines", "PH"], ["manila", "PH"], ["thailand", "TH"], ["bangkok", "TH"], ["vietnam", "VN"],
  ["hong kong", "HK"], ["japan", "JP"], ["tokyo", "JP"], ["south korea", "KR"], ["seoul", "KR"],
  ["turkey", "TR"], ["türkiye", "TR"], ["istanbul", "TR"], ["pakistan", "PK"], ["karachi", "PK"], ["lahore", "PK"],
  ["brazil", "BR"], ["são paulo", "BR"], ["sao paulo", "BR"], ["mexico", "MX"], ["mexico city", "MX"],
];

export type MarketMention = { country: string; mentioned: string };

/** Countries the text explicitly names (by country or a major city). Order of first mention; no guesses. */
export function marketsMentioned(...parts: (string | null | undefined)[]): MarketMention[] {
  const normalized = normalizeText(parts.filter((part): part is string => typeof part === "string").join(" • "));
  const found: (MarketMention & { at: number })[] = [];
  for (const [place, country] of PLACES) {
    const escaped = place.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const match = new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}($|[^\\p{L}\\p{N}])`, "u").exec(normalized);
    if (!match) continue;
    const existing = found.find((f) => f.country === country);
    if (!existing) found.push({ country, mentioned: place, at: match.index });
    else if (match.index < existing.at) Object.assign(existing, { mentioned: place, at: match.index });
  }
  return found.sort((a, b) => a.at - b.at).map(({ country, mentioned }) => ({ country, mentioned }));
}

const COUNTRY_NAMES: Record<string, string> = {
  AE: "the United Arab Emirates", GB: "the United Kingdom", US: "the United States", CA: "Canada", AU: "Australia",
  NZ: "New Zealand", IE: "Ireland", DE: "Germany", FR: "France", ES: "Spain", IT: "Italy", NL: "the Netherlands",
  IN: "India", SA: "Saudi Arabia", QA: "Qatar", KW: "Kuwait", BH: "Bahrain", OM: "Oman", EG: "Egypt", ZA: "South Africa",
  NG: "Nigeria", KE: "Kenya", SG: "Singapore", MY: "Malaysia", ID: "Indonesia", PH: "the Philippines", TH: "Thailand",
  VN: "Vietnam", HK: "Hong Kong", JP: "Japan", KR: "South Korea", TR: "Türkiye", PK: "Pakistan", BR: "Brazil", MX: "Mexico",
};

export function countryName(code: string): string {
  return COUNTRY_NAMES[code] ?? code;
}
