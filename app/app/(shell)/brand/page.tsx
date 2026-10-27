import { PageHead } from "@/components/voom/shell/AppShell";
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
 * values.
 */
export default async function BrandPage() {
  const [user, business] = await Promise.all([getCurrentUser(), getBusinessRecord()]);
  if (!user || !business) return null;
  const history = await loadBrandKitHistory(await createClient(), user.id);
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
    <div className="mx-auto max-w-[820px]">
      <PageHead
        title="Brand"
        description="Everything MARA knows about your brand, in plain words. Edit any section in place."
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
