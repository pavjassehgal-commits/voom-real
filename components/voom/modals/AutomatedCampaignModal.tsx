"use client";

import { useCallback, useEffect, useState } from "react";
import Image from "next/image";
import { useModal } from "@/lib/voom/modal";
import {
  ACTION_CHANNEL_LABELS,
  CAMPAIGN_CHANNEL_LABELS,
  CAMPAIGN_CREATION_METHOD_LABELS,
  CAMPAIGN_GOAL_LABELS,
  type AutomatedCampaignView,
  type CampaignActionView,
  type CampaignChannel,
} from "@/lib/campaign/types";
import { actionStateTone } from "@/lib/campaign/status";
import { formatLocalTimeInput, isoToLocalDate, localToUtcIso } from "@/lib/voom/timezone";
import type { CampaignDeliveryView } from "@/lib/voom/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

/**
 * The campaign workspace: MARA's approach, then ONE timeline containing every
 * planned email and Instagram action with derived status, per-action approvals,
 * inline editing of the generated draft, and a single-action "Regenerate draft
 * with MARA".
 *
 * It never edits the generated STRUCTURE (dates, channels and action count come
 * from the deterministic planner), and it can never auto-send — emails keep the
 * explicit send action, while Instagram production stays editable and actionable
 * inside this campaign workspace.
 */
