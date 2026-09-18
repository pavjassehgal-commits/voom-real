/**
 * Branded Email Engine v1 — the settings/preview read surface.
 *
 * Returns what recipients will actually SEE (resolved from-name, from-address,
 * reply-to, verification status) plus the authoritative brand profile for the
 * settings UI and the email preview. The verification status can never say
 * "Verified" unless provider-backed rows say so; it degrades truthfully to
 * "not configured" when 0041 is not applied.
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { loadEmailBrandProfile } from "./brand";
import type { EmailBrandProfile } from "./brand-profile";
import { loadResolvedSender } from "./sender-server";
import { senderVerificationLabel } from "./sender";

export interface EmailSenderSettings {
  fromName: string;
  fromAddress: string;
  replyTo: string | null;
  verificationStatus: string;
  verificationLabel: string;
  onBusinessIdentity: boolean;
  fallbackReasons: string[];
}

export interface EmailBrandSettings {
  sender: EmailSenderSettings;
  brand: EmailBrandProfile;
}

/** Reads the owner's email sender identity + brand profile for the settings UI. */
export async function readEmailBrandSettings(
  db: SupabaseClient,
  ownerId: string,
): Promise<EmailBrandSettings> {
  const [brand, sender] = await Promise.all([
    loadEmailBrandProfile(db, ownerId),
    loadResolvedSender(db, ownerId, {
      businessName: null,
      senderAddress: null,
      senderName: null,
      replyTo: null,
    }),
  ]);

  return {
    sender: {
      fromName: sender.fromName,
      fromAddress: sender.fromAddress,
      replyTo: sender.replyTo,
      verificationStatus: sender.verificationStatus,
      verificationLabel: senderVerificationLabel(sender.verificationStatus),
      onBusinessIdentity: sender.onBusinessIdentity,
      fallbackReasons: sender.fallbackReasons,
    },
    brand,
  };
}
