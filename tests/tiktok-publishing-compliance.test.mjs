/**
 * TikTok Content Posting API compliance (Content Sharing Guidelines,
 * "Required UX Implementation"): the post-sheet rules, the per-post consent
 * the worker enforces, and the customer-facing wording. Pure logic and source
 * checks — no network, no database.
 */
import "./helpers/server-only-shim.mjs";

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const flat = async (path) => (await read(path)).replace(/\s+/g, " ");

const rules = await import("../lib/tiktok/post-settings.ts");
const consentMod = await import("../lib/tiktok/post-consent.ts");
const flowMod = await import("../lib/tiktok/publish-flow.ts");

const CREATOR = {
  nickname: "Corner Cafe",
  username: "cornercafe",
  avatarUrl: null,
  privacyOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 60,
};
const AUDITED = { appAudited: true, videoDurationSec: 30 };
const UNAUDITED = { appAudited: false, videoDurationSec: 30 };
const settings = (patch = {}) => ({ ...rules.EMPTY_TIKTOK_POST_SETTINGS, ...patch });

test("privacy has no default and comes only from the options TikTok returned for this account", () => {
  assert.equal(rules.EMPTY_TIKTOK_POST_SETTINGS.privacy, null, "nothing is pre-selected");
  assert.equal(rules.checkTikTokPostSettings(settings(), CREATOR, AUDITED).code, "privacy_required");
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "FOLLOWER_OF_CREATOR" }), CREATOR, AUDITED).code,
    "privacy_not_offered",
    "an option TikTok did not return for this account is refused",
  );
  const shown = rules.tiktokPrivacyChoices(CREATOR, { appAudited: true, brandedContent: false }).map((c) => c.value);
  assert.deepEqual(shown, ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"], "only TikTok's own options, in TikTok's order");
});

test("until TikTok audits Voom's app only private (Only me) posts can be chosen or accepted", () => {
  const choices = rules.tiktokPrivacyChoices(CREATOR, { appAudited: false, brandedContent: false });
  assert.deepEqual(choices.filter((c) => !c.disabled).map((c) => c.value), ["SELF_ONLY"]);
  assert.ok(choices.filter((c) => c.disabled).every((c) => c.reason === rules.TIKTOK_UNAUDITED_PRIVATE_ONLY));
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "PUBLIC_TO_EVERYONE" }), CREATOR, UNAUDITED).code, "unaudited_private_only");
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), CREATOR, UNAUDITED).ok, true);
});

test("Comment, Duet and Stitch start unchecked and cannot be enabled when the creator turned them off", () => {
  const base = rules.EMPTY_TIKTOK_POST_SETTINGS;
  assert.deepEqual([base.allowComment, base.allowDuet, base.allowStitch], [false, false, false]);
  const off = { ...CREATOR, commentDisabled: true, duetDisabled: true, stitchDisabled: true };
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY", allowComment: true }), off, AUDITED).code, "comment_disabled_by_creator");
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY", allowDuet: true }), off, AUDITED).code, "duet_disabled_by_creator");
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY", allowStitch: true }), off, AUDITED).code, "stitch_disabled_by_creator");
  // Unknown is treated as "not allowed", never as permission.
  const unknown = rules.toTikTokCreatorOptions({
    creatorNickname: "x", creatorUsername: null, creatorAvatarUrl: null, privacyLevelOptions: ["SELF_ONLY", "BOGUS"],
    commentDisabled: null, duetDisabled: false, stitchDisabled: null, maxVideoPostDurationSec: null,
  });
  assert.deepEqual([unknown.commentDisabled, unknown.duetDisabled, unknown.stitchDisabled], [true, false, true]);
  assert.deepEqual(unknown.privacyOptions, ["SELF_ONLY"], "unrecognised values are dropped");
  // Unchecked boxes are sent as disabled.
  const fields = rules.tiktokPostFields(settings({ privacy: "SELF_ONLY", allowComment: true }));
  assert.deepEqual([fields.disableComment, fields.disableDuet, fields.disableStitch], [false, true, true]);
});

