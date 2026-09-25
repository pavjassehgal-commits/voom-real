"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs expire and must bypass the public image optimizer */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useModal } from "@/lib/voom/modal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { Icon } from "@/components/voom/icons";
import { Btn, Input, Tag } from "@/components/voom/ui/primitives";
import { ChannelPill, Disclosure, ProgressDots, StatePill } from "@/components/voom/workspace/ui";
import type { WorkflowView, WorkflowSnapshot } from "@/lib/voom/workflow/read";
import { planItemActions, type PlanAction, type PlanItemFacts, type WorkflowMode } from "@/lib/voom/workflow/next-actions";
import { MEDIA_GENERATION_HARD_TIMEOUT_MINUTES } from "@/lib/voom/workflow/state";
import { classifyReelProduction } from "@/lib/mara/reel-production";
import { currentScheduleDate, minScheduleTime } from "@/lib/voom/schedule-guard";
import { formatLocalTimeInput } from "@/lib/voom/timezone";
import { channelIdentity, workflowTone } from "@/lib/voom/workflow/presentation";
import {
  approvePlanItem,
  cancelPlanItemSchedule,
  choosePlanItemProduction,
  postPlanItemNow,
  producePlanItemMedia,
  reschedulePlanItem,
} from "@/lib/voom/workflow/actions-server";

/**
 * ONE Marketing Plan row = the ONE complete workflow for that item.
 *
 * The row derives its stage, headline, actions and explanation from the SAME
 * pure engine (lib/voom/workflow/next-actions.ts) the other screens use, over
 * the SAME shared snapshot rows — so Marketing Plan, Today, Approvals and the
 * Content Calendar can never disagree. Every action advances the SAME item in
 * place via the server actions; nothing creates a duplicate draft.
 *
 * Presentation: the row is deliberately dense (channel · concept · time ·
 * state · next action) so a seven-day plan reads as a timeline rather than
 * seven screens of cards. Everything secondary — MARA's reasoning, the
 * produced-visual preview, rescheduling and destructive options — lives behind
 * a native <details> disclosure, which also keeps the mobile layout compact.
 */

export function PlanItemCard(props: {
  item: WorkflowView;
  mode: WorkflowMode;
  timeZone: string;
  onChanged: (snapshot: WorkflowSnapshot) => void;
}) {
  return props.item.channel === "instagram"
    ? <InstagramPlanItemCard {...props} />
    : <NativeSocialPlanItemCard {...props} />;
}

/** How close this exact item is to being publishable, from its own real fields. */
export function readinessSteps(item: WorkflowView): { label: string; done: boolean }[] {
  const approved = ["scheduled", "publishing", "published", "missed"].includes(item.status);
  const scheduled = Boolean(item.publishAt) && approved;
  if (item.channel === "instagram") {
    return [
      { label: "Concept", done: Boolean(item.concept) },
      { label: "Visual", done: item.hasMedia },
      { label: "Approved", done: approved },
      { label: "Scheduled", done: scheduled },
    ];
  }
  return [
    { label: "Concept", done: Boolean(item.concept) },
    { label: "Video", done: item.hasMedia },
    { label: "Approved", done: approved },
    { label: "Scheduled", done: scheduled },
  ];
}

