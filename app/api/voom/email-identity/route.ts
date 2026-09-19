import { readBusinessSender, loadEmailBrandProfile } from "@/lib/email/branded";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { z } from "zod";

/**
 * GET  /api/voom/email-identity — the truthful sender + branding picture:
 *   what is ACTUALLY being sent (identity mode), the provider's live
 *   verification state for the requested domain, and the stored identity,
 *   brand profile and email assets.
 *
 * PATCH /api/voom/email-identity — server-validated edits to the sender
 * identity and brand profile. The provider is the only writer of
 * verification state, so nothing here can claim a domain is verified.
 */

const patchFields = z
  .object({
    identity: z
      .object({
        displayName: z.string().trim().min(1).max(120).nullable().optional(),
        fromAddress: z.string().trim().min(3).max(254).email().nullable().optional(),
        replyTo: z.string().trim().min(3).max(254).email().nullable().optional(),
      })
      .strict()
      .optional(),
    brand: z
      .object({
        logoAssetId: z.string().trim().uuid().nullable().optional(),
        primaryColor: z.string().trim().max(7).nullable().optional(),
        secondaryColor: z.string().trim().max(7).nullable().optional(),
        website: z.string().trim().max(500).nullable().optional(),
        footerLine: z.string().trim().max(500).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export async function GET() {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  try {
    const admin = createAdminClient();
    const [sender, brandProfile] = await Promise.all([
      readBusinessSender(admin, user.id),
      loadEmailBrandProfile(admin, user.id),
    ]);

    const identity = sender.identity;

    return Response.json({
      businessName: brandProfile.name,
      sender: sender.sender
        ? {
            fromName: sender.sender.fromName,
            fromAddress: sender.sender.fromAddress,
            replyTo: sender.sender.replyTo ?? null,
            mode: sender.sender.mode,
          }
        : null,
      identity: identity
        ? {
            displayName: identity.display_name,
            fromAddress: identity.from_address,
            replyTo: identity.reply_to,
          }
        : null,
      verification: sender.verification,
      brand: {
        logoAssetId: brandProfile.logo?.assetId ?? null,
        primaryColor: brandProfile.primaryColor,
        secondaryColor: brandProfile.secondaryColor,
        website: brandProfile.website,
        footerLine: brandProfile.footerLine,
      },
      assets: brandProfile.assets.map((asset) => ({
        id: asset.assetId,
        url: asset.url,
        altText: asset.altText,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      })),
    });
  } catch {
    return Response.json({ error: "Voom couldn't load your email identity. Please retry." }, { status: 503 });
  }
}

export async function PATCH(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Those details aren't valid." }, { status: 400 });
  }
  const parsed = patchFields.safeParse(body);
  if (!parsed.success) {
    return Response.json({ error: "Check the email identity details before saving." }, { status: 400 });
  }

  try {
    const admin = createAdminClient();

    if (parsed.data.identity) {
      const identity = parsed.data.identity;
      const { error } = await admin.rpc("upsert_email_identity", {
        p_owner_user_id: user.id,
        p_payload: {
          displayName: identity.displayName ?? null,
          fromAddress: identity.fromAddress ?? null,
          replyTo: identity.replyTo ?? null,
        },
      });
      if (error) {
        return Response.json({ error: friendlyIdentityError(error.message) }, { status: 422 });
      }
    }

    if (parsed.data.brand) {
      const brand = parsed.data.brand;
      const { error } = await admin.rpc("upsert_email_brand", {
        p_owner_user_id: user.id,
        p_payload: {
          logoAssetId: brand.logoAssetId ?? null,
          primaryColor: brand.primaryColor ?? null,
          secondaryColor: brand.secondaryColor ?? null,
          website: brand.website ?? null,
          footerLine: brand.footerLine ?? null,
        },
      });
      if (error) {
        return Response.json({ error: friendlyBrandError(error.message) }, { status: 422 });
      }
    }

    const sender = await readBusinessSender(admin, user.id);
    const brandProfile = await loadEmailBrandProfile(admin, user.id);
    const identity = sender.identity;

    return Response.json({
      sender: sender.sender
        ? {
            fromName: sender.sender.fromName,
            fromAddress: sender.sender.fromAddress,
            replyTo: sender.sender.replyTo ?? null,
            mode: sender.sender.mode,
          }
        : null,
      identity: identity
        ? {
            displayName: identity.display_name,
            fromAddress: identity.from_address,
            replyTo: identity.reply_to,
          }
        : null,
      verification: sender.verification,
      brand: {
        logoAssetId: brandProfile.logo?.assetId ?? null,
        primaryColor: brandProfile.primaryColor,
        secondaryColor: brandProfile.secondaryColor,
        website: brandProfile.website,
        footerLine: brandProfile.footerLine,
      },
      assets: brandProfile.assets.map((asset) => ({
        id: asset.assetId,
        url: asset.url,
        altText: asset.altText,
        mimeType: asset.mimeType,
        width: asset.width,
        height: asset.height,
      })),
    });
  } catch {
    return Response.json({ error: "Voom couldn't save those changes. Please retry." }, { status: 503 });
  }
}

function friendlyIdentityError(message: string): string {
  switch (message) {
    case "invalid_from_address":
      return "That sender email address isn't a valid email address.";
    case "invalid_reply_to":
      return "That reply-to email address isn't a valid email address.";
    case "invalid_display_name":
      return "The sender name is too long (120 characters max).";
    case "business_not_found":
      return "Voom couldn't find your business profile yet. Add it, then save your email identity.";
    default:
      return "Voom couldn't save that sender identity. Please retry.";
  }
}

function friendlyBrandError(message: string): string {
  switch (message) {
    case "invalid_primary_color":
      return "The primary color must be a hex code like #1A73E8.";
    case "invalid_secondary_color":
      return "The secondary color must be a hex code like #F4F1EC.";
    case "invalid_website":
      return "The website must start with http:// or https://";
    case "footer_line_too_long":
      return "The footer line is too long (500 characters max).";
    case "logo_asset_not_found":
      return "That logo isn't one of your published email images. Pick one below, or publish one first.";
    case "business_not_found":
      return "Voom couldn't find your business profile yet. Add it, then save your branding.";
    default:
      return "Voom couldn't save that branding. Please retry.";
  }
}
