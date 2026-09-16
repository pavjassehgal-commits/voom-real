"use client";

import { useCallback, useEffect, useState } from "react";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import type { CampaignDeliveryView, CampaignRecord } from "@/lib/voom/types";
import type { AutomatedCampaignView } from "@/lib/campaign/types";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { BuildCampaignModal } from "@/components/voom/modals/BuildCampaignModal";
import { AutomatedCampaignModal } from "@/components/voom/modals/AutomatedCampaignModal";
import { CampaignEditorModal } from "@/components/voom/modals/CampaignEditorModal";
import { Btn, Card, EmptyState, Tag } from "@/components/voom/ui/primitives";

interface CampaignsResponse {
  legacy: CampaignRecord[];
  automated: AutomatedCampaignView[];
  deliveries: Record<string, CampaignDeliveryView>;
  timeZone?: string;
  error?: string;
}

export default function CampaignsPage() {
  const { goTo } = useVoomActions();
  const { open } = useModal();

  const [automated, setAutomated] = useState<AutomatedCampaignView[]>([]);
  const [legacy, setLegacy] = useState<CampaignRecord[]>([]);
  const [deliveries, setDeliveries] = useState<Record<string, CampaignDeliveryView>>({});
  const [timeZone, setTimeZone] = useState("Asia/Dubai");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/campaigns", { cache: "no-store" });
      const body = await response.json() as CampaignsResponse;
      if (!response.ok) throw new Error(body.error ?? "Campaigns couldn't load.");
      setAutomated(body.automated ?? []);
      setLegacy((body.legacy ?? []).filter((row) => row.kind !== "sms"));
      setDeliveries(body.deliveries ?? {});
      setTimeZone(body.timeZone ?? "Asia/Dubai");
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Campaigns couldn't load.");
    }
  }, []);

  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("voom:data-changed", refresh);
    return () => window.removeEventListener("voom:data-changed", refresh);
  }, [load]);

  // Historical SMS campaigns are loaded separately (read-only archive) so the
  // active product experience never offers SMS, but old records still open.
  const archivedSms = useLegacySmsArchive();

  function openBuilder() {
    open(<BuildCampaignModal onBuilt={(campaignId) => {
      // Re-read then open the generated timeline.
      void (async () => {
        await load();
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(campaignId)}`, { cache: "no-store" });
        const data = await response.json() as { automated?: AutomatedCampaignView };
        if (data.automated) open(<AutomatedCampaignModal campaignId={campaignId} initial={data.automated} />);
      })();
    }} />);
  }

  function openAutomated(campaignId: string) {
    open(<AutomatedCampaignModal campaignId={campaignId} />);
  }

  return (
    <div>
      <PageHead
        title="Campaigns"
        description="Tell Voom what you want, and MARA builds a timed Instagram and email campaign for your review. Nothing is sent or published without you."
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={() => open(<CampaignEditorModal />)}>
              <Icon name="edit" size={14} /> New email draft
            </Btn>
            <Btn variant="primary" size="sm" onClick={openBuilder}>
              <Icon name="spark" size={14} /> Build campaign with MARA
            </Btn>
          </>
        }
      />

      {error && <div role="alert" className="mb-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

      <Card className="p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">MARA-built campaigns</h2>
          <Tag tone="t-grey">{automated.length}</Tag>
        </div>
        <p className="mt-1 text-[13px] text-text-3">
          One timeline per campaign — Instagram Posts, Reels, Stories and emails together, ordered by date, each with its real status.
        </p>

        {automated.length === 0 ? (
          <EmptyState
            icon="spark"
            title="No automated campaigns yet"
            reason="Give MARA a goal, a short idea and dates, and it will build the full Instagram and email sequence for you to approve. It never sends or publishes during the build."
            action={
              <Btn variant="primary" size="sm" onClick={openBuilder}>
                <Icon name="spark" size={14} /> Build campaign with MARA
              </Btn>
            }
            className="py-8"
          />
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            {automated.map((view) => (
              <AutomatedCampaignCard key={view.campaign.id} view={view} onOpen={() => openAutomated(view.campaign.id)} />
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-3.5 p-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Standalone email drafts</h2>
          <Tag tone="t-grey">{legacy.length}</Tag>
        </div>
        <p className="mt-1 text-[12.5px] leading-relaxed text-text-3">
          Delivery status stays truthful — Voom never fabricates a send. An approved draft shows Ready — open campaign to send, and Voom never records a campaign as Delivered without provider confirmation.
        </p>
        {legacy.length === 0 ? (
          <p className="mt-3 py-4 text-center text-sm text-text-3">
            No standalone email drafts yet. For a full sequence, use <b>Build campaign with MARA</b>.
          </p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="w-full border-collapse text-[13.5px]">
              <thead>
                <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
                  <th className="pb-2.5">Campaign</th>
                  <th className="pb-2.5">Audience</th>
                  <th className="pb-2.5">Subject</th>
                  <th className="pb-2.5">Proposed send</th>
                  <th className="pb-2.5">Status</th>
                  <th className="pb-2.5 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {legacy.map((campaign) => {
                  const delivery = deliveries[campaign.id];
                  return (
                    <tr key={campaign.id} className="border-t border-line">
                      <td className="py-3 pr-3"><b className="block max-w-[200px] truncate">{campaign.name}</b></td>
                      <td className="py-3 pr-3 text-text-2"><span className="block max-w-[180px] truncate">{campaign.audience || "Audience not set"}</span></td>
                      <td className="py-3 pr-3 text-text-2"><span className="block max-w-[240px] truncate">{campaign.subject || campaign.content || "No content yet"}</span></td>
                      <td className="py-3 pr-3 whitespace-nowrap text-[12.5px] text-text-2">{campaign.proposed_send_at ? formatWhen(campaign.proposed_send_at, timeZone) : "Not scheduled"}</td>
                      <td className="py-3 pr-3 whitespace-nowrap">
                        <div className="flex flex-wrap gap-1.5">
                          <Tag tone={campaign.status === "approved" ? "t-green" : campaign.status === "rejected" ? "t-red" : "t-grey"}>{statusLabel(campaign.status)}</Tag>
                          {delivery?.state && <Tag tone={deliveryTone(delivery.state)}>{deliveryLabel(delivery.state)}</Tag>}
                        </div>
                      </td>
                      <td className="py-3 text-right">
                        <Btn variant="outline" size="sm" onClick={() => open(<CampaignEditorModal campaign={campaign} />)}>
                          {campaign.status === "approved" ? "Open" : "Edit"}
                        </Btn>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {archivedSms.length > 0 && (
        <Card className="mt-3.5 p-5 opacity-90">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold">Archived SMS campaigns</h2>
            <Tag tone="t-grey">Read-only · SMS retired</Tag>
          </div>
          <p className="mt-1 text-[12.5px] leading-relaxed text-text-3">
            SMS marketing is no longer part of Voom. These historical SMS campaigns are kept for your records and cannot be edited or sent.
          </p>
          <ul className="mt-3 space-y-1.5 text-[13px]">
            {archivedSms.map((campaign) => (
              <li key={campaign.id} className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-3 py-2">
                <Icon name="msg" size={14} className="text-text-3" />
                <b className="truncate">{campaign.name}</b>
                <span className="text-text-3">{campaign.proposed_send_at ? formatWhen(campaign.proposed_send_at, timeZone) : "No date"}</span>
                <Tag tone={campaign.status === "approved" ? "t-green" : campaign.status === "rejected" ? "t-red" : "t-grey"}>{statusLabel(campaign.status)}</Tag>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card className="mt-3.5 p-5">
        <h2 className="font-display text-base font-semibold">How campaigns work</h2>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          {HOW_IT_WORKS.map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-line p-3.5">
              <div className="flex items-center gap-2">
                <span className="voom-grad grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-white"><Icon name="check" size={13} /></span>
                <b className="text-[13.5px]">{title}</b>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-2">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn variant="outline" size="sm" onClick={() => goTo("studio")}><Icon name="ig" size={14} /> Create content</Btn>
          <Btn variant="outline" size="sm" onClick={() => goTo("contacts")}><Icon name="users" size={14} /> Manage contacts</Btn>
        </div>
      </Card>
    </div>
  );
}

function AutomatedCampaignCard({ view, onOpen }: { view: AutomatedCampaignView; onOpen: () => void }) {
  const { campaign, counts, lifecycle, lifecycleLabel } = view;
  return (
    <button type="button" onClick={onOpen} className="overflow-hidden rounded-2xl border border-line bg-surface p-4 text-left transition hover:border-brand">
      <div className="flex flex-wrap items-center gap-2">
        <Tag tone={lifecycleTone(lifecycle)}>{lifecycleLabel}</Tag>
        <Tag tone="t-grey">{counts.instagram} IG</Tag>
        <Tag tone="t-grey">{counts.email} email</Tag>
        {counts.needingApproval > 0 && <Tag tone="t-amber">{counts.needingApproval} to review</Tag>}
      </div>
      <b className="mt-2 block truncate font-display text-[15.5px]">{campaign.name}</b>
      <p className="mt-1 line-clamp-3 text-[12.5px] leading-[1.55] text-text-3">
        {campaign.generated_summary ?? "MARA is preparing this campaign."}
      </p>
      <p className="mt-2 text-[11.5px] text-text-3">
        {campaign.start_at ? new Date(campaign.start_at).toLocaleDateString("en-AE", { timeZone: view.timeZone, month: "short", day: "numeric" }) : "—"}
        {" → "}
        {campaign.end_at ? new Date(campaign.end_at).toLocaleDateString("en-AE", { timeZone: view.timeZone, month: "short", day: "numeric" }) : "—"}
        <span className="float-right font-semibold text-brand">Open timeline →</span>
      </p>
    </button>
  );
}

function useLegacySmsArchive(): CampaignRecord[] {
  const [rows, setRows] = useState<CampaignRecord[]>([]);
  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          const response = await fetch("/api/voom/campaigns?kind=sms", { cache: "no-store" });
          const data = await response.json() as { campaigns?: CampaignRecord[] };
          if (!cancelled && response.ok) setRows(data.campaigns ?? []);
        } catch {
          // Archive is best-effort and must never break the campaigns screen.
        }
      })();
    }, 0);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, []);
  return rows;
}

const HOW_IT_WORKS: [string, string][] = [
  ["You give the brief", "A goal, a campaign name or idea and dates. Offer, audience and notes are optional."],
  ["MARA builds the plan", "MARA sequences Instagram Posts, Reels, Stories and emails across the dates, using your business context and real performance when it exists."],
  ["You approve, Voom executes", "Review the single timeline and approve per action. Emails send only via an explicit send; Instagram items still need a visual and schedule."],
];

function lifecycleTone(status: string) {
  if (status === "completed") return "t-green";
  if (status === "active" || status === "scheduled") return "t-blue";
  if (status === "needs_attention") return "t-red";
  if (status === "needs_approval") return "t-amber";
  return "t-grey";
}

function statusLabel(status: string) {
  if (status === "approved") return "Approved — ready to send";
  if (status === "rejected") return "Not approved";
  return "Draft";
}

function deliveryTone(state: string) {
  return state === "delivered" ? "t-green" : state === "accepted" ? "t-blue" : state === "failed" ? "t-red" : state === "sending" ? "t-amber" : "t-grey";
}

function deliveryLabel(state: string) {
  if (state === "delivered") return "Delivered";
  if (state === "accepted") return "Accepted";
  if (state === "failed") return "Failed";
  if (state === "sending") return "Sending";
  return "Ready";
}

function formatWhen(value: string, timeZone = "Asia/Dubai") {
  return new Date(value).toLocaleString("en-AE", {
    timeZone, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
}