function InstagramPlanItemCard({
  item, mode, timeZone, onChanged,
}: {
  item: WorkflowView;
  mode: WorkflowMode;
  timeZone: string;
  onChanged: (snapshot: WorkflowSnapshot) => void;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [messageTone, setMessageTone] = useState<"ok" | "error">("ok");
  const [rescheduling, setRescheduling] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const production = item.format === "reel" ? reelProductionFacts(item) : null;
  const resolved: PlanItemFacts = {
    contentType: item.format as "post" | "reel" | "story",
    stage: item.status,
    failedStage: item.failedStage,
    mode,
    publishAt: item.publishAt || null,
    dayLabel: item.dayLabel,
    localTime: item.localTime,
    hasMedia: item.hasMedia,
    mediaFromMara: item.mediaFromMara,
    mediaStatus: item.mediaStatus,
    production,
  };
  const resolved2 = planItemActions(resolved);

  // While MARA is generating (or the worker is publishing, or the schedule is
  // held waiting for media) this card lazily refreshes the shared snapshot so
  // the stage advances in place — e.g. the visual arrives and the item moves
  // from Waiting for media to Scheduled on its own.
  const polling =
    item.status === "generating" || item.status === "publishing"
    || item.status === "waiting_for_media" || item.status === "media_delayed";
  useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch("/api/plan", { cache: "no-store" });
        const body = await response.json() as { snapshot?: WorkflowSnapshot };
        if (!cancelled && body.snapshot) onChanged(body.snapshot);
      } catch { /* transient — keep polling */ }
    }, 8000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [polling, onChanged]);

  async function run(key: string, effect: () => Promise<{ ok: boolean; message?: string; error?: string }>) {
    setBusy(key); setMessage("");
    try {
      const result = await effect();
      setMessageTone(result.ok ? "ok" : "error");
      setMessage(result.ok ? result.message ?? "Done." : result.error ?? "Voom couldn't complete that safely.");
      if (result.ok) {
        const response = await fetch("/api/plan", { cache: "no-store" });
        const body = await response.json() as { snapshot?: WorkflowSnapshot };
        if (body.snapshot) onChanged(body.snapshot);
        window.dispatchEvent(new Event("voom:data-changed"));
      }
    } catch {
      setMessageTone("error");
      setMessage("Voom couldn't reach the server. Please retry.");
    }
    setBusy(null);
  }

  function actionButton(action: PlanAction, dense?: boolean) {
    const busyNow = busy === action.id;
    const size = dense ? "sm" : "sm";
    if (action.disabled) {
      return <span key={action.id} className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text-3 line-through" title={action.disabledReason}>{action.label}</span>;
    }
    if (action.id === "film_yourself") {
      return <Btn key={action.id} variant={action.tone === "primary" ? "primary" : "outline"} size={size} disabled={busy !== null} onClick={() => void run(action.id, () => choosePlanItemProduction(item.draftId, "film_yourself"))}>
        {action.label}
      </Btn>;
    }
    if (action.id === "upload_asset") {
      return <Btn key={action.id} variant="outline" size={size} disabled={busy !== null} onClick={() => fileRef.current?.click()}>{action.label}</Btn>;
    }
    if (action.id === "approve_schedule") {
      return <Btn key={action.id} variant="primary" size={size} disabled={busy !== null} onClick={() => void run(action.id, () => approvePlanItem(item.draftId))}><Icon name="check" size={13} /> {action.label}</Btn>;
    }
    if (action.id === "open_approvals") {
      return <Link key={action.id} href="/app/approvals" className="inline-flex"><Btn variant="primary" size={size}>Open Approvals</Btn></Link>;
    }
    if (action.id === "produce_with_mara" || action.id === "regenerate_media" || action.id === "retry_media") {
      const regenerate = action.id === "regenerate_media";
      return <Btn key={action.id} variant={action.tone === "primary" ? "primary" : "outline"} size={size} disabled={busy !== null} onClick={() => void run(action.id, () => producePlanItemMedia(item.draftId, { regenerate }))}>
        {/* The busy label stays neutral: whether this click starts a NEW generation
            or only re-checks the existing job is decided server-side, and the
            message below reports what actually happened. */}
        <Icon name="spark" size={13} /> {busyNow ? "Working…" : action.label}
      </Btn>;
    }
    if (action.id === "change_time" || action.id === "reschedule") {
      return <Btn key={action.id} variant="outline" size={size} disabled={busy !== null} onClick={() => { setRescheduling((value) => !value); setMessage(""); }}>{action.label}</Btn>;
    }
    if (action.id === "post_now") {
      return <Btn key={action.id} variant="primary" size={size} disabled={busy !== null} onClick={() => void run(action.id, () => postPlanItemNow(item.draftId))}><Icon name="bolt" size={13} /> {action.label}</Btn>;
    }
    if (action.id === "cancel_schedule") {
      return <Btn key={action.id} variant="ghost" size={size} className="text-red" disabled={busy !== null} onClick={() => void run(action.id, () => cancelPlanItemSchedule(item.draftId))}><Icon name="trash" size={13} /> {action.label}</Btn>;
    }
    return null;
  }

  const actions = resolved2.actions.filter((action) => action.id !== "choose_production");
  const showPrimary = (action: PlanAction) => action.tone === "primary" && !action.disabled;
  const primaryActions = actions.filter(showPrimary);
  const secondaryActions = actions.filter((action) => !showPrimary(action));

  return (
    <li className="ws-row relative min-w-0 border-l-2 py-2.5 pl-3 pr-1 sm:pl-4" style={{ borderColor: workflowAccentFor(item.status) }}>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ChannelPill channel={item.channel} format={item.format} dense />
          <StatePill status={item.status} label={resolved2.stageLabel} dense />
          <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-text-3">
            <Icon name="clock" size={11} />
            {item.dayLabel} · {item.localTime}
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold leading-snug tracking-[-0.015em] text-text">{item.concept}</p>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-text-3">{resolved2.explanation.what}</p>
            <ProgressDots className="mt-2" steps={readinessSteps(item)} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            {primaryActions.map((action) => actionButton(action))}
            {primaryActions.length === 0 && item.status === "generating" && (
              <span className="inline-flex items-center gap-1.5 text-[12px] font-semibold text-[var(--blue)]">
                <span className="voom-dot-green pulse" aria-hidden="true" /> MARA is working
              </span>
            )}
          </div>
        </div>

        <p className="text-[12.5px] font-semibold leading-relaxed text-text-2">{resolved2.headline}</p>

        {item.status === "waiting_for_media" && <p role="status" className="rounded-xl border border-amber/35 bg-amber/10 px-3 py-2 text-[12px] text-amber">
          Scheduled, but it cannot publish until the visual is ready. Voom is holding the schedule — nothing is published early.
        </p>}
        {item.status === "media_delayed" && <p role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3 py-2 text-[12px] text-red">
          Media generation is delayed, so the schedule is held — Voom will not publish until a real visual exists.
        </p>}
        {item.status === "media_timed_out" && <p role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3 py-2 text-[12px] text-red">
          That generation ran past Voom&apos;s {MEDIA_GENERATION_HARD_TIMEOUT_MINUTES}-minute limit, so it cannot finish on its own and the schedule stays held. Nothing was published and nothing new was charged.
        </p>}
        {item.status === "missed" && <p role="alert" className="rounded-xl border border-amber/35 bg-amber/10 px-3 py-2 text-[12px] text-amber">
          {item.missedReason ?? "Its scheduled time passed without publishing."} Voom never publishes hours late on its own.
        </p>}
        {item.status === "failed" && <p role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3 py-2 text-[12px] text-red">
          {item.failureMessage ?? (item.failedStage === "media" ? "Media generation stopped safely. Nothing was published." : "Publishing stopped safely. Nothing was published twice.")}
        </p>}

        <Disclosure summary="Details, options and MARA's reasoning">
          <div className="grid min-w-0 gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,220px)]">
            <div className="min-w-0 space-y-1.5 text-[12.5px] leading-relaxed text-text-2">
              {resolved2.explanation.why && <ExplainLine icon="spark" label="Why" text={resolved2.explanation.why} />}
              <ExplainLine icon="film" label="Made" text={`${resolved2.explanation.what} · by ${resolved2.explanation.who}`} />
              <ExplainLine icon="clock" label="Publishes" text={resolved2.explanation.when ?? "Not scheduled yet"} />
              <ExplainLine icon="shield" label="Approval" text={resolved2.explanation.approval} />
              <ExplainLine icon="bolt" label="Automatic" text={resolved2.explanation.autoPublish} />
              {item.caption && <p className="line-clamp-4 whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2 text-[12px] leading-relaxed text-text-3">{item.caption}</p>}
            </div>
            {item.mediaPreviewUrl && <div className="min-w-0">
              {item.mediaMimeType?.startsWith("video/")
                ? <video className="w-full rounded-xl border border-line object-cover" style={{ aspectRatio: "9 / 16" }} src={item.mediaPreviewUrl} muted playsInline controls preload="metadata" />
                : <img className="w-full rounded-xl border border-line object-cover" style={{ aspectRatio: item.format === "story" ? "9 / 16" : "1 / 1" }} src={item.mediaPreviewUrl} alt={`Visual for ${item.concept}`} />}
              <p className="mt-1 text-[11px] text-text-3">{item.mediaFromMara ? "Generated by MARA" : "Uploaded by you"} · stored privately in Voom</p>
            </div>}
          </div>

          {secondaryActions.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2">
            {secondaryActions.map((action) => actionButton(action, true))}
          </div>}
        </Disclosure>

        {rescheduling && <RescheduleForm
          timeZone={timeZone}
          defaults={{ date: item.localDate || currentScheduleDate(), time: (item.publishAt ? formatLocalTimeInput(item.publishAt, timeZone) : "") || "18:30" }}
          busy={busy !== null}
          onSubmit={(date, time) => { setRescheduling(false); return run("reschedule", () => reschedulePlanItem(item.draftId, date, time)); }}
          onCancel={() => setRescheduling(false)}
        />}

        {message && <p role="status" className={`text-[12px] ${messageTone === "ok" ? "text-green" : "text-red"}`}>{message}</p>}

        <input ref={fileRef} type="file" className="sr-only" accept={item.format === "post" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime"}
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            const form = new FormData();
            form.set("file", file);
            void run("upload", async () => {
              const response = await fetch(`/api/posts/${item.draftId}/asset`, { method: "POST", body: form });
              const body = await response.json() as { error?: string; message?: string };
              return response.ok ? { ok: true, message: body.message } : { ok: false, error: body.error };
            });
          }} />
      </div>
    </li>
  );
}

