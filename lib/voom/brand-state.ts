/**
 * The client-facing Brand state and the ONE mapping from the server's
 * `businesses` row into it.
 *
 * Every field the Settings screen can save MUST be represented here and
 * loaded from the business row. A field that is collected or persisted but
 * missing from this mapping cannot round-trip: the next full-field save would
 * overwrite the database value with an empty or stale one (this is exactly how
 * `brand_description` was silently wiped by the Settings save before it was
 * added to the mapping). Pure and dependency-free so the Node suite can
 * execute the real mapping.
 */

import type { BusinessRecord } from "./types";

export interface Brand {
  name: string;
  handle: string;
  industry: string;
  /** The persisted brand description (`businesses.brand_description`). */
  desc: string;
  audience: string[];
  goals: string[];
  tone: string[];
  channels: string[];
  budget: string;
  freq: string;
  auto: string;
  permission: string;
}

export function deriveHandle(name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 18);
  return slug ? "@" + slug : "";
}

export function emptyBrand(): Brand {
  return {
    name: "",
    handle: "",
    industry: "",
    desc: "",
    audience: [],
    goals: [],
    tone: [],
    channels: [],
    budget: "",
    freq: "",
    auto: "",
    permission: "",
  };
}

export function brandFromBusiness(business: BusinessRecord | null): Brand {
  if (!business) return emptyBrand();
  const name = business.brand_name?.trim() ?? "";
  return {
    name,
    handle: deriveHandle(name),
    industry: business.industry ?? "",
    desc: business.brand_description ?? "",
    audience: business.target_customer ?? [],
    goals: business.main_goal ? [business.main_goal] : [],
    tone: business.brand_personality ?? [],
    channels: business.preferred_channels ?? [],
    budget: business.monthly_ad_budget ?? "",
    freq: business.content_frequency ?? "",
    auto: business.automation_level ?? "",
    permission: business.publishing_permission ?? "",
  };
}
