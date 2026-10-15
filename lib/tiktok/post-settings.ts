/**
 * TikTok Direct Post settings — the rules of TikTok's Content Sharing
 * Guidelines ("Required UX Implementation") as pure, client-safe functions.
 * The post sheet (components/voom/modals/TikTokPostSheet.tsx), the consent
 * route and the queue sync all apply the SAME rules, so the browser can never
 * offer something the server would accept differently.
 *
 * What TikTok requires before a Direct Post, encoded here:
 *   - the creator's nickname is shown so the user knows which account posts;
 *   - privacy is chosen manually from the options the creator-info query
 *     returned, with NO default value;
 *   - Comment / Duet / Stitch are unchecked by default and cannot be enabled
 *     when the creator turned them off in TikTok;
 *   - commercial content disclosure: when switched on, the user must pick
 *     "Your brand", "Branded content" or both; branded content cannot be
 *     private (SELF_ONLY);
 *   - the user sees TikTok's Music Usage Confirmation (and, for branded
 *     content, the Branded Content Policy) declaration before posting;
 *   - the video must not be longer than the creator's maximum duration.
 *
 * Voom adds one rule of its own: until TikTok audits Voom's app, TikTok only
 * accepts private (SELF_ONLY) posts, so no other visibility is offered.
 */

import { isTikTokPrivacy, TIKTOK_PRIVACY_LABELS, TIKTOK_PRIVACY_VALUES, type TikTokPrivacy } from "./publishing";

export const TIKTOK_MUSIC_USAGE_URL = "https://www.tiktok.com/legal/page/global/music-usage-confirmation/en";
export const TIKTOK_BRANDED_CONTENT_POLICY_URL = "https://www.tiktok.com/legal/page/global/bc-policy/en";

/** What the owner chose in the post sheet. Every switch starts off. */
export interface TikTokPostSettings {
  privacy: TikTokPrivacy | null;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  /** "Disclose video content" — the commercial content switch. */
  commercial: boolean;
  /** Promoting yourself or your own business (TikTok: brand organic). */
  yourBrand: boolean;
  /** Promoting another brand or a third party (TikTok: branded content). */
  brandedContent: boolean;
  /** TikTok's AI-generated content label. */
  aiGenerated: boolean;
}

export const EMPTY_TIKTOK_POST_SETTINGS: TikTokPostSettings = {
  privacy: null,
  allowComment: false,
  allowDuet: false,
  allowStitch: false,
  commercial: false,
  yourBrand: false,
  brandedContent: false,
  aiGenerated: false,
};

/** The creator-info answer, reduced to what the post sheet needs. */
export interface TikTokCreatorOptions {
  nickname: string | null;
  username: string | null;
  avatarUrl: string | null;
  privacyOptions: TikTokPrivacy[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number | null;
}

export const TIKTOK_COMMERCIAL_CHOICE_REQUIRED =
  "You need to indicate if your content promotes yourself, a third party, or both.";
export const TIKTOK_BRANDED_CONTENT_NOT_PRIVATE = "Branded content visibility cannot be set to private.";
export const TIKTOK_UNAUDITED_PRIVATE_ONLY =
  "Until Voom completes TikTok's app review, TikTok only allows posts that are visible to you (Only me).";

/** The publish control may unlock only after the browser proves the preview is playable. */
export function isTikTokVideoPreviewReady(
  state: "loading" | "ready" | "error",
  durationSeconds: number | null,
): boolean {
  return state === "ready"
    && typeof durationSeconds === "number"
    && Number.isFinite(durationSeconds)
    && durationSeconds > 0;
}

export interface TikTokPrivacyChoice {
  value: TikTokPrivacy;
  label: string;
  disabled: boolean;
  reason: string | null;
}

/**
 * The privacy options to show, in TikTok's own order. Only values TikTok
 * returned for this creator appear at all; some may be shown disabled with
 * the reason (unaudited app, or branded content that cannot be private).
 */
export function tiktokPrivacyChoices(
  creator: Pick<TikTokCreatorOptions, "privacyOptions">,
  context: { appAudited: boolean; brandedContent: boolean },
): TikTokPrivacyChoice[] {
  return TIKTOK_PRIVACY_VALUES
    .filter((value) => creator.privacyOptions.includes(value))
    .map((value) => {
      if (!context.appAudited && value !== "SELF_ONLY") {
        return { value, label: TIKTOK_PRIVACY_LABELS[value], disabled: true, reason: TIKTOK_UNAUDITED_PRIVATE_ONLY };
      }
      if (context.brandedContent && value === "SELF_ONLY") {
        return { value, label: TIKTOK_PRIVACY_LABELS[value], disabled: true, reason: TIKTOK_BRANDED_CONTENT_NOT_PRIVATE };
      }
      return { value, label: TIKTOK_PRIVACY_LABELS[value], disabled: false, reason: null };
    });
}

export type TikTokPostSettingsCheck =
  | { ok: true; privacy: TikTokPrivacy }
  | { ok: false; code: TikTokPostSettingsError; message: string };

export type TikTokPostSettingsError =
  | "privacy_required"
  | "privacy_not_offered"
  | "unaudited_private_only"
  | "branded_content_private"
  | "commercial_choice_required"
  | "comment_disabled_by_creator"
  | "duet_disabled_by_creator"
  | "stitch_disabled_by_creator"
  | "video_duration_required"
  | "creator_video_limit_unavailable"
  | "video_too_long";

/** Every rule above, in one place. The server re-runs it against live creator info. */
export function checkTikTokPostSettings(
  settings: TikTokPostSettings,
  creator: TikTokCreatorOptions,
  context: { appAudited: boolean; videoDurationSec?: number | null },
): TikTokPostSettingsCheck {
  const fail = (code: TikTokPostSettingsError, message: string): TikTokPostSettingsCheck => ({ ok: false, code, message });
  if (!isTikTokPrivacy(settings.privacy)) return fail("privacy_required", "Choose who can view this video.");
  if (!creator.privacyOptions.includes(settings.privacy)) {
    return fail("privacy_not_offered", "TikTok doesn't offer that privacy option for this account. Choose one of the options shown.");
  }
  if (!context.appAudited && settings.privacy !== "SELF_ONLY") return fail("unaudited_private_only", TIKTOK_UNAUDITED_PRIVATE_ONLY);
  if (settings.commercial && !settings.yourBrand && !settings.brandedContent) {
    return fail("commercial_choice_required", TIKTOK_COMMERCIAL_CHOICE_REQUIRED);
  }
  if (settings.commercial && settings.brandedContent && settings.privacy === "SELF_ONLY") {
    return fail("branded_content_private", TIKTOK_BRANDED_CONTENT_NOT_PRIVATE);
  }
  if (settings.allowComment && creator.commentDisabled) {
    return fail("comment_disabled_by_creator", "Comments are turned off for this account in TikTok.");
  }
  if (settings.allowDuet && creator.duetDisabled) return fail("duet_disabled_by_creator", "Duet is turned off for this account in TikTok.");
  if (settings.allowStitch && creator.stitchDisabled) return fail("stitch_disabled_by_creator", "Stitch is turned off for this account in TikTok.");
  const duration = context.videoDurationSec;
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
    return fail("video_duration_required", "Wait for the video preview to load so Voom can verify its duration.");
  }
  if (typeof creator.maxVideoPostDurationSec !== "number"
      || !Number.isFinite(creator.maxVideoPostDurationSec)
      || creator.maxVideoPostDurationSec <= 0) {
    return fail("creator_video_limit_unavailable", "TikTok didn't provide a video duration limit for this account. Refresh and try again.");
  }
  if (duration > creator.maxVideoPostDurationSec) {
    return fail("video_too_long", `This video is longer than this account can post (${creator.maxVideoPostDurationSec} seconds maximum).`);
  }
  return { ok: true, privacy: settings.privacy };
}

