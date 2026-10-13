"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/voom/ui/primitives";
import type { AccountUnsubscribes, EmailCampaignResults } from "@/lib/voom/email-results";

/**
 * Results for one email campaign, in plain language.
 *
 * Every figure is a count of real recorded emails and verified Resend
 * reports (lib/voom/email-results). No rates or percentages are shown, opens
 * and clicks say "Not tracked" unless Resend actually reported them, and the
 * unsubscribe total is labelled as account-wide because unsubscribes are not
 * recorded per campaign.
 */

interface ResultsResponse {
  results?: EmailCampaignResults;
  unsubscribes?: AccountUnsubscribes | null;
  error?: string;
}

function Stat({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "red" | "amber" | "green" }) {
  const color = tone === "red" ? "text-red" : tone === "amber" ? "text-amber" : tone === "green" ? "text-green" : "text-text";
  return (
    <div className="rounded-xl border border-line bg-surface px-3 py-2.5">
      <div className="text-[11.5px] font-semibold uppercase tracking-[0.04em] text-text-3">{label}</div>
      <div className={`mt-0.5 font-display text-[22px] font-semibold leading-tight ${color}`}>{value}</div>
      <div className="mt-0.5 text-[11.5px] leading-snug text-text-3">{hint}</div>
    </div>
  );
}

export function EmailResultsPanel({ campaignId, refreshKey }: { campaignId: string; refreshKey?: unknown }) {
  const [data, setData] = useState<ResultsResponse | null>(null);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}/results`, { cache: "no-store" });
      const body = await response.json() as ResultsResponse;
      if (!response.ok || !body.results) throw new Error(body.error ?? "Results are temporarily unavailable.");
      setData(body);
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Results are temporarily unavailable.");
    }
  }, [campaignId]);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load, refreshKey]);

  if (error) {
    return <p role="status" className="mb-3.5 text-[12.5px] text-text-3">{error}</p>;
  }
  if (!data?.results) return null;
  const r = data.results;
  if (r.sent === 0 && r.inProgress === 0 && r.skipped === 0) return null;

  const notes: string[] = [];
  if (r.inProgress > 0) notes.push(`${r.inProgress} still sending`);
  if (r.awaitingReport > 0) notes.push(`${r.awaitingReport} accepted, waiting for a delivery report`);
  if (r.delayed > 0) notes.push(`${r.delayed} delayed — Resend is still trying`);
  if (r.skipped > 0) notes.push(`${r.skipped} not sent (no consent, unsubscribed or blocked address)`);

  return (
    <Card className="mb-3.5 p-3.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-[15px] font-semibold">Results</h3>
        <span className="text-[11.5px] text-text-3">From Voom&apos;s send records and Resend&apos;s verified reports</span>
      </div>

      <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Sent" value={String(r.sent)} hint="Emails Voom handed to Resend" />
        <Stat label="Accepted" value={String(r.accepted)} hint="Resend accepted them for delivery" />
        <Stat label="Delivered" value={String(r.delivered)} hint="Reached the recipient's mail server" tone={r.delivered > 0 ? "green" : undefined} />
        <Stat label="Bounced" value={String(r.bounced)} hint="The address rejected the email" tone={r.bounced > 0 ? "red" : undefined} />
        <Stat label="Spam complaints" value={String(r.complained)} hint="Recipients marked it as spam" tone={r.complained > 0 ? "red" : undefined} />
        <Stat label="Failed" value={String(r.failed)} hint="Couldn't be sent or delivered" tone={r.failed > 0 ? "red" : undefined} />
      </div>

      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3">
        <Stat label="Opens" value={r.opens === null ? "Not tracked" : String(r.opens)} hint={r.opens === null ? "Resend hasn't reported any opens" : "Emails opened at least once"} />
        <Stat label="Clicks" value={r.clicks === null ? "Not tracked" : String(r.clicks)} hint={r.clicks === null ? "Resend hasn't reported any clicks" : "Emails with at least one link clicked"} />
        <Stat
          label="Unsubscribes"
          value={data.unsubscribes ? String(data.unsubscribes.total) : "Unavailable"}
          hint="Whole account, from all emails — not just this campaign"
        />
      </div>

      {notes.length > 0 ? <p className="mt-2.5 text-[12px] leading-relaxed text-text-2">{notes.join(" · ")}.</p> : null}
      <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-3">
        Opens can be over-counted by email apps that preload images, so treat them as a rough signal. Bounced and
        complaining addresses are blocked from future emails automatically.
      </p>
    </Card>
  );
}