function ExplainLine({ icon, label, text }: { icon: string; label: string; text: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <Icon name={icon} size={12} className="mt-[3px] shrink-0 text-text-3" />
      <span className="min-w-0"><b className="font-semibold text-text-3">{label}:</b> {text}</span>
    </span>
  );
}

function NativeSocialPlanItemCard({ item, onChanged }: {
  item: WorkflowView;
  onChanged: (snapshot: WorkflowSnapshot) => void;
}) {
  const { open } = useModal();
  const identity = channelIdentity(item.channel);

  async function refresh() {
    const response = await fetch("/api/plan", { cache: "no-store" });
    const body = await response.json() as { snapshot?: WorkflowSnapshot };
    if (body.snapshot) onChanged(body.snapshot);
  }

  return (
    <li className="ws-row min-w-0 border-l-2 py-2.5 pl-3 pr-1 sm:pl-4" style={{ borderColor: workflowAccentFor(item.status) }}>
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <ChannelPill channel={item.channel} format={item.format} dense />
          <StatePill status={item.status} label={item.statusLabel} dense />
          <span className="inline-flex items-center gap-1 text-[11.5px] font-semibold text-text-3">
            <Icon name="clock" size={11} />
            {item.dayLabel} · {item.localTime}
          </span>
        </div>

        <div className="flex min-w-0 flex-col gap-2.5 lg:flex-row lg:items-start lg:justify-between lg:gap-4">
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold leading-snug tracking-[-0.015em] text-text">{item.concept}</p>
            <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-text-3">
              {item.hasMedia ? "Video attached and ready in Voom" : "No video file attached yet"} · {item.script.length > 0 ? `${item.script.length} script beat${item.script.length === 1 ? "" : "s"}` : "outline not set"}
            </p>
            <ProgressDots className="mt-2" steps={readinessSteps(item)} />
          </div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 lg:justify-end">
            <Btn variant="outline" size="sm" onClick={() => open(<SocialEditorModal draftId={item.draftId} onChanged={() => void refresh()} />)}>
              Open {identity.label} draft
            </Btn>
          </div>
        </div>

        {item.failureMessage && item.status === "failed" && <p role="alert" className="rounded-xl border border-red/35 bg-red/10 px-3 py-2 text-[12px] text-red">{item.failureMessage}</p>}

        <Disclosure summary="Details and draft content">
          <div className="space-y-1.5 text-[12.5px] leading-relaxed text-text-2">
            <span className="block">Source: {item.sourceLabel} · {item.contentTypeLabel}</span>
            {item.description && <span className="line-clamp-3 block">Description: {item.description}</span>}
            {item.caption && <p className="line-clamp-4 whitespace-pre-wrap rounded-xl bg-surface-2 px-3 py-2 text-[12px] text-text-3">{item.caption}</p>}
            <Link href="/app/calendar" className="inline-flex items-center gap-1 pt-1 text-[12px] font-semibold text-brand hover:underline">
              See it on the Content Calendar <Icon name="arrow" size={12} />
            </Link>
          </div>
        </Disclosure>
      </div>
    </li>
  );
}

