/**
 * Per-post TikTok consent.
 *
 * TikTok's Content Sharing Guidelines require that content is sent only after
 * the user has expressly consented to that upload. Voom records the consent
 * on the draft (content_meta.tiktokPost) when the owner presses "Post to
 * TikTok" in the post sheet. The record binds the consent to exactly what was
 * reviewed: the account, the caption, the privacy and interaction settings,
 * the disclosures and the video file. The publish worker recomputes the same
 * fingerprint from the queued row before it contacts TikTok; if anything
 * differs, or no consent exists (for example an item Autopilot or a campaign
 * approved), nothing is sent and the item waits for the owner.
 */

import { createHash } from "node:crypto";

import { parseTikTokPostSettings, type TikTokPostSettings } from "./post-settings";
import type { TikTokPrivacy } from "./publishing";

export const TIKTOK_POST_CONSENT_VERSION = 1;

export interface TikTokPostConsent {
  version: typeof TIKTOK_POST_CONSENT_VERSION;
  settings: TikTokPostSettings & { privacy: TikTokPrivacy };
  /** The TikTok account the owner saw in the sheet. */
  creatorOpenId: string;
  creatorNickname: string | null;
  /** Which declaration was shown next to the post button. */
  declaration: "music" | "music_and_branded";
  consentedAt: string;
  /** Duration independently derived from the stored bytes by Voom's server. */
  videoDurationSec: number;
  fingerprint: string;
}

/** Everything a consent covers, as the worker sees it on the queue row. */
export interface TikTokConsentSubject {
  draftId: string;
  creatorOpenId: string;
  title: string;
  privacyLevel: string | null;
  disableComment: boolean | null;
  disableDuet: boolean | null;
  disableStitch: boolean | null;
  brandContentToggle: boolean | null;
  brandOrganicToggle: boolean | null;
  isAigc: boolean | null;
  assetStoragePath: string;
  assetByteSize: number;
  videoDurationSec: number;
}

export function tiktokConsentFingerprint(subject: TikTokConsentSubject): string {
  const canonical = JSON.stringify([
    TIKTOK_POST_CONSENT_VERSION,
    subject.draftId,
    subject.creatorOpenId,
    subject.title,
    subject.privacyLevel,
    subject.disableComment,
    subject.disableDuet,
    subject.disableStitch,
    subject.brandContentToggle,
    subject.brandOrganicToggle,
    subject.isAigc,
    subject.assetStoragePath,
    subject.assetByteSize,
    subject.videoDurationSec,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export function parseTikTokPostConsent(value: unknown): TikTokPostConsent | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (v.version !== TIKTOK_POST_CONSENT_VERSION) return null;
  const settings = parseTikTokPostSettings(v.settings);
  if (!settings || !settings.privacy) return null;
  if (typeof v.creatorOpenId !== "string" || !v.creatorOpenId) return null;
  if (typeof v.consentedAt !== "string" || Number.isNaN(Date.parse(v.consentedAt))) return null;
  if (typeof v.videoDurationSec !== "number" || !Number.isFinite(v.videoDurationSec) || v.videoDurationSec <= 0) return null;
  if (typeof v.fingerprint !== "string" || !/^[0-9a-f]{64}$/.test(v.fingerprint)) return null;
  if (v.declaration !== "music" && v.declaration !== "music_and_branded") return null;
  return {
    version: TIKTOK_POST_CONSENT_VERSION,
    settings: settings as TikTokPostSettings & { privacy: TikTokPrivacy },
    creatorOpenId: v.creatorOpenId,
    creatorNickname: typeof v.creatorNickname === "string" ? v.creatorNickname : null,
    declaration: v.declaration,
    consentedAt: v.consentedAt,
    videoDurationSec: v.videoDurationSec,
    fingerprint: v.fingerprint,
  };
}

/**
 * "valid" only when a consent exists AND it covers exactly this subject.
 * "missing" when the owner never confirmed this post; "stale" when they did,
 * but the caption, settings, account or video changed afterwards.
 */
export function evaluateTikTokPostConsent(
  stored: unknown,
  subject: TikTokConsentSubject,
): "valid" | "missing" | "stale" {
  const consent = parseTikTokPostConsent(stored);
  if (!consent) return "missing";
  return consent.fingerprint === tiktokConsentFingerprint(subject) ? "valid" : "stale";
}