export function AutomatedCampaignModal({ campaignId, initial }: { campaignId: string; initial?: AutomatedCampaignView }) {
  const { close } = useModal();
  const [view, setView] = useState<AutomatedCampaignView | null>(initial ?? null);
  const [error, setError] = useState("");
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string };
      if (!response.ok || !data.automated) { setError(data.error ?? "That campaign couldn't load."); return; }
      setView(data.automated);
      setError("");
    } catch {
      setError("That campaign couldn't load.");
    }
  }, [campaignId]);

  useEffect(() => {
    if (initial) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
        const data = await response.json() as { automated?: AutomatedCampaignView; error?: string };
        if (cancelled) return;
        if (!response.ok || !data.automated) { setError(data.error ?? "That campaign couldn't load."); return; }
        setView(data.automated);
        setError("");
      } catch {
        if (!cancelled) setError("That campaign couldn't load.");
      }
    })();
    return () => { cancelled = true; };
  }, [campaignId, initial]);

  async function decide(action: CampaignActionView, decision: "approve" | "reject") {
    setBusyAction(action.id);
    setError("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}/actions/${encodeURIComponent(action.id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: decision }),
      });
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string; message?: string };
      if (data.automated) setView(data.automated);
      else if (response.ok) await load();
      if (!response.ok) setError(data.error ?? "That action couldn't be updated.");
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch {
      setError("That action couldn't be updated.");
    } finally {
      setBusyAction(null);
    }
  }

  /** One action only: MARA rewrites that draft, nothing else is touched. */
  async function regenerate(action: CampaignActionView) {
    setBusyAction(action.id);
    setError("");
    try {
      const response = await fetch(
        `/api/voom/campaigns/${encodeURIComponent(campaignId)}/actions/${encodeURIComponent(action.id)}/regenerate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          // Client-minted so a double click or a retried request cannot apply twice.
          body: JSON.stringify({ idempotencyKey: crypto.randomUUID() }),
        },
      );
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string };
      if (data.automated) setView(data.automated);
      if (!response.ok) setError(data.error ?? "MARA couldn't rewrite that draft.");
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch {
      setError("MARA couldn't rewrite that draft.");
    } finally {
      setBusyAction(null);
    }
  }

  if (!view) {
    return (
      <ModalShell wide>
        <ModalBody><p className="py-8 text-center text-sm text-text-3">Loading campaign…</p></ModalBody>
      </ModalShell>
    );
  }

  const { campaign } = view;

  return (
    <ModalShell wide>
      <ModalHead
        title={campaign.name}
        sub={`${campaign.goal ? CAMPAIGN_GOAL_LABELS[campaign.goal] : "Campaign"} · ${dateRange(campaign.start_at, campaign.end_at, view.timeZone)} · ${view.timeZone.replace("_", " ")}`}
        onClose={close}
      />
      <ModalBody>
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tag tone={lifecycleTone(view.lifecycle)}>{view.lifecycleLabel}</Tag>
          {/* Campaigns v3: the campaign's own channel selection, and who wrote it. */}
          <Tag tone="t-brand">{channelLabel(view.channels)}</Tag>
          <Tag tone="t-grey">{CAMPAIGN_CREATION_METHOD_LABELS[view.creationMethod]}</Tag>
          {view.counts.instagram > 0 && <Tag tone="t-grey">{view.counts.instagram} Instagram</Tag>}
          {view.counts.email > 0 && <Tag tone="t-grey">{view.counts.email} email{view.counts.email === 1 ? "" : "s"}</Tag>}
          {view.counts.tiktok > 0 && <Tag tone="t-grey">{view.counts.tiktok} TikTok</Tag>}
          {view.counts.youtube > 0 && <Tag tone="t-grey">{view.counts.youtube} YouTube</Tag>}
          {view.counts.needingApproval > 0 && <Tag tone="t-amber">{view.counts.needingApproval} need your review</Tag>}
          {view.counts.executed > 0 && <Tag tone="t-green">{view.counts.executed} done</Tag>}
        </div>

        <StrategyBlock view={view} />

        {campaign.offer_details && (
          <p className="mb-3 text-[12.5px] text-text-3">Offer on file: <b className="text-text-2">{campaign.offer_details}</b></p>
        )}

        <ol className="relative space-y-3 border-l border-line pl-4">
          {view.actions.map((action) => (
            <TimelineRow
              key={action.id}
              campaignId={campaignId}
              action={action}
              timeZone={view.timeZone}
              busy={busyAction === action.id}
              onDecide={decide}
              onRegenerate={regenerate}
              onChanged={() => void load()}
            />
          ))}
        </ol>

        <Card className="mt-4 border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="mt-0.5 flex-none text-amber" size={16} />
            <p className="text-[12.5px] leading-[1.6] text-text-2">
              Building creates drafts only. Email still sends through an explicit Send action below. Instagram
              production, media and proposed time stay in this campaign workspace; nothing is sent or published
              automatically from this screen, and campaign generation never spends AI media credits.
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Close</Btn>
      </ModalFoot>
    </ModalShell>
  );
}

/**
 * "MARA's approach" — a compact, human-readable strategy block. The full
 * strategy stays short by design: no AI essays are surfaced here.
 */
function StrategyBlock({ view }: { view: AutomatedCampaignView }) {
  const strategy = view.strategy;
  const summary = strategy?.summary || view.campaign.generated_summary;
  if (!summary) return null;

  const rows: [string, string][] = strategy
    ? [
        ["Objective", strategy.objective],
        ["Core message", strategy.coreMessage],
        ["Audience angle", strategy.audienceAngle],
        ["CTA strategy", strategy.ctaStrategy],
      ].filter(([, value]) => Boolean(value)) as [string, string][]
    : [];

  return (
    <Card className="mb-4 border-line-2 bg-surface-2 p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name="spark" size={16} className="flex-none text-brand" />
        <b className="text-[13.5px]">MARA&apos;s approach</b>
        <Tag tone={strategy?.source === "mara" ? "t-brand" : "t-grey"}>
          {strategy?.source === "mara" ? "Written by MARA" : "Deterministic plan"}
        </Tag>
      </div>
      <p className="mt-2 text-[13px] leading-[1.6] text-text-2">{summary}</p>
      {rows.length > 0 && (
        <dl className="mt-2.5 grid gap-x-4 gap-y-1.5 sm:grid-cols-2">
          {rows.map(([label, value]) => (
            <div key={label} className="min-w-0">
              <dt className="font-mono text-[10px] uppercase tracking-[.07em] text-text-3">{label}</dt>
              <dd className="text-[12.5px] leading-[1.5] text-text-2">{value}</dd>
            </div>
          ))}
        </dl>
      )}
      {strategy?.performanceNote && (
        <p className="mt-2.5 border-t border-line pt-2 text-[11.5px] leading-[1.55] text-text-3">{strategy.performanceNote}</p>
      )}
    </Card>
  );
}

function TimelineRow({ campaignId, action, timeZone, busy, onDecide, onRegenerate, onChanged }: {
  campaignId: string;
  action: CampaignActionView;
  timeZone: string;
  busy: boolean;
  onDecide: (action: CampaignActionView, decision: "approve" | "reject") => void;
  onRegenerate: (action: CampaignActionView) => void;
  onChanged: () => void;
}) {
  const when = new Date(action.scheduled_for);
  const isEmail = action.channel === "email";
  const isSocial = action.channel === "tiktok_video" || action.channel === "youtube_short" || action.channel === "youtube_video";
  const pending = action.executionState === "proposed" || action.executionState === "needs_approval";
  const [panel, setPanel] = useState<"none" | "details" | "edit">("none");

  return (
    <li className="relative">
      <span className="absolute -left-[22px] top-4 grid h-3 w-3 place-items-center rounded-full border-2 border-brand bg-bg" />
      <Card className="p-3.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="grid h-8 w-8 flex-none place-items-center rounded-lg bg-surface-2 text-brand">
            <Icon name={isEmail ? "mail" : isSocial ? "play" : action.channel === "instagram_reel" ? "film" : "ig"} size={15} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <b className="text-[13.5px]">{when.toLocaleDateString("en-AE", { timeZone, weekday: "short", month: "short", day: "numeric" })}</b>
              <span className="text-[11.5px] text-text-3">{when.toLocaleTimeString("en-AE", { timeZone, hour: "numeric", minute: "2-digit" })}</span>
              <Tag tone="t-grey">{ACTION_CHANNEL_LABELS[action.channel]}</Tag>
              {action.instagram?.format && action.channel !== "email" && <Tag tone="t-grey">{labelForFormat(action.instagram.format)}</Tag>}
              {isSocial && <Tag tone="t-grey">{action.social?.format === "short" ? "Short · 9:16" : "Video · 9:16"}</Tag>}
              {action.contentSource === "mara" && <Tag tone="t-brand">MARA</Tag>}
            </div>
            <b className="mt-0.5 block truncate text-[13.5px]">{action.title}</b>
          </div>
          <Tag tone={actionStateTone(action.executionState)}>{action.executionLabel}</Tag>
        </div>
        {/* Why this action exists, in one line. */}
        <p className="mt-1.5 text-[12px] leading-[1.55] text-text-3">{action.purpose}</p>

        {action.safety_blockers?.length > 0 && action.executionState === "needs_approval" && (
          <p className="mt-2 text-[11.5px] text-amber">MARA held this for your review: {action.safety_blockers.join(", ")}.</p>
        )}

        <div className="mt-2.5 flex flex-wrap gap-2">
          <Btn size="sm" variant="plain" onClick={() => setPanel((v) => (v === "details" ? "none" : "details"))}>
            {panel === "details" ? "Hide details" : "Review content"}
          </Btn>
          {action.canEditContent && (
            <Btn size="sm" variant="plain" onClick={() => setPanel((v) => (v === "edit" ? "none" : "edit"))}>
              {panel === "edit" ? "Close editor" : "Edit draft"}
            </Btn>
          )}
          {action.canEditContent && (
            <Btn size="sm" variant="plain" disabled={busy} onClick={() => onRegenerate(action)}>
              <Icon name="spark" size={13} /> {busy ? "Working…" : "Regenerate draft with MARA"}
            </Btn>
          )}
          {pending && (
            <div className="ml-auto flex flex-wrap gap-2">
              <Btn size="sm" variant="outline" disabled={busy} onClick={() => onDecide(action, "reject")}>Reject</Btn>
              <Btn
                size="sm"
                variant="primary"
                disabled={busy || (!isEmail && Boolean(isSocial ? action.social?.needsAsset : action.instagram?.needsVisual))}
                onClick={() => onDecide(action, "approve")}
              >
                {busy ? "Working…"
                  : isEmail ? "Approve email"
                  : isSocial ? (action.social?.needsAsset ? "Add video first" : "Approve")
                  : action.instagram?.needsVisual ? "Add media first" : "Approve"}
              </Btn>
            </div>
          )}
        </div>

        {!action.canEditContent && (
          <p className="mt-2 text-[11.5px] text-text-3">
            {isSocial
              ? `This action is approved inside Voom. ${action.social?.publishStateLabel ?? "Publishing is not connected yet."}`
              : `This action has already been ${isEmail ? "sent" : "published or is publishing"}, so its content is locked.`}
          </p>
        )}

        {panel === "details" && (
          <div className="mt-3">
            {action.email
              ? <EmailDetails action={action} timeZone={timeZone} onChanged={onChanged} />
              : action.social
                ? <SocialDetails key={`${action.id}:${action.updated_at}`} action={action} timeZone={timeZone} />
                : <InstagramDetails key={`${action.id}:${action.updated_at}:${action.instagram?.format ?? ""}`} campaignId={campaignId} action={action} timeZone={timeZone} onChanged={onChanged} />}
          </div>
        )}
        {panel === "edit" && (
          <div className="mt-3">
            <ActionEditor key={`${action.id}:${action.updated_at}:${action.instagram?.format ?? ""}`} campaignId={campaignId} action={action} timeZone={timeZone} onSaved={onChanged} />
          </div>
        )}
      </Card>
    </li>
  );
}

function labelForFormat(format: string) {
  if (format === "reel") return "Reel";
  if (format === "story") return "Story";
  return "Post";
}

function productionLabel(status: string) {
  if (status === "waiting_for_filming") return "Film it myself selected";
  if (status === "waiting_for_asset_upload") return "Waiting for upload";
  if (status === "ready_for_mara_production") return "Ready for MARA";
  return status.replaceAll("_", " ");
}

/**
 * Edits the generated draft in place: email subject/preview/body/CTA/time, or
 * Instagram concept/hook/caption/time. The campaign is never rebuilt and no
 * other action changes. Saving never sends or publishes.
 */
function ActionEditor({ campaignId, action, timeZone, onSaved }: {
  campaignId: string;
  action: CampaignActionView;
  timeZone: string;
  onSaved: () => void;
}) {
  const isEmail = action.channel === "email";
  const isSocial = action.channel === "tiktok_video" || action.channel === "youtube_short" || action.channel === "youtube_video";
  const isYouTube = action.channel === "youtube_short" || action.channel === "youtube_video";
  const [subject, setSubject] = useState(action.email?.subject ?? "");
  const [previewText, setPreviewText] = useState(action.email?.previewText ?? "");
  const [body, setBody] = useState(action.email?.body ?? "");
  const [purpose, setPurpose] = useState(action.purpose);
  const [cta, setCta] = useState(action.email?.cta ?? action.instagram?.cta ?? "");
  const [caption, setCaption] = useState(action.instagram?.caption ?? action.social?.caption ?? "");
  const [concept, setConcept] = useState(action.instagram?.concept ?? action.social?.concept ?? action.title);
  const [hook, setHook] = useState(action.instagram?.hook ?? "");
  const [visualDirection, setVisualDirection] = useState(action.instagram?.visualDirection ?? "");
  const [description, setDescription] = useState(action.social?.description ?? "");
  const [script, setScript] = useState((action.instagram?.script ?? action.social?.script ?? []).join("\n"));
  const [format, setFormat] = useState<"post" | "reel" | "story">(action.instagram?.format ?? "post");
  const [date, setDate] = useState(isoToLocalDate(action.scheduled_for, timeZone));
  const [time, setTime] = useState(formatLocalTimeInput(action.scheduled_for, timeZone));
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  async function save() {
    setBusy(true); setErr(""); setNote("");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
      setErr("Choose a valid proposed date and time.");
      setBusy(false);
      return;
    }
    const minutes = Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
    const payload: Record<string, unknown> = { scheduledFor: localToUtcIso(date, Number.isFinite(minutes) ? minutes : 0, timeZone), purpose };
    if (isEmail) {
      payload.subject = subject; payload.previewText = previewText; payload.body = body; payload.cta = cta;
    } else if (isSocial) {
      // Multi-Social Core: TikTok/YouTube deliverable text. No Instagram
      // CTA/hashtag composition; YouTube carries the description.
      payload.caption = caption; payload.concept = concept;
      payload.script = script.split("\n").map((line) => line.trim()).filter(Boolean);
      if (isYouTube) payload.description = description;
    } else {
      payload.caption = caption; payload.concept = concept; payload.hook = hook; payload.cta = cta;
      payload.visualDirection = visualDirection;
      payload.script = script.split("\n").map((line) => line.trim()).filter(Boolean);
      payload.format = format;
    }
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}/actions/${encodeURIComponent(action.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok) setErr(data.error ?? "That draft couldn't be saved.");
      else { setNote(data.message ?? "Draft saved."); onSaved(); window.dispatchEvent(new Event("voom:data-changed")); }
    } catch {
      setErr("That draft couldn't be saved.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface-2 p-3">
      {isEmail ? (
        <>
          <Field label="Purpose"><Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} /></Field>
          <Field label="Subject"><Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} /></Field>
          <Field label="Preview text"><Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} maxLength={500} /></Field>
          <Field label="Body"><Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} maxLength={12000} /></Field>
          <Field label="CTA"><Input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={160} /></Field>
        </>
      ) : isSocial ? (
        <>
          <Field label="Purpose"><Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} /></Field>
          <Field label={isYouTube ? "Title" : "Concept"} hint={isYouTube ? "Search-friendly — front-load the topic." : "A short internal name."}>
            <Input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={160} />
          </Field>
          <Field label="Caption" hint={action.channel === "tiktok_video" ? "One short TikTok-native line (max 2200 characters)." : "The video caption."}>
            <Textarea rows={3} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={2200} />
          </Field>
          {isYouTube && (
            <Field label="Description" hint={action.channel === "youtube_video" ? "2-4 sentences with the payoff and chapters." : "1-2 lines for the Short."}>
              <Textarea rows={action.channel === "youtube_video" ? 5 : 2} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
            </Field>
          )}
          <Field label={action.channel === "tiktok_video" ? "Beat list" : action.channel === "youtube_video" ? "Outline / script" : "Beat list"} hint="One line per beat or section. Planning text only — no video is generated.">
            <Textarea rows={5} value={script} onChange={(e) => setScript(e.target.value)} placeholder={"Hook…\nSection 1…\nClose…"} />
          </Field>
          <p className="rounded-xl bg-surface px-3 py-2 text-[11.5px] leading-relaxed text-text-3">
            {action.channel === "tiktok_video"
              ? "Approved with a schedule, this video joins the durable TikTok publish queue — Published appears only after TikTok's own post-status confirms it."
              : "Approved with a schedule, this video joins the durable YouTube publish queue — Published appears only after YouTube confirms the video is processed."}
          </p>
        </>
      ) : (
        <>
          <Field label="Purpose"><Textarea rows={2} value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={1000} /></Field>
          <Field label="Format">
            <select className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none focus:border-brand" value={format} onChange={(e) => setFormat(e.target.value as "post" | "reel" | "story")}>
              <option value="post">Instagram Post</option>
              <option value="reel">Reel</option>
              <option value="story">Instagram Story</option>
            </select>
          </Field>
          <Field label="Concept"><Input value={concept} onChange={(e) => setConcept(e.target.value)} maxLength={160} /></Field>
          <Field label="Hook"><Input value={hook} onChange={(e) => setHook(e.target.value)} maxLength={300} /></Field>
          <Field label="Caption"><Textarea rows={6} value={caption} onChange={(e) => setCaption(e.target.value)} maxLength={2200} /></Field>
          <Field label="Visual direction"><Textarea rows={3} value={visualDirection} onChange={(e) => setVisualDirection(e.target.value)} maxLength={1200} placeholder="What should the visual show?" /></Field>
          {format === "reel" && <Field label="Reel shot script" hint="One shot or line per row"><Textarea rows={4} value={script} onChange={(e) => setScript(e.target.value)} maxLength={2400} placeholder="Hook shot\nBenefit shot\nCTA shot" /></Field>}
          <Field label="CTA"><Input value={cta} onChange={(e) => setCta(e.target.value)} maxLength={160} /></Field>
        </>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        <Field label="Proposed date"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></Field>
        <Field label="Proposed time"><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></Field>
      </div>
      <p className="text-[11.5px] text-text-3">Times use your business timezone ({timeZone.replace("_", " ")}). Past times are rejected. Saving changes this draft only — nothing is sent or published.</p>
      <div className="flex flex-wrap gap-2">
        <Btn size="sm" variant="primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save draft"}</Btn>
      </div>
      {note && <p role="status" className="text-[12px] text-green">{note}</p>}
      {err && <p role="alert" className="text-[12px] text-red">{err}</p>}
    </div>
  );
}

function InstagramDetails({ campaignId, action, timeZone, onChanged }: {
  campaignId: string;
  action: CampaignActionView;
  timeZone: string;
  onChanged: () => void;
}) {
  const ig = action.instagram;
  const [busy, setBusy] = useState<"production" | "generation" | "upload" | null>(null);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  // Fail closed while the billing summary is loading: only an explicit Pro/Max
  // response should reveal the paid-media generation control.
  const [plan, setPlan] = useState<string | null>("free");
  const [remaining, setRemaining] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/billing/summary", { cache: "no-store" })
      .then((response) => response.json() as Promise<{ summary?: { plan?: string; remaining?: number } }>)
      .then((data) => {
        if (!cancelled && data.summary) {
          setPlan(data.summary.plan ?? "free");
          setRemaining(typeof data.summary.remaining === "number" ? data.summary.remaining : null);
        }
      })
      .catch(() => { if (!cancelled) setPlan("free"); });
    return () => { cancelled = true; };
  }, []);

  if (!ig) return null;
  const instagram = ig;
  const methods = instagram.availableProductionMethods ?? ["create_with_mara", "upload_asset"];
  const generationLocked = plan === "free";
  const productionLocked = !action.canEditContent;

  async function choose(method: "create_with_mara" | "upload_asset" | "film_yourself") {
    setBusy("production"); setErr(""); setNote("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}/actions/${encodeURIComponent(action.id)}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "production", method }),
      });
      const data = await response.json() as { automated?: AutomatedCampaignView; error?: string; message?: string };
      if (data.automated) onChanged();
      if (!response.ok) setErr(data.error ?? "That production choice could not be saved.");
      else setNote(data.message ?? "Production choice saved in this campaign.");
    } catch {
      setErr("That production choice could not be saved.");
    } finally {
      setBusy(null);
    }
  }

  async function generateWithMara() {
    if (generationLocked) {
      setErr("AI media generation is locked on Free. Upgrade to Pro or Max, then retry here.");
      return;
    }
    setBusy("generation"); setErr(""); setNote("");
    try {
      const isVideo = action.channel === "instagram_reel";
      // The shared generate route owns the guarded image/video credit path;
      // `/generation` is the status/action endpoint and would reject this
      // campaign request as an unknown generation action.
      const endpoint = `/api/posts/${encodeURIComponent(instagram.draftId)}/generate`;
      const response = await fetch(endpoint, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brief: instagram.visualDirection || instagram.concept,
          ...(isVideo ? { media: "video" } : {}),
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok) setErr(data.error ?? "MARA couldn't generate this visual.");
      else { setNote(data.message ?? "MARA started this visual. The campaign will update when it is ready."); onChanged(); }
    } catch {
      setErr("MARA couldn't generate this visual.");
    } finally {
      setBusy(null);
    }
  }

  async function upload(file: File | null) {
    if (!file) return;
    setBusy("upload"); setErr(""); setNote("");
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("origin", action.channel === "instagram_reel" ? "existing_content" : "own_asset");
      const response = await fetch(`/api/posts/${encodeURIComponent(instagram.draftId)}/asset`, { method: "POST", body: form });
      const data = await response.json() as { error?: string; message?: string };
      if (!response.ok) setErr(data.error ?? "That media could not be uploaded.");
      else { setNote(data.message ?? "Media stored privately in this campaign."); onChanged(); }
    } catch {
      setErr("That media could not be uploaded.");
    } finally {
      setBusy(null);
    }
  }

  const media = instagram.media;
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={instagram.draftStatus === "approved" ? "t-green" : instagram.draftStatus === "rejected" ? "t-red" : "t-amber"}>Draft {instagram.draftStatus}</Tag>
        {instagram.queueStatus ? <Tag tone="t-blue">Queue: {instagram.queueStatus}</Tag> : null}
        {instagram.needsVisual ? <Tag tone="t-amber">Needs media before publishing</Tag> : <Tag tone="t-green">Media attached</Tag>}
        {instagram.productionStatus && <Tag tone="t-blue">{productionLabel(instagram.productionStatus)}</Tag>}
        {plan && <Tag tone="t-grey">{plan === "free" ? "Free · upload only" : `${plan[0].toUpperCase()}${plan.slice(1)} · ${remaining ?? "—"} credits`}</Tag>}
      </div>
      {media?.previewUrl && (
        media.mimeType.startsWith("video/")
          ? <video controls className="max-h-64 w-full rounded-lg bg-black object-contain" src={media.previewUrl} />
          : <div className="relative h-64 w-full rounded-lg bg-surface">
              <Image unoptimized fill sizes="(max-width: 768px) 100vw, 640px" className="rounded-lg object-contain" src={media.previewUrl} alt={media.displayName} />
            </div>
      )}
      {instagram.hook ? <p className="text-[12.5px] font-semibold text-text-2">Hook: {instagram.hook}</p> : null}
      <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-text-2">{instagram.caption}</p>
      {instagram.script?.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-[1.55] text-text-2">
          {instagram.script.map((line, index) => <li key={index}>{line}</li>)}
        </ol>
      )}
      {instagram.visualDirection ? <p className="text-[11.5px] leading-[1.55] text-text-3">Visual direction: {instagram.visualDirection}</p> : null}

      <div className="rounded-xl border border-line bg-bg p-3">
        <p className="mb-2 text-[12.5px] font-semibold text-text-2">Produce this {labelForFormat(instagram.format)} here</p>
        <div className="flex flex-wrap gap-2">
          {methods.includes("create_with_mara") && (
            <Btn size="sm" variant="primary" disabled={Boolean(busy) || generationLocked || productionLocked} onClick={() => void generateWithMara()}>
              <Icon name="spark" size={13} /> {productionLocked ? "Locked" : busy === "generation" ? "Starting…" : generationLocked ? "Upgrade to generate" : "Create with MARA"}
            </Btn>
          )}
          {methods.includes("film_yourself") && (
            <Btn size="sm" variant="outline" disabled={Boolean(busy) || productionLocked} onClick={() => void choose("film_yourself")}>
              <Icon name="film" size={13} /> {busy === "production" ? "Saving…" : "Film it myself"}
            </Btn>
          )}
          {methods.includes("upload_asset") && (
            <label className="inline-flex h-[34px] cursor-pointer items-center justify-center gap-1.5 rounded-[9px] border border-line-2 px-3.5 text-[13px] font-semibold text-text transition hover:bg-surface-2 has-[:disabled]:pointer-events-none has-[:disabled]:opacity-45">
              {busy === "upload" ? "Uploading…" : "Upload media"}
              <input className="sr-only" type="file" accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime" disabled={Boolean(busy) || productionLocked} onChange={(event) => void upload(event.target.files?.[0] ?? null)} />
            </label>
          )}
        </div>
        {generationLocked && methods.includes("create_with_mara") && <p className="mt-2 text-[11.5px] text-text-3">Campaign generation is free; explicit paid media generation is a Pro/Max action and the server checks credits before any provider call.</p>}
        <p className="mt-2 text-[11.5px] text-text-3">All production choices and media stay attached to this campaign action. Uploads are private until the normal approval and publish gates pass.</p>
      </div>
      {note && <p role="status" className="text-[12px] text-green">{note}</p>}
      {err && <p role="alert" className="text-[12px] text-red">{err}</p>}
      <p className="text-[11.5px] text-text-3">Proposed time: {new Date(action.scheduled_for).toLocaleString("en-AE", { timeZone, dateStyle: "medium", timeStyle: "short" })}</p>
    </div>
  );
}

/**
 * Multi-Social Core — read-only deliverable view for a TikTok or YouTube
 * campaign action. Truthful by construction: the state tag shows the canonical
 * social publish state (an approved item reads "publishing not connected"),
 * there is no send/publish control, and no provider reference is ever shown
 * unless a provider really returned one.
 */
function SocialDetails({ action, timeZone }: { action: CampaignActionView; timeZone: string }) {
  const social = action.social;
  if (!social) return null;
  const media = social.media;
  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={social.draftStatus === "approved" ? "t-green" : social.draftStatus === "rejected" ? "t-red" : "t-amber"}>
          Draft {social.draftStatus}
        </Tag>
        <Tag tone="t-amber">{social.publishStateLabel}</Tag>
        {social.needsAsset ? <Tag tone="t-amber">No video attached yet</Tag> : <Tag tone="t-green">Video attached</Tag>}
        {social.providerRef && <Tag tone="t-blue">Provider ref: {social.providerRef}</Tag>}
      </div>
      {media?.previewUrl && (
        media.mimeType.startsWith("video/")
          ? <video controls className="max-h-64 w-full rounded-lg bg-black object-contain" src={media.previewUrl} />
          : <div className="relative h-64 w-full rounded-lg bg-surface">
              <Image unoptimized fill sizes="(max-width: 768px) 100vw, 640px" className="rounded-lg object-contain" src={media.previewUrl} alt={media.displayName} />
            </div>
      )}
      <p className="text-[12.5px] font-semibold text-text-2">{social.title}</p>
      {social.caption ? <p className="whitespace-pre-wrap text-[12.5px] leading-[1.6] text-text-2">{social.caption}</p> : null}
      {social.description ? <p className="whitespace-pre-wrap text-[12px] leading-[1.55] text-text-3">Description: {social.description}</p> : null}
      {social.concept ? <p className="text-[11.5px] leading-[1.55] text-text-3">Concept: {social.concept}</p> : null}
      {social.script?.length > 0 && (
        <ol className="list-decimal space-y-1 pl-4 text-[12px] leading-[1.55] text-text-2">
          {social.script.map((line, index) => <li key={index}>{line}</li>)}
        </ol>
      )}
      <p className="rounded-xl border border-amber/35 bg-amber/10 px-3 py-2 text-[11.5px] leading-relaxed text-amber">
        {social.channel === "tiktok"
          ? "This action rides the durable TikTok publish queue. Nothing is posted until the scheduled time, and Voom reports Published only after TikTok's own post-status endpoint confirms it."
          : "This action rides the durable YouTube publish queue. Nothing is posted until the scheduled time, and Voom reports Published only after YouTube confirms the video is processed."}
      </p>
      <p className="text-[11.5px] text-text-3">Proposed time: {new Date(action.scheduled_for).toLocaleString("en-AE", { timeZone, dateStyle: "medium", timeStyle: "short" })}</p>
    </div>
  );
}

function EmailDetails({ action, timeZone, onChanged }: { action: CampaignActionView; timeZone: string; onChanged: () => void }) {
  const email = action.email;
  const childId = email?.childCampaignId;
  const [delivery, setDelivery] = useState<CampaignDeliveryView | null>(null);
  const [contact, setContact] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");

  const refreshDelivery = useCallback(async () => {
    if (!childId) return;
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, { cache: "no-store" });
      const data = await response.json() as { delivery?: CampaignDeliveryView };
      if (response.ok && data.delivery) {
        setDelivery(data.delivery);
        setContact(data.delivery.recipient?.contact ?? "");
        setName(data.delivery.recipient?.contact_name ?? "");
      }
    } catch {
      // Delivery detail is optional in the timeline.
    }
  }, [childId]);

  useEffect(() => {
    if (!childId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, { cache: "no-store" });
        const data = await response.json() as { delivery?: CampaignDeliveryView };
        if (!cancelled && response.ok && data.delivery) {
          setDelivery(data.delivery);
          setContact(data.delivery.recipient?.contact ?? "");
          setName(data.delivery.recipient?.contact_name ?? "");
        }
      } catch {
        // Delivery detail is optional in the timeline.
      }
    })();
    return () => { cancelled = true; };
  }, [childId]);

  async function sendToContact() {
    if (!childId || !contact.trim()) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: contact.trim(), contactName: name.trim() }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) setErr(data.error ?? "The email couldn't be sent.");
      else { setNote(data.message ?? "Email accepted by the provider."); onChanged(); window.dispatchEvent(new Event("voom:data-changed")); }
      await refreshDelivery();
    } catch {
      setErr("The email couldn't be sent safely.");
    } finally {
      setBusy(false);
    }
  }

  async function sendToAudience() {
    if (!childId) return;
    setBusy(true); setErr(""); setNote("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(childId)}/delivery`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audienceSend: true }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) setErr(data.error ?? "The audience send couldn't run.");
      else { setNote(data.message ?? "The audience send finished."); onChanged(); window.dispatchEvent(new Event("voom:data-changed")); }
      await refreshDelivery();
    } catch {
      setErr("The audience send couldn't run safely.");
    } finally {
      setBusy(false);
    }
  }

  if (!email) return null;
  const sendState = delivery?.state;

  return (
    <div className="space-y-2.5 rounded-xl border border-line bg-surface-2 p-3">
      <div className="flex flex-wrap gap-1.5">
        <Tag tone={email.childStatus === "approved" ? "t-green" : email.childStatus === "rejected" ? "t-red" : "t-amber"}>
          {email.childStatus === "approved" ? "Approved" : email.childStatus === "rejected" ? "Rejected" : "Draft"}
        </Tag>
        {sendState && <Tag tone={sendState === "delivered" ? "t-green" : sendState === "failed" ? "t-red" : "t-blue"}>{deliveryStateLabel(sendState)}</Tag>}
      </div>
      <Field label="Subject"><Input value={email.subject ?? ""} readOnly /></Field>
      {email.previewText ? <Field label="Preview text"><Input value={email.previewText} readOnly /></Field> : null}
      <Field label="Body">
        <Textarea rows={6} value={email.body} readOnly />
      </Field>
      {email.cta ? <p className="text-[12px] font-semibold text-text-2">CTA: {email.cta}</p> : null}
      {email.audienceNote ? <p className="text-[11.5px] text-text-3">Written for: {email.audienceNote}</p> : null}
      <p className="text-[11.5px] text-text-3">
        Proposed send time: {new Date(action.scheduled_for).toLocaleString("en-AE", { timeZone, dateStyle: "medium", timeStyle: "short" })}
      </p>

      {email.canSendExplicitly && (
        <div className="rounded-xl border border-line bg-bg p-3">
          <p className="mb-2 text-[12.5px] font-semibold text-text-2">Send this approved email</p>
          {delivery?.audience ? (
            <>
              <p className="mb-2 text-[12px] leading-[1.55] text-text-2">{delivery.note}</p>
              <Btn size="sm" variant="primary" disabled={busy || !delivery.canSend} onClick={() => void sendToAudience()}>
                <Icon name="send" size={13} /> {busy ? "Sending…" : "Send to audience now"}
              </Btn>
            </>
          ) : (
            <>
              <div className="grid gap-2 sm:grid-cols-2">
                <Field label="Recipient email">
                  <Input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="customer@example.com" />
                </Field>
                <Field label="Recipient name (optional)">
                  <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Sara" />
                </Field>
              </div>
              <Btn size="sm" variant="primary" disabled={busy || !contact.trim() || !delivery?.canSend} onClick={() => void sendToContact()}>
                <Icon name="send" size={13} /> {busy ? "Sending…" : "Send now"}
              </Btn>
            </>
          )}
          {delivery && !delivery.provider.configured && (
            <p className="mt-2 text-[11.5px] text-amber">{delivery.provider.label} is not configured on the server yet.</p>
          )}
        </div>
      )}

      {note && <p role="status" className="text-[12px] text-green">{note}</p>}
      {err && <p role="alert" className="text-[12px] text-red">{err}</p>}
    </div>
  );
}