test("commercial disclosure: a choice is required, branded content cannot be private, and the label and declaration follow TikTok's wording", () => {
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "PUBLIC_TO_EVERYONE", commercial: true }), CREATOR, AUDITED).message,
    "You need to indicate if your content promotes yourself, a third party, or both.",
  );
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY", commercial: true, brandedContent: true }), CREATOR, AUDITED).message,
    "Branded content visibility cannot be set to private.",
  );
  const branded = rules.tiktokPrivacyChoices(CREATOR, { appAudited: true, brandedContent: true });
  assert.equal(branded.find((c) => c.value === "SELF_ONLY").disabled, true);

  assert.equal(rules.tiktokCommercialLabel(settings({ commercial: true, yourBrand: true })), "Promotional content");
  assert.equal(rules.tiktokCommercialLabel(settings({ commercial: true, brandedContent: true })), "Paid partnership");
  assert.equal(rules.tiktokCommercialLabel(settings({ commercial: true, yourBrand: true, brandedContent: true })), "Paid partnership");
  assert.equal(rules.tiktokCommercialLabel(settings()), null);

  assert.equal(rules.tiktokDeclaration(settings()).text, "By posting, you agree to TikTok's Music Usage Confirmation.");
  assert.equal(rules.tiktokDeclaration(settings({ commercial: true, yourBrand: true })).text, "By posting, you agree to TikTok's Music Usage Confirmation.");
  assert.equal(
    rules.tiktokDeclaration(settings({ commercial: true, brandedContent: true })).text,
    "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.",
  );

  const yours = rules.tiktokPostFields(settings({ privacy: "PUBLIC_TO_EVERYONE", commercial: true, yourBrand: true }));
  assert.deepEqual([yours.brandOrganicToggle, yours.brandContentToggle], [true, false], "Your brand → brand_organic_toggle");
  const paid = rules.tiktokPostFields(settings({ privacy: "PUBLIC_TO_EVERYONE", commercial: true, brandedContent: true }));
  assert.deepEqual([paid.brandOrganicToggle, paid.brandContentToggle], [false, true], "Branded content → brand_content_toggle");
  const off = rules.tiktokPostFields(settings({ privacy: "PUBLIC_TO_EVERYONE", commercial: false, yourBrand: true, brandedContent: true }));
  assert.deepEqual([off.brandOrganicToggle, off.brandContentToggle], [false, false], "nothing is disclosed while the switch is off");
});

test("unknown, excessive and valid video durations fail closed correctly", () => {
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), CREATOR, { appAudited: true }).code,
    "video_duration_required",
  );
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), CREATOR, { appAudited: true, videoDurationSec: Number.NaN }).code,
    "video_duration_required",
  );
  assert.equal(
    rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), { ...CREATOR, maxVideoPostDurationSec: null }, { appAudited: true, videoDurationSec: 30 }).code,
    "creator_video_limit_unavailable",
  );
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), CREATOR, { appAudited: true, videoDurationSec: 61 }).code, "video_too_long");
  assert.equal(rules.checkTikTokPostSettings(settings({ privacy: "SELF_ONLY" }), CREATOR, { appAudited: true, videoDurationSec: 59.5 }).ok, true);
});

test("a failed or incomplete preview can never unlock the post action", () => {
  assert.equal(rules.isTikTokVideoPreviewReady("loading", null), false);
  assert.equal(rules.isTikTokVideoPreviewReady("error", 30), false, "a failed preview stays blocked even if stale duration exists");
  assert.equal(rules.isTikTokVideoPreviewReady("ready", null), false);
  assert.equal(rules.isTikTokVideoPreviewReady("ready", Number.NaN), false);
  assert.equal(rules.isTikTokVideoPreviewReady("ready", 0), false);
  assert.equal(rules.isTikTokVideoPreviewReady("ready", 30), true);
});

const SUBJECT = {
  draftId: "8d6a1b6e-1111-4111-8111-111111111111",
  creatorOpenId: "open-1",
  title: "Fresh pastries every morning",
  privacyLevel: "SELF_ONLY",
  disableComment: false,
  disableDuet: true,
  disableStitch: true,
  brandContentToggle: false,
  brandOrganicToggle: true,
  isAigc: false,
  assetStoragePath: "owner/post-assets/video.mp4",
  assetByteSize: 4096,
};

function storedConsent(subject = SUBJECT) {
  return {
    version: 1,
    settings: settings({ privacy: "SELF_ONLY", allowComment: true, commercial: true, yourBrand: true }),
    creatorOpenId: subject.creatorOpenId,
    creatorNickname: "Corner Cafe",
    declaration: "music",
    consentedAt: "2026-10-13T10:00:00.000Z",
    fingerprint: consentMod.tiktokConsentFingerprint(subject),
  };
}

