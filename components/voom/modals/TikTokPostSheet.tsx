"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Btn, Field, Input, Textarea } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot } from "@/components/voom/ui/Modal";
import {
  checkTikTokPostSettings,
  EMPTY_TIKTOK_POST_SETTINGS,
  TIKTOK_BRANDED_CONTENT_NOT_PRIVATE,
  TIKTOK_BRANDED_CONTENT_POLICY_URL,
  TIKTOK_COMMERCIAL_CHOICE_REQUIRED,
  TIKTOK_MUSIC_USAGE_URL,
  TIKTOK_UNAUDITED_PRIVATE_ONLY,
  isTikTokVideoPreviewReady,
  tiktokCommercialLabel,
  tiktokDeclaration,
  tiktokPrivacyChoices,
  type TikTokCreatorOptions,
  type TikTokPostSettings,
} from "@/lib/tiktok/post-settings";
import { TIKTOK_TITLE_MAX } from "@/lib/tiktok/publishing";

/**
 * "Post to TikTok" — the review-and-confirm step TikTok's Content Sharing
 * Guidelines require before Voom sends a video:
 *
 *   - which TikTok account receives it (the creator's nickname, live);
 *   - a preview of the video and an editable caption;
 *   - who can view it, chosen manually from the options TikTok returned for
 *     this account — there is no default;
 *   - Comment / Duet / Stitch, unchecked by default and unavailable when the
 *     account turned them off in TikTok;
 *   - the commercial content disclosure ("Your brand" / "Branded content")
 *     and the label TikTok will show;
 *   - TikTok's Music Usage Confirmation (and Branded Content Policy)
 *     declaration, and an explicit confirmation before anything is sent.
 *
 * Every rule comes from lib/tiktok/post-settings, which the server re-runs
 * against live creator info before it records the consent.
 */

interface SheetData {
  creator: TikTokCreatorOptions;
  appAudited: boolean;
  caption: string;
  scheduledAt: string | null;
  settings: TikTokPostSettings | null;
  video: { previewUrl: string | null; mimeType: string; displayName: string; publishable: boolean } | null;
}

