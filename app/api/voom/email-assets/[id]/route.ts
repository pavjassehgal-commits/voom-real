import { EmailAssetError, removeEmailAsset } from "@/lib/email/branded";
import { createEmailAssetStorage } from "@/lib/email/branded/storage";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

/**
 * DELETE /api/voom/email-assets/:id — removes one published email asset:
 * the row is marked `removed` through the owner-scoped RPC, then the public
 * object is deleted. An asset in use by a brand logo is still removable —
 * the next brand save or send simply falls back to the wordmark.
 */
export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const { id } = await params;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return Response.json({ error: "That email image was not found." }, { status: 404 });
  }

  try {
    const admin = createAdminClient();
    const storage = createEmailAssetStorage(admin);
    const { path } = await removeEmailAsset(admin, storage, { ownerId: user.id, assetId: id });
    return Response.json({ removed: true, path });
  } catch (error) {
    if (error instanceof EmailAssetError && error.code === "asset_not_found") {
      return Response.json({ error: "That email image was not found." }, { status: 404 });
    }
    return Response.json({ error: "Voom couldn't remove that image. Please retry." }, { status: 503 });
  }
}
