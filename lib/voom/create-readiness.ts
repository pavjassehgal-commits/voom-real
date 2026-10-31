/**
 * Create-flow readiness checks — pure, computed only from the draft's own
 * stored fields and the platform's published limits. Instagram's approval
 * blockers come from the SAME `postApprovalBlockers` the approve route uses,
 * so "ready" here can never disagree with what approval will accept.
 */
import { postApprovalBlockers } from "../post/core.ts";

export interface ReadinessCheck { label: string; detail: string; ok: boolean }

export interface CreateDraft {
  id: string;
  editor: "post" | "social";
  kind: string;
  channel: "instagram" | "tiktok" | "youtube";
  typeLabel: string;
  title: string;
  caption: string;
  description: string | null;
  hashtags: string[];
  format: string;
  previewUrl: string | null;
  mimeType: string | null;
  mediaName: string | null;
  mediaReady: boolean;
  status: "draft" | "approved" | "rejected";
  scheduledAt: string | null;
  privacy: string | null;
  madeForKids: boolean | null;
  tiktokPrivacy: string | null;
  tiktokConsent: boolean;
}

export const INSTAGRAM_CAPTION_LIMIT = 2200;
export const INSTAGRAM_HASHTAG_LIMIT = 30;
export const TIKTOK_CAPTION_LIMIT = 2200;
export const YOUTUBE_TITLE_LIMIT = 100;
export const YOUTUBE_DESCRIPTION_LIMIT = 5000;

export function readinessChecks(draft: CreateDraft): ReadinessCheck[] {
  const media: ReadinessCheck = draft.mediaReady
    ? { label: "Media attached", detail: draft.mediaName ?? "Stored in Voom", ok: true }
    : { label: "Media needed", detail: draft.channel === "instagram" ? "Add an image or video before approving." : "Add the video before publishing.", ok: false };

  if (draft.channel === "instagram") {
    const isStory = draft.kind === "story";
    const blockers = postApprovalBlockers({ caption: draft.caption, hasVisual: draft.mediaReady, kind: draft.kind });
    const checks: ReadinessCheck[] = [
      { label: `Format ${draft.kind === "instagram_post" ? draft.format : "9:16"}`, detail: draft.kind === "instagram_post" ? "Feed post aspect ratio" : "Fills the full vertical screen", ok: true },
      media,
    ];
    if (isStory) {
      checks.push({ label: "No caption needed", detail: "Instagram Stories carry no caption", ok: true });
    } else {
      const length = draft.caption.length;
      checks.push({ label: `Caption ${length.toLocaleString("en-US")} / ${INSTAGRAM_CAPTION_LIMIT.toLocaleString("en-US")}`, detail: length ? "The first line shows before “more”" : "Add a caption before approving", ok: length > 0 && length <= INSTAGRAM_CAPTION_LIMIT });
      checks.push({ label: `Hashtags ${draft.hashtags.length}`, detail: `Instagram allows up to ${INSTAGRAM_HASHTAG_LIMIT}`, ok: draft.hashtags.length <= INSTAGRAM_HASHTAG_LIMIT });
    }
    checks.push(blockers.length
      ? { label: "Not ready to approve", detail: blockers.join(" "), ok: false }
      : { label: "Ready to approve", detail: "Meets Voom’s approval rules for this format", ok: true });
    return checks;
  }

  if (draft.channel === "tiktok") {
    const length = draft.caption.length;
    return [
      { label: "Format 9:16", detail: "Vertical TikTok video", ok: true },
      media,
      { label: `Caption ${length.toLocaleString("en-US")} / ${TIKTOK_CAPTION_LIMIT.toLocaleString("en-US")}`, detail: "TikTok shows the first lines before “more”", ok: length <= TIKTOK_CAPTION_LIMIT },
      draft.tiktokPrivacy ? { label: "Privacy chosen", detail: "Your TikTok viewing setting is set", ok: true } : { label: "Privacy not chosen", detail: "TikTok has no default — choose it in the publishing settings", ok: false },
      draft.tiktokConsent ? { label: "Post confirmed", detail: "You confirmed this exact TikTok post", ok: true } : { label: "Confirmation needed", detail: "Confirm the post in the publishing settings before it can go out", ok: false },
    ];
  }

  const title = draft.title.length;
  const description = (draft.description ?? "").length;
  return [
    { label: draft.kind === "youtube_short" ? "Format 9:16" : "Format 16:9", detail: draft.kind === "youtube_short" ? "Vertical YouTube Short" : "Horizontal YouTube video", ok: true },
    media,
    { label: `Title ${title} / ${YOUTUBE_TITLE_LIMIT}`, detail: "Search-friendly title", ok: title > 0 && title <= YOUTUBE_TITLE_LIMIT },
    { label: `Description ${description.toLocaleString("en-US")} / ${YOUTUBE_DESCRIPTION_LIMIT.toLocaleString("en-US")}`, detail: "Shown under the video", ok: description <= YOUTUBE_DESCRIPTION_LIMIT },
    draft.madeForKids === null ? { label: "Audience not declared", detail: "YouTube requires a made-for-kids declaration", ok: false } : { label: "Audience declared", detail: draft.madeForKids ? "Made for kids" : "Not made for kids", ok: true },
    draft.privacy ? { label: "Privacy chosen", detail: `Visibility: ${draft.privacy}`, ok: true } : { label: "Privacy not chosen", detail: "Choose public, unlisted or private", ok: false },
  ];
}
