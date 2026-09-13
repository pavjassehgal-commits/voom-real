"use client";
/* eslint-disable @next/next/no-img-element -- private signed URLs expire and must bypass the public image optimizer */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Input, Tag } from "@/components/voom/ui/primitives";
import type { WorkflowView, WorkflowSnapshot } from "@/lib/voom/workflow/read";
import { planItemActions, type PlanAction, type PlanItemFacts, type WorkflowMode } from "@/lib/voom/workflow/next-actions";
import { classifyReelProduction } from "@/lib/mara/reel-production";
import { currentScheduleDate, minScheduleTime } from "@/lib/voom/schedule-guard";
import { formatLocalTimeInput } from "@/lib/voom/timezone";
import {
  approvePlanItem,
  cancelPlanItemSchedule,
  choosePlanItemProduction,
  postPlanItemNow,
  producePlanItemMedia,
  reschedulePlanItem,
} from "@/lib/voom/workflow/actions-server";

/**
 * ONE Marketing Plan card = the ONE complete workflow for that item.
 *
 * The card derives its stage, headline, actions and explanation from the SAME
 * pure engine (lib/voom/workflow/next-actions.ts) the other screens use, over
 * the SAME shared snapshot rows — so Marketing Plan, Today, Approvals and the
 * Content Calendar can never disagree. Every action advances the SAME item in
 * place via the server actions; nothing creates a duplicate draft.
 */