/**
 * Campaigns v3 — the campaign's own channel selection as one short label.
 * A campaign is one workspace, so this never renders as three products.
 */
function channelLabel(channels: readonly CampaignChannel[] | null | undefined): string {
  const selected = (channels ?? []).filter((channel) => CAMPAIGN_CHANNEL_LABELS[channel]);
  if (selected.length === 0) return "Instagram + Email";
  return selected.map((channel) => CAMPAIGN_CHANNEL_LABELS[channel]).join(" + ");
}

function lifecycleTone(status: string) {
  if (status === "completed") return "t-green";
  if (status === "active" || status === "scheduled") return "t-blue";
  if (status === "needs_attention") return "t-red";
  if (status === "needs_approval") return "t-amber";
  if (status === "building") return "t-brand";
  return "t-grey";
}

function deliveryStateLabel(state: string) {
  if (state === "delivered") return "Delivered";
  if (state === "accepted") return "Accepted";
  if (state === "sending") return "Sending";
  if (state === "failed") return "Failed";
  return "Ready to send";
}

function dateRange(start: string | null, end: string | null, timeZone = "Asia/Dubai") {
  if (!start || !end) return "";
  const fmt = (value: string) => new Date(value).toLocaleDateString("en-AE", { timeZone, month: "short", day: "numeric" });
  return `${fmt(start)} – ${fmt(end)}`;
}
