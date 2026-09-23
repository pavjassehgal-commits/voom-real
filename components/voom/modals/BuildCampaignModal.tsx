"use client";

import { useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { addDays, daysBetween, localToUtcIso } from "@/lib/voom/timezone";
import type { AudienceRecord } from "@/lib/contacts/types";
import {
  CAMPAIGN_CHANNELS,
  CAMPAIGN_CHANNEL_LABELS,
  CAMPAIGN_GOALS,
  CAMPAIGN_GOAL_LABELS,
  LEGACY_DEFAULT_CAMPAIGN_CHANNELS,
  type CampaignActionChannel,
  type CampaignChannel,
  type CampaignGoal,
} from "@/lib/campaign/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

/**
 * The ONE campaign creation flow (Multi-Social Campaigns).
 *
 * Two creation paths write the same campaign model:
 *   - Create with MARA: the guided brief; MARA plans a coordinated sequence
 *     inside the channels you selected.
 *   - Create myself: you write the actions directly. No provider is called.
 *
 * One campaign, one timeline, one workspace — the channels you pick decide which
 * actions live inside it, not which page you are on. Building only ever creates
 * drafts: nothing is sent, nothing is published and no paid media credit is
 * spent here. Your automation mode (Manual / Assisted / Autopilot) is a separate
 * setting and still decides what happens next.
 *
 * Instagram, TikTok and YouTube all publish for real through their connected
 * accounts: approved, scheduled actions ride each channel's durable publish
 * queue, and Voom reports Published only after the provider itself confirms.
 * A channel without a connection is refused truthfully — never faked.
 */

/** How a campaign is created — deliberately not an automation-mode word. */
const CREATION_PATHS = [
  { id: "mara", label: "Create with MARA" },
  { id: "self", label: "Create myself" },
] as const;

type CreationPath = (typeof CREATION_PATHS)[number]["id"];

/** The canonical formats each channel offers, from the ONE vocabulary. */
const FORMATS_FOR_FAMILY: Record<Exclude<CampaignChannel, "email">, ReadonlyArray<{ id: string; label: string }>> = {
  instagram: [
    { id: "post", label: "Post" },
    { id: "reel", label: "Reel" },
    { id: "story", label: "Story" },
  ],
  tiktok: [{ id: "video", label: "Video" }],
  youtube: [
    { id: "short", label: "Short" },
    { id: "video", label: "Video" },
  ],
};

interface DraftAction {
  id: string;
  family: CampaignChannel;
  /** The format inside the action's family; ignored for email. */
  format: string;
  /** Business-local calendar date. */
  date: string;
  /** Business-local wall-clock time. */
  time: string;
  title: string;
  subject: string;
  previewText: string;
  body: string;
  cta: string;
  caption: string;
  /** Multi-Social Core: the long-form description (YouTube Video/Short). */
  description: string;
}

function actionChannelOf(action: DraftAction): CampaignActionChannel {
  if (action.family === "email") return "email";
  return `${action.family}_${action.format}` as CampaignActionChannel;
}

/** The first format a family defaults to. */
function defaultFormatFor(family: CampaignChannel): string {
  if (family === "email") return "";
  return FORMATS_FOR_FAMILY[family][0]?.id ?? "post";
}

/**
 * A campaign only ever contains actions on channels it selected, so narrowing the
 * selection re-points any drafted action that would now be invalid instead of
 * leaving it. This runs inside the same click as the change — no effect, so no
 * extra render pass and no window where the two disagree.
 */
function reconcileActions(actions: DraftAction[], channels: CampaignChannel[]): DraftAction[] {
  if (!channels.length) return actions;
  return actions.map((action) => {
    if (channels.includes(action.family)) return action;
    const family = channels[0];
    return { ...action, family, format: defaultFormatFor(family) };
  });
}

function timeToMinutes(time: string): number {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(time.trim());
  return match ? Number(match[1]) * 60 + Number(match[2]) : 9 * 60;
}

export function BuildCampaignModal({ onBuilt }: { onBuilt?: (campaignId: string) => void }) {
  const { close } = useModal();
  const [path, setPath] = useState<CreationPath>("mara");
  // Multi-Social Campaigns: any non-empty combination of the four channels.
  // The legacy default (Instagram + Email) is the starting selection — a
  // channel whose provider is not connected is never selected silently.
  const [selectedChannels, setSelectedChannels] = useState<CampaignChannel[]>([...LEGACY_DEFAULT_CAMPAIGN_CHANNELS]);
  const [name, setName] = useState("");
  const [goal, setGoal] = useState<CampaignGoal>("drive_sales");
  // The server's workflow snapshot is the source of truth for the business
  // calendar. Do not derive these values from the browser or UTC clock.
  const [timeZone, setTimeZone] = useState("Asia/Dubai");
  const [today, setToday] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [offerDetails, setOfferDetails] = useState("");
  const [targetAudience, setTargetAudience] = useState("");
  const [notes, setNotes] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [audiences, setAudiences] = useState<AudienceRecord[]>([]);
  const [draftActions, setDraftActions] = useState<DraftAction[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Canonical stored order: instagram, tiktok, youtube, email.
  const channels = CAMPAIGN_CHANNELS.filter((channel) => selectedChannels.includes(channel));
  const allowsEmail = channels.includes("email");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/voom/workflow", { cache: "no-store" });
        const data = await response.json() as { snapshot?: { today?: string; timeZone?: string } };
        const snapshotToday = data.snapshot?.today;
        if (!cancelled && response.ok && snapshotToday) {
          const zone = data.snapshot?.timeZone || "Asia/Dubai";
          setTimeZone(zone);
          setToday(snapshotToday);
          setStartDate((current) => current || snapshotToday);
          setEndDate((current) => current || addDays(snapshotToday, 9));
        }
      } catch {
        // Keep the date fields empty rather than guessing in the viewer's timezone.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/voom/audiences", { cache: "no-store" });
        const data = await response.json() as { audiences?: AudienceRecord[] };
        if (!cancelled && response.ok && data.audiences) setAudiences(data.audiences);
      } catch {
        // Audience picker stays optional and empty.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const span = useMemo(() => {
    if (!startDate || !endDate) return 0;
    return daysBetween(startDate, endDate) + 1;
  }, [startDate, endDate]);

  /**
   * Toggling a channel and re-pointing any now-invalid draft is one act. The
   * last selected channel can never be toggled off: a campaign must run on at
   * least one channel.
   */
  function toggleChannel(channel: CampaignChannel) {
    setSelectedChannels((current) => {
      const has = current.includes(channel);
      if (has && current.length === 1) return current;
      const next = CAMPAIGN_CHANNELS.filter((c) => (has ? c !== channel : c === channel || current.includes(c)));
      setDraftActions((actions) => reconcileActions(actions, next));
      return next;
    });
  }

  function addAction() {
    const family: CampaignChannel = channels[0] ?? "instagram";
    setDraftActions((current) => [...current, {
      id: crypto.randomUUID(),
      family,
      format: defaultFormatFor(family),
      date: startDate || today,
      time: family === "email" ? "10:00" : "18:00",
      title: "",
      subject: "",
      previewText: "",
      body: "",
      cta: "",
      caption: "",
      description: "",
    }]);
  }

  function patchAction(id: string, patch: Partial<DraftAction>) {
    setDraftActions((current) => current.map((action) => (action.id === id ? { ...action, ...patch } : action)));
  }

  function removeAction(id: string) {
    setDraftActions((current) => current.filter((action) => action.id !== id));
  }

  async function submit() {
    setError("");
    if (!name.trim()) { setError("Give the campaign a name or a short idea first."); return; }
    if (!today) { setError("Your business calendar is still loading. Please retry in a moment."); return; }
    if (!startDate || !endDate) { setError("Choose a start and end date."); return; }
    if (span < 1) { setError("The end date must be on or after the start date."); return; }
    if (span > 60) { setError("Keep the campaign to 60 days or fewer."); return; }

    if (path === "self") {
      for (const action of draftActions) {
        if (!action.title.trim()) { setError("Every action needs a title."); return; }
        if (!action.date || !action.time) { setError("Every action needs a date and time."); return; }
        if (action.family === "email" && (!action.subject.trim() || !action.body.trim())) {
          setError("Every email action needs a subject and a body.");
          return;
        }
      }
      const emails = draftActions.filter((action) => action.family === "email").length;
      if (emails > 4) { setError("Keep a campaign to 4 emails or fewer."); return; }
    }

    setBusy(true);
    try {
      const idempotencyKey = crypto.randomUUID();
      const response = await fetch("/api/voom/campaigns/build", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: name.trim(),
          goal,
          startDate,
          endDate,
          offerDetails: offerDetails.trim(),
          targetAudience: targetAudience.trim(),
          notes: notes.trim(),
          audienceId: audienceId || null,
          idempotencyKey,
          // Campaigns v3: which path created it, and the channels it runs on.
          creationMethod: path,
          channels,
          ...(path === "self"
            ? {
                actions: draftActions.map((action) => ({
                  channel: actionChannelOf(action),
                  title: action.title.trim(),
                  scheduledFor: localToUtcIso(action.date, timeToMinutes(action.time), timeZone),
                  ...(action.family === "email"
                    ? {
                        subject: action.subject.trim(),
                        previewText: action.previewText.trim(),
                        body: action.body.trim(),
                        cta: action.cta.trim(),
                        audienceId: audienceId || null,
                      }
                    : {
                        caption: action.caption.trim(),
                        concept: action.title.trim(),
                        // Multi-Social Core: YouTube carries its description.
                        ...(action.family === "youtube" && action.description.trim()
                          ? { description: action.description.trim() }
                          : {}),
                      }),
                })),
              }
            : {}),
        }),
      });
      const data = await response.json() as { campaignId?: string; message?: string; error?: string };
      if (!response.ok || !data.campaignId) {
        setError(data.error ?? "Voom couldn't create that campaign. Please retry.");
        return;
      }
      window.dispatchEvent(new Event("voom:data-changed"));
      close();
      onBuilt?.(data.campaignId);
    } catch {
      setError("Voom couldn't create that campaign. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell wide>
      <ModalHead
        title="New campaign"
        sub="One campaign, one timeline · choose your channels, then create it with MARA or write it yourself"
        onClose={close}
      />
      <ModalBody>
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <Field label="How do you want to create it?" hint="Both paths create the same campaign. Your automation mode is a separate setting.">
          <PillGroup
            ariaLabel="Creation path"
            value={path}
            options={CREATION_PATHS.map((option) => ({ id: option.id, label: option.label }))}
            onChange={(value) => setPath(value as CreationPath)}
          />
        </Field>

        <Field
          label="Channels"
          hint="Pick any combination — one campaign, one coordinated timeline. Instagram, TikTok and YouTube publish through your connected accounts; email sends only on an explicit send."
        >
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Campaign channels">
            {CAMPAIGN_CHANNELS.map((channel) => {
              const active = selectedChannels.includes(channel);
              return (
                <button
                  type="button"
                  key={channel}
                  onClick={() => toggleChannel(channel)}
                  aria-pressed={active}
                  className={`rounded-full border font-semibold transition px-3.5 py-1.5 text-[13px] ${active ? "border-brand bg-[var(--brand-soft)] text-brand" : "border-line bg-surface-2 text-text-2 hover:border-line-2"}`}
                >
                  {CAMPAIGN_CHANNEL_LABELS[channel]}
                </button>
              );
            })}
          </div>
        </Field>

        <Field label="Campaign name or short idea" hint={path === "self" ? "One line is enough." : "One line is enough — MARA works out the details."}>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            placeholder="e.g. Summer Sale with a 10% intro offer"
          />
        </Field>

        <Field label="Goal">
          <PillGroup
            ariaLabel="Campaign goal"
            value={goal}
            options={CAMPAIGN_GOALS.map((value) => ({ id: value, label: CAMPAIGN_GOAL_LABELS[value] }))}
            onChange={(value) => setGoal(value as CampaignGoal)}
          />
        </Field>

        <div className="grid gap-3 sm:grid-cols-3">
          <Field label="Start date" hint={today ? `Business timezone: ${timeZone.replace("_", " ")}` : "Loading your business calendar…"}>
            <Input type="date" value={startDate} min={today || undefined} onChange={(e) => setStartDate(e.target.value)} disabled={!today} />
          </Field>
          <Field label="End date">
            <Input type="date" value={endDate} min={startDate || today || undefined} onChange={(e) => setEndDate(e.target.value)} disabled={!today} />
          </Field>
          <div className="flex items-end pb-2">
            <Tag tone="t-blue">{span > 0 ? `${span}-day campaign` : "Pick dates"}</Tag>
          </div>
        </div>

        {path === "mara" && (
          <>
            <Field label="Offer, discount or details (optional)" hint="If there is an offer, MARA will place it in the conversion emails and reminders.">
              <Input value={offerDetails} onChange={(e) => setOfferDetails(e.target.value)} maxLength={1000} placeholder="e.g. 10% off for first-time buyers, free delivery over AED 150" />
            </Field>

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Target audience (optional)" hint="Free-text — who is this for?">
                <Input value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} maxLength={1000} placeholder="e.g. lapsed customers from the last 6 months" />
              </Field>
              <Field label="Saved audience for emails (optional)">
                <AudienceSelect value={audienceId} audiences={audiences} onChange={setAudienceId} disabled={!allowsEmail} />
              </Field>
            </div>

            <Field label="Additional notes for MARA (optional)">
              <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Anything else — a product angle, dates to avoid, tone guidance…" />
            </Field>

            <Card className="border-line-2 bg-surface-2 p-3.5">
              <div className="flex items-start gap-2.5">
                <Icon name="info" className="mt-0.5 flex-none text-brand" size={16} />
                <p className="text-[12.5px] leading-[1.6] text-text-2">
                  MARA builds a timed sequence inside the channels you selected — one coordinated story told natively on
                  each platform (a teaser Reel, a TikTok variation, the email launch, a YouTube Short, the deeper
                  YouTube video), never the same copy pasted everywhere. Building only creates drafts: no email is
                  sent, nothing is published, and no paid media credits are spent. Your automation mode decides whether
                  anything is pre-approved; every external action still follows the existing approval and safety rules.
                </p>
              </div>
            </Card>
          </>
        )}

        {path === "self" && (
          <>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Offer, discount or details (optional)">
                <Input value={offerDetails} onChange={(e) => setOfferDetails(e.target.value)} maxLength={1000} placeholder="e.g. 10% off for first-time buyers" />
              </Field>
              <Field label="Saved audience for emails (optional)">
                <AudienceSelect value={audienceId} audiences={audiences} onChange={setAudienceId} disabled={!allowsEmail} />
              </Field>
            </div>

            <Field label="Campaign notes (optional)">
              <Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Anything you want to remember about this campaign…" />
            </Field>

            <div className="mt-1 flex flex-wrap items-center justify-between gap-2">
              <div>
                <b className="font-display text-[14.5px]">Your actions</b>
                <p className="text-[12.5px] text-text-3">
                  Each action belongs to this one campaign and runs on a channel you selected. You can add more later.
                </p>
              </div>
              <Btn variant="outline" size="sm" onClick={addAction} disabled={!today}>
                <Icon name="plus" size={14} /> Add action
              </Btn>
            </div>

            {draftActions.length === 0 ? (
              <p className="mt-3 rounded-xl border border-line bg-surface-2 px-3.5 py-4 text-center text-[13px] text-text-3">
                No actions yet. Add the Instagram moments and emails you want, in the order you want them.
              </p>
            ) : (
              <div className="mt-3 space-y-2.5">
                {draftActions.map((action, index) => (
                  <Card key={action.id} className="p-3.5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <Tag tone="t-grey">Action {index + 1}</Tag>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {channels.length > 1 && (
                          <PillGroup
                            compact
                            ariaLabel={`Action ${index + 1} channel`}
                            value={action.family}
                            options={channels.map((channel) => ({ id: channel, label: CAMPAIGN_CHANNEL_LABELS[channel] }))}
                            onChange={(value) => {
                              const family = value as CampaignChannel;
                              patchAction(action.id, { family, format: defaultFormatFor(family) });
                            }}
                          />
                        )}
                        <button
                          type="button"
                          onClick={() => removeAction(action.id)}
                          className="rounded-full border border-line px-2.5 py-1 text-[12px] font-semibold text-text-3 hover:border-red/40 hover:text-red"
                        >
                          Remove
                        </button>
                      </div>
                    </div>

                    <div className="mt-2.5 grid gap-2.5 sm:grid-cols-[1fr_auto_auto]">
                      <Field label="Title">
                        <Input value={action.title} onChange={(e) => patchAction(action.id, { title: e.target.value })} maxLength={160} placeholder={action.family === "email" ? "e.g. Summer Sale starts Tuesday" : "e.g. Summer Sale Reel"} />
                      </Field>
                      <Field label="Date">
                        <Input type="date" value={action.date} min={startDate || today || undefined} max={endDate || undefined} onChange={(e) => patchAction(action.id, { date: e.target.value })} disabled={!today} />
                      </Field>
                      <Field label="Time">
                        <Input type="time" value={action.time} onChange={(e) => patchAction(action.id, { time: e.target.value })} disabled={!today} />
                      </Field>
                    </div>

                    {action.family === "instagram" ? (
                      <>
                        <Field label="Format">
                          <PillGroup
                            compact
                            ariaLabel={`Action ${index + 1} format`}
                            value={action.format}
                            options={FORMATS_FOR_FAMILY.instagram}
                            onChange={(value) => patchAction(action.id, { format: value })}
                          />
                        </Field>
                        <Field label="Caption" hint={action.format === "reel" ? "You can add the shot list later in the campaign workspace." : "You can edit this later in the campaign workspace."}>
                          <Textarea rows={3} value={action.caption} onChange={(e) => patchAction(action.id, { caption: e.target.value })} maxLength={2200} placeholder="What this post says…" />
                        </Field>
                      </>
                    ) : action.family === "tiktok" || action.family === "youtube" ? (
                      <>
                        {action.family === "youtube" && (
                          <Field label="Format">
                            <PillGroup
                              compact
                              ariaLabel={`Action ${index + 1} format`}
                              value={action.format}
                              options={FORMATS_FOR_FAMILY.youtube}
                              onChange={(value) => patchAction(action.id, { format: value })}
                            />
                          </Field>
                        )}
                        <Field
                          label="Caption"
                          hint={action.family === "tiktok"
                            ? "One short TikTok-native line. You can add the beat list later in the campaign workspace."
                            : "The video caption. You can edit everything later in the campaign workspace."}
                        >
                          <Textarea rows={3} value={action.caption} onChange={(e) => patchAction(action.id, { caption: e.target.value })} maxLength={2200} placeholder={action.family === "tiktok" ? "One short line + 3-5 tags…" : "What this video says…"} />
                        </Field>
                        {action.family === "youtube" && action.format === "video" && (
                          <Field label="Description" hint="The full YouTube description — the payoff and what the video covers. Planning it never generates a video.">
                            <Textarea rows={3} value={action.description} onChange={(e) => patchAction(action.id, { description: e.target.value })} maxLength={2000} placeholder="What viewers get from this video…" />
                          </Field>
                        )}
                        <p className="rounded-xl bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-3">
                          {action.family === "tiktok"
                            ? "Approved and scheduled — this action rides the durable TikTok publish queue, and Voom reports Published only after TikTok's own post-status confirms it."
                            : "Approved and scheduled — this action rides the durable YouTube publish queue, and Voom reports Published only after YouTube confirms the video is processed."}
                        </p>
                      </>
                    ) : (
                      <>
                        <div className="grid gap-2.5 sm:grid-cols-2">
                          <Field label="Subject">
                            <Input value={action.subject} onChange={(e) => patchAction(action.id, { subject: e.target.value })} maxLength={300} placeholder="e.g. Our Summer Sale is live" />
                          </Field>
                          <Field label="Preview text (optional)">
                            <Input value={action.previewText} onChange={(e) => patchAction(action.id, { previewText: e.target.value })} maxLength={500} />
                          </Field>
                        </div>
                        <Field label="Body" hint="Sent through your branded email template. Nothing is sent until you explicitly send it.">
                          <Textarea rows={4} value={action.body} onChange={(e) => patchAction(action.id, { body: e.target.value })} maxLength={12000} placeholder="Write the email…" />
                        </Field>
                        <Field label="Call to action (optional)">
                          <Input value={action.cta} onChange={(e) => patchAction(action.id, { cta: e.target.value })} maxLength={160} placeholder="e.g. Shop the sale" />
                        </Field>
                      </>
                    )}
                  </Card>
                ))}
              </div>
            )}

            <Card className="mt-3 border-line-2 bg-surface-2 p-3.5">
              <div className="flex items-start gap-2.5">
                <Icon name="info" className="mt-0.5 flex-none text-brand" size={16} />
                <p className="text-[12.5px] leading-[1.6] text-text-2">
                  Creating a campaign yourself saves drafts only. Each action still needs its normal next step: an email
                  needs your explicit send, and an Instagram action needs a visual and a schedule. Nothing is sent,
                  published or paid for here, and your automation mode still decides what is pre-approved.
                </p>
              </div>
            </Card>
          </>
        )}
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" onClick={close}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !today} onClick={() => void submit()}>
          <Icon name={path === "mara" ? "spark" : "plus"} size={14} />
          {busy
            ? (path === "mara" ? "MARA is building…" : "Saving…")
            : (path === "mara" ? "Build campaign with MARA" : "Create campaign myself")}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}

