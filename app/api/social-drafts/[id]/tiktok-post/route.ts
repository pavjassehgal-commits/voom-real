import { z } from "zod";

import { getSocialDraft, tiktokQueueTitle, updateSocialDraft } from "@/lib/social/server-drafts";
import { TikTokApiError, TikTokClient } from "@/lib/tiktok/client";
import { readTikTokConfig, tikTokKeyRing, type TikTokConfig } from "@/lib/tiktok/config";
import { getTikTokServerCredentials } from "@/lib/tiktok/data";
import { TIKTOK_POST_CONSENT_VERSION, tiktokConsentFingerprint, type TikTokPostConsent } from "@/lib/tiktok/post-consent";
import {
  checkTikTokPostSettings,
  tiktokDeclaration,
  tiktokPostFields,
  toTikTokCreatorOptions,
  type TikTokCreatorOptions,
} from "@/lib/tiktok/post-settings";
import { isTikTokPublishableMime, TIKTOK_TITLE_MAX } from "@/lib/tiktok/publishing";
import { hasPublishPermission } from "@/lib/tiktok/scopes";
import { validateTikTokVideoDuration } from "@/lib/tiktok/video-duration";
import { inspectTikTokVideoDurationFromUrl } from "@/lib/tiktok/video-duration-server";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREVIEW_TTL_SECONDS = 600;
const ASSET_BUCKET = "mara-media";

/**
 * The TikTok post sheet's server side (TikTok Content Sharing Guidelines,
 * "Required UX Implementation").
 *
 * GET  reads the creator info TikTok requires before every post (account
 *      nickname, the privacy options TikTok offers this account, whether
 *      Comment/Duet/Stitch are turned off, the maximum video length) plus a
 *      short-lived preview of the owner's own video. Read-only at TikTok.
 * POST records the owner's express consent to post THIS video with THESE
 *      settings, re-checking everything against live creator info, then
 *      approves the draft onto the durable TikTok queue. Nothing is uploaded
 *      here: the cron worker sends it, and only after re-verifying that the
 *      queued row still matches this consent.
 *
 * Until TikTok audits Voom's app only private (Only me) posts are accepted.
 * No token, upload URL or TikTok account id ever leaves the server.
 */

type Loaded =
  | { ok: false; response: Response }
  | {
      ok: true;
      draft: NonNullable<Awaited<ReturnType<typeof getSocialDraft>>>;
      config: TikTokConfig;
      openId: string;
      creator: TikTokCreatorOptions;
      asset: { storagePath: string; mimeType: string; byteSize: number; displayName: string } | null;
    };

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });

async function load(ownerId: string, draftId: string): Promise<Loaded> {
  const config = readTikTokConfig();
  if (!config) return { ok: false, response: json({ error: "TikTok publishing isn't available right now." }, 503) };
  const admin = createAdminClient();
  const draft = await getSocialDraft(admin, ownerId, draftId);
  if (!draft || draft.channel !== "tiktok") return { ok: false, response: json({ error: "That content was not found." }, 404) };
  if (draft.queueStatus === "posting" || draft.queueStatus === "provider_processing" || draft.queueStatus === "published") {
    return { ok: false, response: json({ error: "TikTok already has this video, so it can't be changed here." }, 409) };
  }

  const { data: connection, error: connectionError } = await admin.from("tiktok_connections")
    .select("status,scopes").eq("owner_user_id", ownerId).maybeSingle();
  if (connectionError) return { ok: false, response: json({ error: "Voom couldn't check your TikTok connection. Please retry." }, 503) };
  if (!connection || connection.status !== "connected") {
    return { ok: false, response: json({ error: "Connect your TikTok account to post this video.", code: "tiktok_not_connected" }, 409) };
  }
  if (!hasPublishPermission(Array.isArray(connection.scopes) ? connection.scopes as string[] : [])) {
    return { ok: false, response: json({ error: "Reconnect TikTok and allow video posting to continue.", code: "tiktok_permission_required" }, 409) };
  }

  const client = new TikTokClient(config);
  let openId: string;
  let creator: TikTokCreatorOptions;
  try {
    const credentials = await getTikTokServerCredentials(admin, ownerId, tikTokKeyRing(config), client);
    openId = credentials.openId;
    creator = toTikTokCreatorOptions(await client.queryCreatorInfo(credentials.accessToken));
  } catch (reason) {
    if (reason instanceof TikTokApiError && reason.kind === "rate_limited") {
      return { ok: false, response: json({ error: "TikTok is busy right now. Please try again in a minute." }, 503) };
    }
    if ((reason instanceof TikTokApiError && reason.kind === "auth") || (reason instanceof Error && reason.message === "tiktok_token_refresh_failed")) {
      return { ok: false, response: json({ error: "Your TikTok connection has expired. Reconnect TikTok to continue.", code: "tiktok_reconnect" }, 409) };
    }
    return { ok: false, response: json({ error: "Voom couldn't reach TikTok for your account details. Please retry." }, 503) };
  }
  if (!creator.privacyOptions.length) {
    return { ok: false, response: json({ error: "TikTok isn't letting this account post right now. Check the account in TikTok and try again." }, 409) };
  }

  const { data: asset, error: assetError } = await admin.from("post_draft_assets")
    .select("storage_path,mime_type,byte_size,status,display_name").eq("owner_user_id", ownerId).eq("draft_id", draftId).maybeSingle();
  if (assetError) return { ok: false, response: json({ error: "Voom couldn't load the video. Please retry." }, 503) };
  const byteSize = asset ? Number(asset.byte_size) : NaN;
  const usable = asset && asset.status === "uploaded" && typeof asset.storage_path === "string" && Number.isFinite(byteSize) && byteSize > 0;
  return {
    ok: true,
    draft,
    config,
    openId,
    creator,
    asset: usable ? {
      storagePath: String(asset.storage_path),
      mimeType: String(asset.mime_type ?? ""),
      byteSize,
      displayName: String(asset.display_name ?? "Video"),
    } : null,
  };
}

