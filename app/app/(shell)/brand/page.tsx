import Link from "next/link";
import { BrandKitReadError } from "@/lib/brand/context";
import { PageHeader } from "@/components/voom/redesign/ui";
import { BrandHub } from "@/components/voom/brand/BrandHub";
import { isAiVisionConfigured } from "@/lib/ai";
import { signBrandAssetUrls } from "@/lib/brand/asset-storage";
import { loadBrandKitHistory } from "@/lib/brand/read";
import { brandHubValues } from "@/lib/brand/sections";
import { normalizePlan } from "@/lib/billing/plans";
import { normalizeAutomationMode } from "@/lib/voom/automation";
import { getBusinessRecord, getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

/**
 * Brand Hub (Brand Kit v2, slice 2): everything MARA knows about the brand,
 * editable in place, with the version history. Reads the newest kit version
 * through the user-scoped client (RLS) and falls back to the `businesses` row
 * for the core fields, so accounts from before Brand Kit v2 see their real
 * values. Laid out with the redesign's page pieces (Phase C, 2026-11-02):
 * `PageHeader` and `voom-card` sections, like Settings and Automations.
 */
export default async function BrandPage() {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  let history: Awaited<ReturnType<typeof loadBrandKitHistory>>;
  try { history = await loadBrandKitHistory(await createClient(), user.id); } catch (reason) {
    if (!(reason instanceof BrandKitReadError)) throw reason;
    return <div role="alert" className="voom-card p-6"><h1>Brand Kit unavailable</h1><p>Your saved Brand Kit could not be loaded. Please retry before editing.</p><Link href="/app/brand">Retry</Link></div>;
  }
  const current = history[0] ?? null;
  const values = brandHubValues(business, current);
  // Slice 5: the bucket is private, so thumbnails use one-hour signed links.
  let assetUrls: Record<string, string> = {};
  try {
    assetUrls = await signBrandAssetUrls(createAdminClient(), user.id, values.assets.assets.map((asset) => asset.path));
  } catch {
    assetUrls = {};
  }

  return (
    <div className="mx-auto min-w-0 max-w-[880px]">
      <PageHeader
        title="Brand"
        subtitle="Everything MARA knows about your brand, in plain words. Edit any section in place."
      />
      <BrandHub
        mode="hub"
        initialValues={values}
        history={history}
        plan={normalizePlan(business.plan)}
        automation={normalizeAutomationMode(business.automation_level)}
        assetUrls={assetUrls}
        visionEnabled={isAiVisionConfigured()}
      />
    </div>
  );
}