/** The segmented pill control the goal picker already uses. */
function PillGroup({
  value,
  options,
  onChange,
  ariaLabel,
  compact,
}: {
  value: string;
  options: ReadonlyArray<{ id: string; label: string }>;
  onChange: (value: string) => void;
  ariaLabel: string;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-wrap gap-1.5" role="group" aria-label={ariaLabel}>
      {options.map((option) => (
        <button
          type="button"
          key={option.id}
          onClick={() => onChange(option.id)}
          aria-pressed={value === option.id}
          className={`rounded-full border font-semibold transition ${compact ? "px-2.5 py-1 text-[12px]" : "px-3.5 py-1.5 text-[13px]"} ${value === option.id ? "border-brand bg-[var(--brand-soft)] text-brand" : "border-line bg-surface-2 text-text-2 hover:border-line-2"}`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function AudienceSelect({
  value,
  audiences,
  onChange,
  disabled,
}: {
  value: string;
  audiences: AudienceRecord[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  return (
    <select
      className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)] disabled:opacity-60"
      value={disabled ? "" : value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
    >
      <option value="">{disabled ? "Email is not selected for this campaign" : "No saved audience"}</option>
      {!disabled && audiences.map((audience) => (
        <option key={audience.id} value={audience.id}>{audience.name}</option>
      ))}
    </select>
  );
}
