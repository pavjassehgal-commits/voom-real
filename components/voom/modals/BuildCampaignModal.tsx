"use client";

import { useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { addDays, daysBetween } from "@/lib/voom/timezone";
import type { AudienceRecord } from "@/lib/contacts/types";
import {
  CAMPAIGN_GOALS,
  CAMPAIGN_GOAL_LABELS,
  type CampaignGoal,
} from "@/lib/campaign/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

/**
 * The guided "tell Voom what you want" flow. Four required inputs (idea,
 * goal, start date, end date); everything else is optional. MARA builds the
 * whole Instagram + email timeline on the server. Nothing is sent or
 * published by the build.
 */
export function BuildCampaignModal({ onBuilt }: { onBuilt?: (campaignId: string) => void }) {
  const { close } = useModal();
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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

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

  async function build() {
    setError("");
    if (!name.trim()) { setError("Give the campaign a name or a short idea first."); return; }
    if (!today) { setError("Your business calendar is still loading. Please retry in a moment."); return; }
    if (!startDate || !endDate) { setError("Choose a start and end date."); return; }
    if (span < 1) { setError("The end date must be on or after the start date."); return; }
    if (span > 60) { setError("Keep the campaign to 60 days or fewer for v1."); return; }

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
        }),
      });
      const data = await response.json() as { campaignId?: string; message?: string; error?: string };
      if (!response.ok || !data.campaignId) {
        setError(data.error ?? "MARA couldn't build that campaign. Please retry.");
        return;
      }
      window.dispatchEvent(new Event("voom:data-changed"));
      close();
      onBuilt?.(data.campaignId);
    } catch {
      setError("MARA couldn't build that campaign. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell wide>
      <ModalHead
        title="Build campaign with MARA"
        sub="Tell Voom what you want · MARA builds the Instagram + email timeline · you review and approve"
        onClose={close}
      />
      <ModalBody>
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <Field label="Campaign name or short idea" hint="One line is enough — MARA works out the details.">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={160}
            placeholder="e.g. Launch our autumn collection with a 10% intro offer"
          />
        </Field>

        <Field label="Goal">
          <div className="flex flex-wrap gap-1.5">
            {CAMPAIGN_GOALS.map((value) => (
              <button
                type="button"
                key={value}
                onClick={() => setGoal(value)}
                className={`rounded-full border px-3.5 py-1.5 text-[13px] font-semibold transition ${goal === value ? "border-brand bg-[var(--brand-soft)] text-brand" : "border-line bg-surface-2 text-text-2 hover:border-line-2"}`}
                aria-pressed={goal === value}
              >
                {CAMPAIGN_GOAL_LABELS[value]}
              </button>
            ))}
          </div>
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

        <Field label="Offer, discount or details (optional)" hint="If there is an offer, MARA will place it in the conversion emails and reminders.">
          <Input value={offerDetails} onChange={(e) => setOfferDetails(e.target.value)} maxLength={1000} placeholder="e.g. 10% off for first-time buyers, free delivery over AED 150" />
        </Field>

        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Target audience (optional)" hint="Free-text — who is this for?">
            <Input value={targetAudience} onChange={(e) => setTargetAudience(e.target.value)} maxLength={1000} placeholder="e.g. lapsed customers from the last 6 months" />
          </Field>
          <Field label="Saved audience for emails (optional)">
            <select
              className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]"
              value={audienceId}
              onChange={(e) => setAudienceId(e.target.value)}
            >
              <option value="">No saved audience</option>
              {audiences.map((audience) => (
                <option key={audience.id} value={audience.id}>{audience.name}</option>
              ))}
            </select>
          </Field>
        </div>

        <Field label="Additional notes for MARA (optional)">
          <Textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Anything else — a product angle, dates to avoid, tone guidance…" />
        </Field>

        <Card className="border-line-2 bg-surface-2 p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="info" className="mt-0.5 flex-none text-brand" size={16} />
            <p className="text-[12.5px] leading-[1.6] text-text-2">
              MARA builds a timed mix of Instagram Posts, Reels, Stories and email drafts using your goal, dates,
              business context and — when real data exists — your recent Instagram performance. Building only
              creates drafts: no email is sent, nothing is published, and no paid media credits are spent. Your
              automation mode decides whether anything is pre-approved; every external action still follows the
              existing approval and safety rules.
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" onClick={close}>Cancel</Btn>
        <Btn variant="primary" disabled={busy || !today} onClick={() => void build()}>
          <Icon name="spark" size={14} /> {busy ? "MARA is building…" : "Build campaign with MARA"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