function workflowAccentFor(status: string): string {
  const tone = workflowTone(status);
  if (tone === "green") return "var(--green)";
  if (tone === "amber") return "var(--amber)";
  if (tone === "red") return "var(--red)";
  if (tone === "blue") return "var(--blue)";
  return "transparent";
}

function RescheduleForm({ timeZone, defaults, busy, onSubmit, onCancel }: {
  timeZone: string;
  defaults: { date: string; time: string };
  busy: boolean;
  onSubmit: (date: string, time: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(defaults.date);
  const [time, setTime] = useState(defaults.time);
  const [error, setError] = useState("");
  const minTime = minScheduleTime(date, new Date(), timeZone);
  return <div className="rounded-xl border border-line bg-surface-2 p-3.5">
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[11.5px] font-semibold text-text-3">Date<Input type="date" className="mt-1 w-[148px]" value={date} min={currentScheduleDate()} onChange={(event) => setDate(event.currentTarget.value)} /></label>
      <label className="text-[11.5px] font-semibold text-text-3">Time<Input type="time" className="mt-1 w-[116px]" value={time} min={minTime} onChange={(event) => setTime(event.currentTarget.value)} /></label>
      <Btn variant="primary" size="sm" disabled={busy} onClick={() => {
        if (!date || !time) return setError("Choose a date and a time.");
        setError("");
        void onSubmit(date, time);
      }}>Save time</Btn>
      <Btn variant="ghost" size="sm" disabled={busy} onClick={onCancel}>Cancel</Btn>
    </div>
    <p className="mt-1.5 text-[11px] text-text-3">Times are in your business timezone{timeZone ? ` (${timeZone.replace("_", " ")})` : ""}. Past times are rejected here and on the server.</p>
    {error && <p role="alert" className="mt-1.5 text-[12px] text-red">{error}</p>}
  </div>;
}

/** Reel production facts, preferring the stored action state over re-derivation. */
function reelProductionFacts(item: WorkflowView): PlanItemFacts["production"] {
  if (item.format !== "reel") return null;
  const stored = item.production;
  const derived = classifyReelProduction({ concept: item.concept, script: item.caption });
  return {
    recommendedMethod: stored?.recommendedMethod ?? derived.recommendedMethod,
    availableMethods: stored?.availableMethods ?? derived.availableMethods,
    selectedMethod: stored?.selectedMethod ?? null,
    maraOption: stored?.maraOption ?? derived.maraOption,
    recommendationReason: stored?.recommendedMethod === "film_yourself"
      ? "Authentic real-world footage performs best for this concept."
      : null,
  };
}

/** Kept for the shared status vocabulary: identical tone mapping everywhere. */
export function stageTone(status: string): string {
  const tone = workflowTone(status);
  if (tone === "green") return "t-green";
  if (tone === "amber") return "t-amber";
  if (tone === "red") return "t-red";
  if (tone === "blue") return "t-blue";
  return "t-grey";
}

export function StageTag({ status, label }: { status: string; label: string }) {
  return <Tag tone={stageTone(status)}>{label}</Tag>;
}