function toLocalInput(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime()) || date.getTime() < Date.now()) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function Check({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
  label: string;
  hint?: string | null;
}) {
  return (
    <label className={`flex items-start gap-2.5 text-[13px] ${disabled ? "opacity-55" : ""}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-[3px] h-4 w-4 accent-[var(--brand)]"
      />
      <span>
        <span className="font-semibold text-text">{label}</span>
        {hint ? <span className="block text-xs leading-relaxed text-text-3">{hint}</span> : null}
      </span>
    </label>
  );
}

export function TikTokPostSheet({
  draftId,
  onCancel,
  onPosted,
}: {
  draftId: string;
  onCancel: () => void;
  onPosted: (message: string) => void;
}) {
  const [data, setData] = useState<SheetData | null>(null);
  const [loadError, setLoadError] = useState("");
  const [caption, setCaption] = useState("");
  const [settings, setSettings] = useState<TikTokPostSettings>(EMPTY_TIKTOK_POST_SETTINGS);
  const [when, setWhen] = useState<"now" | "schedule">("now");
  const [schedule, setSchedule] = useState("");
  const [duration, setDuration] = useState<number | null>(null);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "error">("loading");
  const [previewError, setPreviewError] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoadError("");
    try {
      const response = await fetch(`/api/social-drafts/${draftId}/tiktok-post`, { cache: "no-store" });
      const body = await response.json() as SheetData & { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Voom couldn't prepare this TikTok post.");
      setData(body);
      setDuration(null);
      setPreviewState(body.video?.previewUrl ? "loading" : "error");
      setPreviewError(body.video?.previewUrl ? "" : "The video preview isn't available. Reload before posting to TikTok.");
      setCaption(body.caption ?? "");
      // A previous confirmation pre-fills the choices; a first post starts empty.
      setSettings(body.settings ?? EMPTY_TIKTOK_POST_SETTINGS);
      const scheduled = toLocalInput(body.scheduledAt);
      setWhen(scheduled ? "schedule" : "now");
      setSchedule(scheduled);
    } catch (reason) {
      setLoadError(reason instanceof Error ? reason.message : "Voom couldn't prepare this TikTok post.");
    }
  }, [draftId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);

  const set = (patch: Partial<TikTokPostSettings>) => {
    setConfirmed(false);
    setSettings((current) => {
      const next = { ...current, ...patch };
      if (!next.commercial) { next.yourBrand = false; next.brandedContent = false; }
      // Branded content can't be private: clear a private choice rather than keep an invalid one.
      if (next.commercial && next.brandedContent && next.privacy === "SELF_ONLY") next.privacy = null;
      return next;
    });
  };

  const choices = useMemo(
    () => data ? tiktokPrivacyChoices(data.creator, { appAudited: data.appAudited, brandedContent: settings.commercial && settings.brandedContent }) : [],
    [data, settings.commercial, settings.brandedContent],
  );
  const check = data ? checkTikTokPostSettings(settings, data.creator, { appAudited: data.appAudited, videoDurationSec: duration }) : null;
  const declaration = tiktokDeclaration(settings);
  const label = tiktokCommercialLabel(settings);
  const scheduleValid = when === "now" || schedule !== "";
  const canPost = Boolean(
    data?.video?.publishable
    && data.video
    && isTikTokVideoPreviewReady(previewState, duration)
    && caption.trim()
    && check?.ok
    && scheduleValid
    && confirmed
    && !busy,
  );
  // Branded content needs a visibility other than private; until Voom's app is audited TikTok only allows private.
  const brandedUnavailable = Boolean(data && !data.appAudited);

  async function post() {
    if (!data || !canPost) return;
    if (when === "schedule" && new Date(schedule).getTime() <= Date.now()) {
      setError("Choose a time in the future, or post now.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`/api/social-drafts/${draftId}/tiktok-post`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          caption: caption.trim(),
          ...settings,
          scheduledAt: when === "schedule" ? new Date(schedule).toISOString() : null,
          videoDurationSec: duration,
          consent: true,
        }),
      });
      const body = await response.json() as { message?: string; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Voom couldn't save this TikTok post. Nothing was posted.");
      onPosted(body.message ?? "Confirmed. Voom will send this video to TikTok.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't save this TikTok post. Nothing was posted.");
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <>
        <ModalBody>
          {loadError
            ? <div role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{loadError}</div>
            : <p className="text-sm text-text-3">Checking your TikTok account…</p>}
        </ModalBody>
        <ModalFoot className="justify-between">
          <Btn variant="ghost" onClick={onCancel}>Back</Btn>
          {loadError ? <Btn variant="outline" onClick={() => void load()}>Try again</Btn> : null}
        </ModalFoot>
      </>
    );
  }

  const creator = data.creator;
  const accountName = creator.nickname || (creator.username ? `@${creator.username}` : "your TikTok account");

  return (
    <>
      <ModalBody>
        <div className="mb-4 flex items-center gap-3 rounded-[14px] border border-line bg-surface-2 p-3">
          {creator.avatarUrl
            // eslint-disable-next-line @next/next/no-img-element -- TikTok's own short-lived avatar URL
            ? <img src={creator.avatarUrl} alt="" className="h-10 w-10 rounded-full object-cover" referrerPolicy="no-referrer" />
            : <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-surface text-sm font-semibold">TT</span>}
          <div className="min-w-0">
            <div className="text-[12px] text-text-3">Posting to TikTok as</div>
            <div className="truncate text-[14px] font-semibold text-text">
              {accountName}{creator.username && creator.nickname ? <span className="font-normal text-text-3"> · @{creator.username}</span> : null}
            </div>
          </div>
        </div>

        {!data.appAudited ? (
          <div role="status" className="mb-4 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber">
            {TIKTOK_UNAUDITED_PRIVATE_ONLY} You can change the visibility in TikTok later.
          </div>
        ) : null}

        <div className="mb-4">
          <span className="mb-1.5 block text-[12.5px] font-semibold tracking-[0.01em] text-text-2">Preview</span>
          {data.video?.previewUrl ? (
            <video
              controls
              playsInline
              preload="metadata"
              src={data.video.previewUrl}
              onLoadStart={() => {
                setDuration(null);
                setPreviewState("loading");
                setPreviewError("");
              }}
              onLoadedMetadata={(e) => {
                const seconds = e.currentTarget.duration;
                if (!Number.isFinite(seconds) || seconds <= 0) {
                  setDuration(null);
                  setPreviewState("error");
                  setPreviewError("Voom couldn't verify this video's duration. Reload or attach a different video.");
                  return;
                }
                setDuration(seconds);
              }}
              onCanPlay={(e) => {
                const seconds = e.currentTarget.duration;
                if (!Number.isFinite(seconds) || seconds <= 0) return;
                setDuration(seconds);
                setPreviewState("ready");
                setPreviewError("");
              }}
              onError={() => {
                setDuration(null);
                setPreviewState("error");
                setPreviewError("Voom couldn't load this video preview. Reload or attach a different video before posting.");
              }}
              className="max-h-72 w-full rounded-lg bg-black object-contain"
            />
          ) : (
            <p className="rounded-xl border border-line bg-surface-2 px-3.5 py-2.5 text-sm text-text-3">
              {data.video ? "The preview isn't available right now." : "Attach a video to this draft before posting it to TikTok."}
            </p>
          )}
          {data.video && !data.video.publishable ? (
            <p className="mt-1.5 text-xs text-red">TikTok accepts MP4, WebM or MOV videos.</p>
          ) : null}
          {previewError ? <p role="alert" className="mt-1.5 text-xs text-red">{previewError}</p> : null}
        </div>

        <Field label="Caption" hint={`Shown with your video on TikTok. Up to ${TIKTOK_TITLE_MAX} characters.`}>
          <Textarea rows={3} value={caption} maxLength={TIKTOK_TITLE_MAX} onChange={(e) => { setConfirmed(false); setCaption(e.target.value); }} />
        </Field>

        <Field label="Who can view this video">
          <select
            value={settings.privacy ?? ""}
            onChange={(e) => set({ privacy: (e.target.value || null) as TikTokPostSettings["privacy"] })}
            className="w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
          >
            <option value="" disabled>Select who can view</option>
            {choices.map((choice) => (
              <option key={choice.value} value={choice.value} disabled={choice.disabled}>
                {choice.label}{choice.disabled ? " (not available)" : ""}
              </option>
            ))}
          </select>
          {settings.commercial && settings.brandedContent
            ? <span className="mt-1.5 block text-xs leading-relaxed text-text-3">{TIKTOK_BRANDED_CONTENT_NOT_PRIVATE}</span>
            : null}
        </Field>

        <div className="mb-4">
          <span className="mb-1.5 block text-[12.5px] font-semibold tracking-[0.01em] text-text-2">Allow users to</span>
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            <Check label="Comment" checked={settings.allowComment} disabled={creator.commentDisabled} onChange={(v) => set({ allowComment: v })} hint={creator.commentDisabled ? "Turned off in your TikTok settings" : null} />
            <Check label="Duet" checked={settings.allowDuet} disabled={creator.duetDisabled} onChange={(v) => set({ allowDuet: v })} hint={creator.duetDisabled ? "Turned off in your TikTok settings" : null} />
            <Check label="Stitch" checked={settings.allowStitch} disabled={creator.stitchDisabled} onChange={(v) => set({ allowStitch: v })} hint={creator.stitchDisabled ? "Turned off in your TikTok settings" : null} />
          </div>
        </div>

        <div className="mb-4 rounded-[14px] border border-line bg-surface-2 p-3.5">
          <label className="flex items-start justify-between gap-3">
            <span>
              <span className="block text-[13px] font-semibold text-text">Disclose video content</span>
              <span className="block text-xs leading-relaxed text-text-3">
                Turn on to disclose that this video promotes goods or services in exchange for something of value. Your video could promote yourself, a third party, or both.
              </span>
            </span>
            <input
              type="checkbox"
              role="switch"
              aria-checked={settings.commercial}
              checked={settings.commercial}
              onChange={(e) => set({ commercial: e.target.checked })}
              className="mt-1 h-4 w-4 accent-[var(--brand)]"
            />
          </label>
          {settings.commercial ? (
            <div className="mt-3 space-y-2.5 border-t border-line pt-3">
              <Check
                label="Your brand"
                checked={settings.yourBrand}
                onChange={(v) => set({ yourBrand: v })}
                hint="You are promoting yourself or your own business. This video will be classified as Brand Organic."
              />
              <Check
                label="Branded content"
                checked={settings.brandedContent}
                disabled={brandedUnavailable}
                onChange={(v) => set({ brandedContent: v })}
                hint={brandedUnavailable
                  ? `You are promoting another brand or a third party. ${TIKTOK_BRANDED_CONTENT_NOT_PRIVATE} It becomes available once TikTok allows public posts from Voom.`
                  : "You are promoting another brand or a third party. This video will be classified as Branded Content."}
              />
              {label ? <p className="text-xs text-text-2">Your video will be labeled &ldquo;{label}&rdquo;.</p> : null}
              {!settings.yourBrand && !settings.brandedContent ? <p className="text-xs text-amber">{TIKTOK_COMMERCIAL_CHOICE_REQUIRED}</p> : null}
            </div>
          ) : null}
        </div>

        <div className="mb-4">
          <Check
            label="AI-generated content"
            checked={settings.aiGenerated}
            onChange={(v) => set({ aiGenerated: v })}
            hint="Adds TikTok's AI-generated label. Turn this on if the video was made or substantially edited with AI."
          />
        </div>

        <div className="mb-4">
          <span className="mb-1.5 block text-[12.5px] font-semibold tracking-[0.01em] text-text-2">When</span>
          <div className="flex flex-wrap gap-x-6 gap-y-2 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="radio" name="tiktok-when" checked={when === "now"} onChange={() => { setConfirmed(false); setWhen("now"); }} className="accent-[var(--brand)]" />
              Post now
            </label>
            <label className="flex items-center gap-2">
              <input type="radio" name="tiktok-when" checked={when === "schedule"} onChange={() => { setConfirmed(false); setWhen("schedule"); }} className="accent-[var(--brand)]" />
              Schedule
            </label>
          </div>
          {when === "schedule" ? (
            <Input className="mt-2" type="datetime-local" value={schedule} onChange={(e) => { setConfirmed(false); setSchedule(e.target.value); }} aria-label="Scheduled time" />
          ) : null}
        </div>

        {check && !check.ok && ["video_duration_required", "creator_video_limit_unavailable", "video_too_long"].includes(check.code) ? (
          <div role="alert" className="mb-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] text-red">{check.message}</div>
        ) : null}

        <div className="rounded-[14px] border border-line bg-surface-2 p-3.5">
          <p className="mb-3 text-[12.5px] leading-relaxed text-text-2">
            {declaration.kind === "music_and_branded" ? (
              <>By posting, you agree to TikTok&apos;s <a className="underline" href={TIKTOK_BRANDED_CONTENT_POLICY_URL} target="_blank" rel="noreferrer">Branded Content Policy</a> and <a className="underline" href={TIKTOK_MUSIC_USAGE_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>
            ) : (
              <>By posting, you agree to TikTok&apos;s <a className="underline" href={TIKTOK_MUSIC_USAGE_URL} target="_blank" rel="noreferrer">Music Usage Confirmation</a>.</>
            )}
          </p>
          <Check
            label={`I've reviewed this video and want Voom to post it to ${accountName}.`}
            checked={confirmed}
            onChange={setConfirmed}
            hint="Voom sends nothing to TikTok without this confirmation. After it's sent, TikTok may take a few minutes to process the video before it appears on your profile."
          />
        </div>

        {error ? <div role="alert" className="mt-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" disabled={busy} onClick={onCancel}>Back</Btn>
        <Btn variant="primary" disabled={!canPost} onClick={() => void post()}>
          {busy ? "Saving…" : when === "now" ? "Post to TikTok" : "Schedule on TikTok"}
        </Btn>
      </ModalFoot>
    </>
  );
}