export function PlanItemCard({
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

  const production = reelProductionFacts(item);
  const resolved: PlanItemFacts = {
    contentType: item.contentType,
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

  function actionButton(action: PlanAction) {
    const busyNow = busy === action.id;
    if (action.disabled) {
      return <span key={action.id} className="inline-flex items-center gap-1.5 rounded-[10px] border border-line bg-surface-2 px-3 py-2 text-[12.5px] font-semibold text-text-3 line-through" title={action.disabledReason}>{action.label}</span>;
    }
    if (action.id === "film_yourself") {
      return <Btn key={action.id} variant={action.tone === "primary" ? "primary" : "outline"} size="sm" disabled={busy !== null} onClick={() => void run(action.id, () => choosePlanItemProduction(item.draftId, "film_yourself"))}>
        {action.label}{action.hint?.startsWith("Recommended") ? <span className="ml-1 text-[10px] font-bold uppercase text-green">Recommended</span> : null}
      </Btn>;
    }
    if (action.id === "upload_asset") {
      return <Btn key={action.id} variant="outline" size="sm" disabled={busy !== null} onClick={() => fileRef.current?.click()}>{action.label}</Btn>;
    }
    if (action.id === "approve_schedule") {
      return <Btn key={action.id} variant="primary" size="sm" disabled={busy !== null} onClick={() => void run(action.id, () => approvePlanItem(item.draftId))}><Icon name="check" size={13} /> {action.label}</Btn>;
    }
    if (action.id === "open_approvals") {
      return <Link key={action.id} href="/app/approvals" className="inline-flex"><Btn variant="primary" size="sm">Open Approvals</Btn></Link>;
    }
    if (action.id === "produce_with_mara" || action.id === "regenerate_media" || action.id === "retry_media") {
      const regenerate = action.id === "regenerate_media";
      return <Btn key={action.id} variant={action.tone === "primary" ? "primary" : "outline"} size="sm" disabled={busy !== null} onClick={() => void run(action.id, () => producePlanItemMedia(item.draftId, { regenerate }))}>
        <Icon name="spark" size={13} /> {busyNow ? "Generating…" : action.label}
      </Btn>;
    }
    if (action.id === "change_time" || action.id === "reschedule") {
      return <Btn key={action.id} variant="outline" size="sm" disabled={busy !== null} onClick={() => { setRescheduling((value) => !value); setMessage(""); }}>{action.label}</Btn>;
    }
    if (action.id === "post_now") {
      return <Btn key={action.id} variant="primary" size="sm" disabled={busy !== null} onClick={() => void run(action.id, () => postPlanItemNow(item.draftId))}><Icon name="bolt" size={13} /> {action.label}</Btn>;
    }
    if (action.id === "cancel_schedule") {
      return <Btn key={action.id} variant="ghost" size="sm" className="text-red" disabled={busy !== null} onClick={() => void run(action.id, () => cancelPlanItemSchedule(item.draftId))}><Icon name="trash" size={13} /> {action.label}</Btn>;
    }
    return null;
  }

  const actions = resolved2.actions.filter((action) => action.id !== "choose_production");
  const showPrimary = (action: PlanAction) => action.tone === "primary" && !action.disabled;

  return <Card className="overflow-hidden">
    <div className="border-l-[3px] p-4 sm:p-5" style={{ borderColor: stageColor(item.status) }}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <Tag tone="t-blue">{item.contentTypeLabel}</Tag>
            <Tag tone={stageTone(item.status)}>{resolved2.stageLabel}</Tag>
            {mode !== "manual" && <Tag tone="t-grey">{mode === "autopilot" ? "Autopilot" : "Assisted"}</Tag>}
          </div>
          <b className="mt-1.5 block text-[15px] leading-snug">{item.concept}</b>
        </div>
        <span className="shrink-0 rounded-lg border border-line bg-surface-2 px-2.5 py-1 text-[11.5px] font-semibold text-text-2">{item.dayLabel} · {item.localTime}</span>
      </div>

      {item.mediaPreviewUrl && <div className="mt-3 max-w-[220px]">
        {item.mediaMimeType?.startsWith("video/")
          ? <video className="w-full rounded-xl border border-line object-cover" style={{ aspectRatio: "9 / 16" }} src={item.mediaPreviewUrl} muted playsInline controls preload="metadata" />
          : <img className="w-full rounded-xl border border-line object-cover" style={{ aspectRatio: item.contentType === "story" ? "9 / 16" : "1 / 1" }} src={item.mediaPreviewUrl} alt={`Visual for ${item.concept}`} />}
      </div>}

      {/* The compact explanation: what, who, why, approval, when, auto-publish. */}
      <div className="mt-3 grid gap-1.5 rounded-xl border border-line bg-surface-2 px-3.5 py-3 text-[12.5px] leading-relaxed text-text-2">
        {resolved2.explanation.why && <Explain icon="spark" text={`MARA: ${resolved2.explanation.why}`} />}
        <Explain icon="film" text={`Will produce: ${resolved2.explanation.what} · by ${resolved2.explanation.who}`} />
        <Explain icon="clock" text={resolved2.explanation.when ? `Publishes: ${resolved2.explanation.when}` : "Publish time: not set yet"} />
        <Explain icon="bolt" text={resolved2.explanation.autoPublish} />
      </div>

      <p className="mt-3 text-[13px] font-semibold leading-relaxed">{resolved2.headline}</p>

      {item.status === "waiting_for_media" && <p role="status" className="mt-2 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] text-amber">
        This item is scheduled, but it cannot publish until the visual is ready. Voom is holding the schedule — nothing is published early.
      </p>}
      {item.status === "media_delayed" && <p role="alert" className="mt-2 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] text-red">
        Media generation is delayed, so the schedule is held — Voom will not publish until a real visual exists.
      </p>}
      {item.status === "missed" && <p role="alert" className="mt-2 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] text-amber">
        {item.missedReason ?? "Its scheduled time passed without publishing."} Voom never publishes hours late on its own.
      </p>}
      {item.status === "failed" && <p role="alert" className="mt-2 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] text-red">
        {item.failureMessage ?? (item.failedStage === "media" ? "Media generation stopped safely. Nothing was published." : "Publishing stopped safely. Nothing was published twice.")}
      </p>}
      {item.caption && (item.status === "ready_for_review" || item.status === "needs_approval") &&
        <p className="mt-2 line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed text-text-3">{item.caption}</p>}

      {actions.length > 0 && <div className="mt-3 flex flex-wrap items-center gap-2">
        {actions.filter(showPrimary).map(actionButton)}
        {actions.filter((action) => !showPrimary(action)).map(actionButton)}
      </div>}

      {/* Upload goes through the EXISTING ingestion route (validation, private storage, re-sync). */}
      <input ref={fileRef} type="file" className="sr-only" accept={item.contentType === "post" ? "image/jpeg,image/png,image/webp" : "image/jpeg,image/png,image/webp,video/mp4,video/quicktime"}
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

      {rescheduling && <RescheduleForm
        timeZone={timeZone}
        defaults={{ date: item.localDate || currentScheduleDate(), time: (item.publishAt ? formatLocalTimeInput(item.publishAt, timeZone) : "") || "18:30" }}
        busy={busy !== null}
        onSubmit={(date, time) => { setRescheduling(false); return run("reschedule", () => reschedulePlanItem(item.draftId, date, time)); }}
        onCancel={() => setRescheduling(false)}
      />}

      {message && <p role="status" className={`mt-2.5 text-[12.5px] ${messageTone === "ok" ? "text-green" : "text-red"}`}>{message}</p>}
      {(resolved2.stageLabel === "Generating" || resolved2.stageLabel === "Waiting for media") && <p className="mt-2 text-[11.5px] text-text-3">This card updates itself while MARA works. Nothing is published.</p>}
    </div>
  </Card>;
}

function Explain({ icon, text }: { icon: string; text: string }) {
  return <span className="flex items-start gap-1.5"><Icon name={icon} size={12} className="mt-[3px] shrink-0 text-text-3" /><span>{text}</span></span>;
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
  return <div className="mt-3 rounded-xl border border-line bg-surface-2 p-3.5">
    <div className="flex flex-wrap items-end gap-2">
      <label className="text-[11.5px] font-semibold text-text-3">Date<Input type="date" className="mt-1 w-[150px]" value={date} min={currentScheduleDate()} onChange={(event) => setDate(event.currentTarget.value)} /></label>
      <label className="text-[11.5px] font-semibold text-text-3">Time<Input type="time" className="mt-1 w-[120px]" value={time} min={minTime} onChange={(event) => setTime(event.currentTarget.value)} /></label>
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
  if (item.contentType !== "reel") return null;
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

export function stageTone(status: string) {
  if (status === "published") return "t-green";
  if (status === "failed") return "t-red";
  if (status === "missed" || status === "media_delayed") return "t-amber";
  if (status === "needs_approval" || status === "ready_for_review" || status === "waiting_for_media") return "t-amber";
  if (status === "generating" || status === "publishing") return "t-blue";
  if (status === "scheduled") return "t-blue";
  return "t-grey";
}

function stageColor(status: string) {
  if (status === "published") return "#1c8a52";
  if (status === "failed") return "#c0392b";
  if (status === "missed" || status === "needs_approval" || status === "ready_for_review" || status === "waiting_for_media" || status === "media_delayed") return "#f2a516";
  if (status === "generating" || status === "publishing" || status === "scheduled") return "#2f6f9f";
  return "var(--line, #e5e5e5)";
}