async function trustedStoredDuration(storagePath: string, expectedBytes: number): Promise<number | null> {
  try {
    const { data, error } = await createAdminClient().storage.from(ASSET_BUCKET).createSignedUrl(storagePath, PREVIEW_TTL_SECONDS);
    if (error || !data?.signedUrl) return null;
    return inspectTikTokVideoDurationFromUrl(data.signedUrl, expectedBytes);
  } catch {
    return null;
  }
}

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "That content was not found." }, 404);
  try {
    const loaded = await load(user.id, id);
    if (!loaded.ok) return loaded.response;
    let previewUrl: string | null = null;
    if (loaded.asset) {
      const { data } = await createAdminClient().storage.from(ASSET_BUCKET).createSignedUrl(loaded.asset.storagePath, PREVIEW_TTL_SECONDS);
      previewUrl = data?.signedUrl ?? null;
    }
    return json({
      creator: loaded.creator,
      appAudited: loaded.config.appAudited,
      caption: loaded.draft.caption,
      scheduledAt: loaded.draft.scheduledAt,
      settings: loaded.draft.tiktokPost?.settings ?? null,
      video: loaded.asset ? {
        previewUrl,
        mimeType: loaded.asset.mimeType,
        displayName: loaded.asset.displayName,
        publishable: isTikTokPublishableMime(loaded.asset.mimeType),
      } : null,
    });
  } catch {
    return json({ error: "Voom couldn't prepare this TikTok post. Please retry." }, 503);
  }
}