test("consent covers exactly the reviewed post: any change to account, caption, settings, disclosure or video makes it stale", () => {
  assert.equal(consentMod.evaluateTikTokPostConsent(storedConsent(), SUBJECT), "valid");
  assert.equal(consentMod.evaluateTikTokPostConsent(undefined, SUBJECT), "missing");
  assert.equal(consentMod.evaluateTikTokPostConsent({ ...storedConsent(), fingerprint: "nope" }, SUBJECT), "missing", "a malformed record is no consent");
  const changes = {
    creatorOpenId: "open-2",
    title: "Edited caption",
    privacyLevel: "PUBLIC_TO_EVERYONE",
    disableComment: true,
    disableDuet: false,
    disableStitch: false,
    brandContentToggle: true,
    brandOrganicToggle: false,
    isAigc: true,
    assetStoragePath: "owner/post-assets/other.mp4",
    assetByteSize: 4097,
  };
  for (const [key, value] of Object.entries(changes)) {
    assert.equal(consentMod.evaluateTikTokPostConsent(storedConsent(), { ...SUBJECT, [key]: value }), "stale", `changing ${key} needs a new confirmation`);
  }
});

function flowPorts(overrides = {}) {
  const calls = [];
  return {
    calls,
    now: () => Date.parse("2026-10-13T10:00:00.000Z"),
    sleep: async () => {},
    async loadDraft() { calls.push("loadDraft"); return { status: "approved" }; },
    async loadConnection() { calls.push("loadConnection"); return { status: "connected", scopes: ["user.info.basic", "video.publish"] }; },
    async loadCredentials() { calls.push("loadCredentials"); return { openId: "open-1", accessToken: "token" }; },
    async loadAsset() { calls.push("loadAsset"); return { status: "uploaded", mimeType: "video/mp4", byteSize: 1024, storagePath: "a/video.mp4" }; },
    async verifyPostConsent() { calls.push("verifyPostConsent"); return overrides.consent ?? "valid"; },
    async queryCreatorInfo() {
      calls.push("queryCreatorInfo");
      return { creatorUsername: "c", creatorNickname: "C", creatorAvatarUrl: null, privacyLevelOptions: ["SELF_ONLY"], commentDisabled: true, duetDisabled: false, stitchDisabled: false, maxVideoPostDurationSec: 60, ...overrides.creator };
    },
    async initDirectPost(_token, metadata) { calls.push("initDirectPost"); this.metadata = metadata; return { publishId: "7364580667079849990", uploadUrl: "https://upload.tiktok.test/x" }; },
    async putChunk(input) { calls.push("putChunk"); const m = /-(\d+)\/\d+$/.exec(input.contentRange); return { outcome: "complete", uploadedBytes: Number(m[1]) + 1 }; },
    async openMediaRange(_p, start, end) { return new Uint8Array(end - start + 1); },
    async fetchPostStatus() { return { status: "PUBLISH_COMPLETE", postIds: [], failReason: null }; },
    async persistPublish() {}, async persistProgress() {}, async recordProviderStatus() {}, async enterProviderProcessing() {},
    async markPublished() {}, async reArmForResubmit() {},
    async markFailed(_item, input) { calls.push(`markFailed:${input.code}:${input.status}`); },
  };
}

const ITEM = {
  id: "q1", ownerUserId: "o1", draftId: "d1", status: "scheduled", title: "Caption", privacyLevel: "SELF_ONLY",
  disableComment: false, disableDuet: false, disableStitch: true, brandContentToggle: false, brandOrganicToggle: false, isAigc: false,
  attempts: 1, publishId: null, uploadUrl: null, contentLength: null, bytesSent: 0, lastAttemptAt: null, providerPostId: null,
};

test("the worker refuses missing or stale consent before contacting TikTok, and parks the item for the owner", async () => {
  for (const consent of ["missing", "stale"]) {
    const ports = flowPorts({ consent });
    const result = await flowMod.runTikTokPublishFlow({ ...ITEM }, ports);
    assert.equal(result.outcome, "failed");
    assert.equal(result.code, "tiktok_post_confirmation_required");
    assert.ok(!ports.calls.includes("queryCreatorInfo") && !ports.calls.includes("initDirectPost"), `${consent}: nothing is sent to TikTok`);
    assert.ok(ports.calls.includes("markFailed:tiktok_post_confirmation_required:needs_declaration"));
  }
  const throwing = flowPorts();
  throwing.verifyPostConsent = async () => { throw new Error("db down"); };
  const failedClosed = await flowMod.runTikTokPublishFlow({ ...ITEM }, throwing);
  assert.equal(failedClosed.code, "tiktok_post_confirmation_required", "an unreadable consent is no consent");
});