/** The declaration TikTok requires next to the post button. */
export function tiktokDeclaration(settings: Pick<TikTokPostSettings, "commercial" | "brandedContent">): {
  kind: "music" | "music_and_branded";
  text: string;
} {
  return settings.commercial && settings.brandedContent
    ? { kind: "music_and_branded", text: "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation." }
    : { kind: "music", text: "By posting, you agree to TikTok's Music Usage Confirmation." };
}

/** The label TikTok will show on the video, if any. */
export function tiktokCommercialLabel(settings: Pick<TikTokPostSettings, "commercial" | "yourBrand" | "brandedContent">): string | null {
  if (!settings.commercial) return null;
  if (settings.brandedContent) return "Paid partnership";
  if (settings.yourBrand) return "Promotional content";
  return null;
}

/** The Direct Post fields for these settings (queue columns / post_info). */
export function tiktokPostFields(settings: TikTokPostSettings & { privacy: TikTokPrivacy }): {
  privacyLevel: TikTokPrivacy;
  disableComment: boolean;
  disableDuet: boolean;
  disableStitch: boolean;
  brandContentToggle: boolean;
  brandOrganicToggle: boolean;
  isAigc: boolean;
} {
  return {
    privacyLevel: settings.privacy,
    disableComment: !settings.allowComment,
    disableDuet: !settings.allowDuet,
    disableStitch: !settings.allowStitch,
    brandContentToggle: settings.commercial && settings.brandedContent,
    brandOrganicToggle: settings.commercial && settings.yourBrand,
    isAigc: settings.aiGenerated,
  };
}

/** Parses stored settings; anything malformed is treated as absent. */
export function parseTikTokPostSettings(value: unknown): TikTokPostSettings | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const flags = ["allowComment", "allowDuet", "allowStitch", "commercial", "yourBrand", "brandedContent", "aiGenerated"] as const;
  if (!flags.every((key) => typeof v[key] === "boolean")) return null;
  if (v.privacy !== null && !isTikTokPrivacy(v.privacy)) return null;
  return {
    privacy: (v.privacy as TikTokPrivacy | null) ?? null,
    allowComment: v.allowComment as boolean,
    allowDuet: v.allowDuet as boolean,
    allowStitch: v.allowStitch as boolean,
    commercial: v.commercial as boolean,
    yourBrand: v.yourBrand as boolean,
    brandedContent: v.brandedContent as boolean,
    aiGenerated: v.aiGenerated as boolean,
  };
}

/** Creator info as returned by the client, reduced and made safe for the browser. */
export function toTikTokCreatorOptions(info: {
  creatorNickname: string | null;
  creatorUsername: string | null;
  creatorAvatarUrl: string | null;
  privacyLevelOptions: string[];
  commentDisabled: boolean | null;
  duetDisabled: boolean | null;
  stitchDisabled: boolean | null;
  maxVideoPostDurationSec: number | null;
}): TikTokCreatorOptions {
  return {
    nickname: info.creatorNickname,
    username: info.creatorUsername,
    avatarUrl: info.creatorAvatarUrl,
    privacyOptions: info.privacyLevelOptions.filter(isTikTokPrivacy),
    // Unknown means "not known to be allowed": never enable what TikTok did not confirm.
    commentDisabled: info.commentDisabled !== false,
    duetDisabled: info.duetDisabled !== false,
    stitchDisabled: info.stitchDisabled !== false,
    maxVideoPostDurationSec: info.maxVideoPostDurationSec && info.maxVideoPostDurationSec > 0 ? info.maxVideoPostDurationSec : null,
  };
}