const postSchema = z.object({
  caption: z.string().trim().min(1).max(TIKTOK_TITLE_MAX),
  privacy: z.enum(["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "FOLLOWER_OF_CREATOR", "SELF_ONLY"]),
  allowComment: z.boolean(),
  allowDuet: z.boolean(),
  allowStitch: z.boolean(),
  commercial: z.boolean(),
  yourBrand: z.boolean(),
  brandedContent: z.boolean(),
  aiGenerated: z.boolean(),
  /** null posts as soon as the TikTok queue runs (within about 5 minutes). */
  scheduledAt: z.string().datetime({ offset: true }).nullable(),
  /** Required from a playable preview; re-checked server-side against the creator's live maximum. */
  videoDurationSec: z.number().finite().positive().max(86_400),
  /** The owner's express consent to this upload. Nothing else counts. */
  consent: z.literal(true),
}).strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return json({ error: "Please log in again." }, 401);
  const { id } = await params;
  if (!UUID_RE.test(id)) return json({ error: "That content was not found." }, 404);

  let body: unknown;
  try { body = await request.json(); } catch { return json({ error: "That request was not valid." }, 400); }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    const invalidDuration = parsed.error.issues.some((issue) => issue.path[0] === "videoDurationSec");
    return invalidDuration
      ? json({ error: "Voom couldn't verify this video's duration. Reload the preview before posting.", code: "video_duration_required" }, 400)
      : json({ error: "Review the TikTok post details and confirm before posting." }, 400);
  }
  const input = parsed.data;
  const scheduledAt = input.scheduledAt ?? new Date().toISOString();
  if (input.scheduledAt && Date.parse(input.scheduledAt) < Date.now() - 5 * 60_000) {
    return json({ error: "Choose a time in the future, or post now." }, 400);
  }

  try {
    const loaded = await load(user.id, id);
    if (!loaded.ok) return loaded.response;
    if (!loaded.asset) return json({ error: "Attach the video before posting to TikTok." }, 409);
    if (!isTikTokPublishableMime(loaded.asset.mimeType)) return json({ error: "TikTok accepts MP4, WebM or MOV videos." }, 409);

    const trustedDuration = await trustedStoredDuration(loaded.asset.storagePath, loaded.asset.byteSize);
    const durationCheck = validateTikTokVideoDuration({
      trustedDurationSeconds: trustedDuration,
      reportedDurationSeconds: input.videoDurationSec,
      maxDurationSeconds: loaded.creator.maxVideoPostDurationSec,
    });
    if (!durationCheck.ok) {
      if (durationCheck.code === "video_too_long") {
        return json({ error: `This video is longer than this TikTok account can post (${loaded.creator.maxVideoPostDurationSec} seconds maximum).`, code: durationCheck.code }, 400);
      }
      return json({
        error: durationCheck.code === "video_duration_mismatch"
          ? "The video changed after its preview loaded. Reload the preview before posting."
          : "Voom couldn't independently verify this video's duration. Use a valid MP4 or MOV video and try again.",
        code: durationCheck.code,
      }, 400);
    }

    const settings = {
      privacy: input.privacy,
      allowComment: input.allowComment,
      allowDuet: input.allowDuet,
      allowStitch: input.allowStitch,
      commercial: input.commercial,
      // The two disclosure choices only exist while the disclosure switch is on.
      yourBrand: input.commercial && input.yourBrand,
      brandedContent: input.commercial && input.brandedContent,
      aiGenerated: input.aiGenerated,
    };
    const check = checkTikTokPostSettings(settings, loaded.creator, {
      appAudited: loaded.config.appAudited,
      // The shared settings validator receives only server-inspected media truth.
      videoDurationSec: durationCheck.durationSeconds,
    });
    if (!check.ok) return json({ error: check.message, code: check.code }, 400);

    const confirmed = { ...settings, privacy: check.privacy };
    const fields = tiktokPostFields(confirmed);
    const consent: TikTokPostConsent = {
      version: TIKTOK_POST_CONSENT_VERSION,
      settings: confirmed,
      creatorOpenId: loaded.openId,
      creatorNickname: loaded.creator.nickname,
      declaration: tiktokDeclaration(confirmed).kind,
      consentedAt: new Date().toISOString(),
      videoDurationSec: durationCheck.durationSeconds,
      fingerprint: tiktokConsentFingerprint({
        draftId: id,
        creatorOpenId: loaded.openId,
        title: tiktokQueueTitle(input.caption, loaded.draft.title),
        ...fields,
        assetStoragePath: loaded.asset.storagePath,
        assetByteSize: loaded.asset.byteSize,
        videoDurationSec: durationCheck.durationSeconds,
      }),
    };

    const draft = await updateSocialDraft(createAdminClient(), user.id, id, {
      caption: input.caption,
      scheduledAt,
      decision: "approved",
      tiktokPostConsent: consent,
    });
    if (!draft) return json({ error: "That content was not found." }, 404);
    return json({
      draft,
      message: input.scheduledAt
        ? "Confirmed. Voom will send this video to TikTok at the time you chose. It may take a few minutes to appear on your profile after TikTok processes it."
        : "Confirmed. Voom will send this video to TikTok within about 5 minutes. It may take a few more minutes to appear on your profile after TikTok processes it.",
    });
  } catch (reason) {
    const code = reason instanceof Error ? reason.message : "";
    if (code === "social_draft_provider_owned") {
      return json({ error: "TikTok already has this video, so it can't be changed here." }, 409);
    }
    if (code.includes("publish_enqueue_failed") || code === "social_calendar_sync_failed") {
      return json({ error: "Your confirmation was saved, but Voom couldn't confirm the TikTok queue. Nothing was posted. Please retry." }, 503);
    }
    return json({ error: "Voom couldn't save this TikTok post. Nothing was posted. Please retry." }, 503);
  }
}