test("an interaction the creator has since turned off in TikTok is sent as disabled", async () => {
  const ports = flowPorts();
  const result = await flowMod.runTikTokPublishFlow({ ...ITEM }, ports);
  assert.equal(result.outcome, "published");
  assert.equal(ports.metadata.post_info.disable_comment, true, "the account turned comments off after the owner confirmed");
  assert.equal(ports.metadata.post_info.disable_duet, false, "an allowed interaction stays as confirmed");
});

test("the consent route re-checks everything server-side and accepts only an explicit consent", async () => {
  const route = await read("app/api/social-drafts/[id]/tiktok-post/route.ts");
  assert.match(route, /consent: z\.literal\(true\)/, "consent must be literally true");
  assert.match(route, /\}\)\.strict\(\)/, "no undocumented field (such as a forged consent record) is accepted");
  assert.match(route, /queryCreatorInfo/, "live creator info before recording consent");
  assert.match(route, /checkTikTokPostSettings\(settings, loaded\.creator/, "the same rules as the sheet, against live data");
  assert.match(route, /videoDurationSec: z\.number\(\)\.finite\(\)\.positive\(\)/, "the server requires a finite positive duration");
  assert.match(route, /issue\.path\[0\] === "videoDurationSec"/, "invalid duration receives a specific fail-closed response");
  assert.match(route, /tiktokConsentFingerprint/, "the consent is bound to the exact post");
  assert.doesNotMatch(route, /accessToken[,}]\s*$|refresh_token|upload_url/m, "no token or upload URL in responses");
  const patch = await read("app/api/social-drafts/[id]/route.ts");
  assert.doesNotMatch(patch, /tiktokPostConsent/, "the general edit route cannot record a TikTok consent");
});

test("the post sheet shows everything TikTok requires before an explicit confirmation", async () => {
  const sheet = await flat("components/voom/modals/TikTokPostSheet.tsx");
  assert.match(sheet, /Posting to TikTok as/, "the receiving account is shown");
  assert.match(sheet, /<video/, "the video is previewed");
  assert.match(sheet, /isTikTokVideoPreviewReady\(previewState, duration\)/, "posting stays disabled until the preview is playable");
  assert.match(sheet, /onCanPlay=/, "the browser must confirm the preview can play");
  assert.match(sheet, /onError=/, "preview failures are handled explicitly");
  assert.match(sheet, /role="alert"/, "preview failures are announced clearly");
  assert.match(sheet, /Who can view this video/);
  assert.match(sheet, /<option value="" disabled>Select who can view<\/option>/, "no default privacy");
  assert.match(sheet, /Allow users to/);
  for (const label of ["Comment", "Duet", "Stitch", "Disclose video content", "Your brand", "Branded content"]) {
    assert.match(sheet, new RegExp(`"${label}"|>${label}<`), `${label} control`);
  }
  assert.match(sheet, /Music Usage Confirmation/);
  assert.match(sheet, /Branded Content Policy/);
  assert.match(sheet, /TIKTOK_MUSIC_USAGE_URL/);
  assert.match(sheet, /consent: true/);
  assert.match(sheet, /may take a few minutes to process/, "the user is told processing takes time");
  const editor = await flat("components/voom/modals/SocialEditorModal.tsx");
  assert.match(editor, /TikTokPostSheet/);
  assert.match(editor, /draft\.channel === "tiktok" \? <Btn/, "TikTok drafts are approved only through the post sheet");
  assert.doesNotMatch(editor, /label="Privacy \(required by TikTok\)"/, "the old fixed privacy list is gone");
});

test("the privacy policy describes the live TikTok integration accurately", async () => {
  const privacy = await flat("app/privacy/page.tsx");
  assert.doesNotMatch(privacy, /sandbox/i);
  assert.match(privacy, /user\.info\.basic/);
  assert.match(privacy, /video\.publish/);
  assert.match(privacy, /only after you review and confirm that specific post/);
  assert.match(privacy, /only allows posts from Voom to be visible to you/);
});
