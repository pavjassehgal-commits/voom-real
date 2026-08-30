"use client";

import { useCallback, useEffect, useState } from "react";

import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import type { CampaignDeliveryState, CampaignDeliveryView, CampaignRecord, CampaignStatus } from "@/lib/voom/types";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { CampaignEditorModal } from "@/components/voom/modals/CampaignEditorModal";
import { Btn, Card, Chip, Tag } from "@/components/voom/ui/primitives";
import { DemoTag } from "@/components/voom/ui/Notes";

type StatusFilter = "all" | CampaignStatus;

const FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Not approved" },
];

export default function CampaignsPage() {
  const { campTab, brand } = useVoomState();
  const { setCampTab, goTo } = useVoomActions();
  const { open } = useModal();
  const pack = useCurrentPack();
  const brandLabel = brand.name || "your business";
  const em = campTab === "email";

  const [savedCampaigns, setSavedCampaigns] = useState<CampaignRecord[]>([]);
  const [deliveryByCampaignId, setDeliveryByCampaignId] = useState<Record<string, CampaignDeliveryView>>({});
  const [campaignError, setCampaignError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");

  const loadCampaigns = useCallback(async () => {
    try {
      const response = await fetch(`/api/voom/campaigns?kind=${campTab}`, { cache: "no-store" });
      const body = await response.json() as { campaigns?: CampaignRecord[]; deliveries?: Record<string, CampaignDeliveryView>; error?: string };
      if (!response.ok) throw new Error(body.error || "Campaign drafts couldn't load.");
      setSavedCampaigns(body.campaigns ?? []);
      setDeliveryByCampaignId(body.deliveries ?? {});
      setCampaignError(null);
    } catch (reason) {
      setDeliveryByCampaignId({});
      setCampaignError(reason instanceof Error ? reason.message : "Campaign drafts couldn't load.");
    }
  }, [campTab]);

  useEffect(() => { const timer = window.setTimeout(() => void loadCampaigns(), 0); return () => window.clearTimeout(timer); }, [loadCampaigns]);
  useEffect(() => {
    const refresh = () => void loadCampaigns();
    window.addEventListener("voom:data-changed", refresh);
    return () => window.removeEventListener("voom:data-changed", refresh);
  }, [loadCampaigns]);

  const visible = savedCampaigns.filter((campaign) => statusFilter === "all" || campaign.status === statusFilter);

  const maraTake = em
    ? [
        ["Re-engage cold subscribers", "Prepare a win-back sequence in Voom first — nothing is sent until a provider is connected."],
        ["Move sends to Tuesday 9 AM", "From the illustrative sample: your opens are 12% higher then."],
        ["Segment out non-openers before launch", "Protects sender reputation once real delivery is connected."],
      ]
    : [
        ["Send only on restock days", "Over-texting is the #1 cause of opt-outs."],
        ["Keep it short and useful", "Long splits cost more per message once a provider is connected."],
        ["Add an SMS opt-in to checkout", "Sample insight: roughly 40 signups a week are being missed."],
      ];

  function openNew() {
    open(<CampaignEditorModal kind={campTab} />);
  }

  return (
    <div>
      <PageHead
        title="Email & SMS"
        description="Campaign drafts prepared by Voom and approved by you. External delivery happens only through an explicit send action."
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={() => goTo("plan")}>
              <Icon name="spark" size={14} /> Review marketing plan
            </Btn>
            <Btn variant="primary" size="sm" onClick={openNew}>
              <Icon name="plus" size={14} /> New {em ? "email" : "SMS"}
            </Btn>
          </>
        }
      />

      {campaignError && <div role="alert" className="mb-3 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{campaignError}</div>}

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex w-fit gap-1 rounded-[13px] border border-line bg-surface-2 p-1">
          <button
            onClick={() => setCampTab("email")}
            className={`flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[13.5px] font-semibold transition ${em ? "bg-surface text-text shadow-[var(--shadow)]" : "text-text-2"}`}
          >
            <Icon name="mail" size={14} /> Email
          </button>
          <button
            onClick={() => setCampTab("sms")}
            className={`flex items-center gap-1.5 rounded-[10px] px-4 py-2 text-[13.5px] font-semibold transition ${!em ? "bg-surface text-text shadow-[var(--shadow)]" : "text-text-2"}`}
          >
            <Icon name="msg" size={14} /> SMS
          </button>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <DemoTag />
          <Tag>
            <Icon name="info" size={12} /> Delivery status stays truthful — Voom never fabricates a send
          </Tag>
        </div>
      </div>

      <div className="mb-3.5">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <DemoTag />
          <span className="text-[12.5px] text-text-3">Illustrative sample metrics for this prototype — they are not results from Voom.</span>
        </div>
        <div className="grid gap-3.5 sm:grid-cols-3">
          {(em
            ? [
                ["Sample subscribers", "8,412", "+312 this month"],
                ["Sample open rate", "41.2%", "+4.1 pts"],
                ["Sample revenue / send", "AED 1.45", "+AED 0.22"],
              ]
            : [
                ["Sample SMS opt-ins", "3,190", "+184 this month"],
                ["Sample click rate", "11.4%", "+1.8 pts"],
                ["Sample revenue / send", "AED 2.93", "+AED 0.41"],
              ]
          ).map(([a, b, c]) => (
            <Card key={a} className="p-4">
              <span className="text-[12.5px] text-text-2">{a}</span>
              <div className="my-1.5 font-display text-[26px]">{b}</div>
              <span className="text-[12.5px] font-semibold text-green">{c}</span>
            </Card>
          ))}
        </div>
      </div>

      <Card className="p-4">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold">
            {em ? "Email campaigns" : "SMS broadcasts"}
            <span className="ml-2 text-[12.5px] font-normal text-text-3">{visible.length} saved</span>
          </h2>
          <div className="flex flex-wrap gap-1.5">
            {FILTERS.map((filter) => (
              <Chip key={filter.id} active={statusFilter === filter.id} onClick={() => setStatusFilter(filter.id)}>
                {filter.label}
              </Chip>
            ))}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
                <th className="pb-2.5">Campaign</th>
                <th className="pb-2.5">Audience</th>
                <th className="pb-2.5">Draft content</th>
                <th className="pb-2.5">Proposed send</th>
                <th className="pb-2.5">Status</th>
                <th className="pb-2.5 text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.length === 0 && (
                <tr className="border-t border-line">
                  <td colSpan={6} className="py-8 text-center text-sm text-text-3">
                    No {em ? "email" : "SMS"} drafts yet. Create one, or generate a marketing plan so Voom can prepare campaign drafts for you.
                  </td>
                </tr>
              )}
              {visible.map((campaign) => {
                const delivery = deliveryByCampaignId[campaign.id];
                const state = delivery?.state;
                return (
                  <tr key={campaign.id} className="border-t border-line">
                    <td className="py-3.5 pr-3">
                      <b className="block max-w-[220px] truncate">{campaign.name}</b>
                    </td>
                    <td className="py-3.5 pr-3 text-text-2">
                      <span className="block max-w-[200px] truncate">{campaign.audience || "Audience not set"}</span>
                    </td>
                    <td className="py-3.5 pr-3 text-text-2">
                      <span className="block max-w-[260px] truncate">
                        {campaign.kind === "email"
                          ? campaign.subject || campaign.content || "No content yet"
                          : campaign.content || "No message yet"}
                      </span>
                    </td>
                    <td className="py-3.5 pr-3 whitespace-nowrap text-[12.5px] text-text-2">
                      {campaign.proposed_send_at ? formatWhen(campaign.proposed_send_at) : "Not scheduled"}
                    </td>
                    <td className="py-3.5 pr-3 whitespace-nowrap">
                      <div className="flex flex-wrap gap-1.5">
                        <Tag tone={statusTone(campaign.status)}>{statusLabel(campaign.status)}</Tag>
                        {state && <Tag tone={deliveryTone(state)}>{deliveryLabel(state)}</Tag>}
                      </div>
                    </td>
                    <td className="py-3.5 text-right">
                      <div className="flex flex-col items-end gap-1.5">
                        {campaign.status === "approved" && (
                          <span className="text-[11px] font-semibold text-text-3">{deliveryActionText(campaign.kind, delivery)}</span>
                        )}
                        <Btn variant="outline" size="sm" onClick={() => open(<CampaignEditorModal kind={campaign.kind} campaign={campaign} />)}>
                          {campaign.status === "approved" ? "Open" : "Edit"}
                        </Btn>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
          Every draft here is saved in Voom and survives a refresh. Approving marks it ready for an explicit send; Voom never records a campaign as Delivered without provider confirmation.
        </p>
      </Card>

      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <DemoTag />
            <h2 className="font-display text-lg font-semibold">{em ? "Sample email preview" : "Sample SMS preview"}</h2>
          </div>
          {em ? (
            <div className="overflow-hidden rounded-2xl border border-line">
              <div className="voom-grad-deep p-[30px_22px] text-center text-white">
                <div className="font-display text-[22px] font-bold">{brandLabel}</div>
                <p className="mt-1.5 text-[13px] opacity-85">{pack.emailN}</p>
              </div>
              <div className="p-5">
                <h3 className="mb-2.5 font-display text-[17px]">{pack.emailSub}</h3>
                <p className="text-[13.5px] leading-[1.65] text-text-2">Hi {"{{first_name}}"} — {pack.emailBody}</p>
                <Btn variant="primary" size="sm" className="mt-3.5" disabled>
                  Read more →
                </Btn>
                <div className="my-3.5 h-px bg-line" />
                <p className="text-[11px] text-text-3">
                  You&apos;re receiving this because you shop with {brandLabel}. Unsubscribe anytime.
                </p>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-[270px] rounded-[26px] border border-line bg-surface-2 p-4">
              <p className="mb-3 text-center text-[11px] text-text-3">Sample · no message has been sent</p>
              <div className="ml-auto max-w-[88%] break-words rounded-[17px] rounded-br-[5px] bg-brand px-3.5 py-2.5 text-[13px] leading-[1.5] text-white">
                {pack.smsT}
              </div>
            </div>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="voom-grad h-[26px] w-[26px] flex-none rounded-full" />
            <h2 className="font-display text-lg font-semibold">Voom&apos;s recommendation</h2>
            <DemoTag />
          </div>
          {maraTake.map(([t, b]) => (
            <div key={t} className="mb-2.5 flex gap-3 rounded-2xl border border-line p-3.5">
              <span className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px] bg-[var(--brand-soft)] text-brand">
                <Icon name="spark" size={17} />
              </span>
              <div className="min-w-0 flex-1">
                <b className="text-[13.5px]">{t}</b>
                <p className="mb-2 mt-1 text-[13px] text-text-2">{b}</p>
                <Btn variant="outline" size="sm" onClick={() => goTo("plan")}>
                  Review in plan
                </Btn>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

function statusTone(status: CampaignStatus) {
  return status === "approved" ? "t-green" : status === "rejected" ? "t-red" : "t-grey";
}

function statusLabel(status: CampaignStatus) {
  if (status === "approved") return "Approved — ready to send";
  if (status === "rejected") return "Not approved";
  return "Draft";
}

function deliveryTone(status: CampaignDeliveryState) {
  return status === "delivered" ? "t-green" : status === "accepted" ? "t-blue" : status === "failed" ? "t-red" : status === "sending" ? "t-amber" : "t-grey";
}

function deliveryLabel(status: CampaignDeliveryState) {
  if (status === "delivered") return "Delivered";
  if (status === "accepted") return "Accepted";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  return "Ready";
}

function deliveryActionText(kind: "email" | "sms", delivery?: CampaignDeliveryView) {
  if (!delivery) return `Ready — open campaign to send`;
  if (!delivery.provider.configured) return `${delivery.provider.label} not configured`;
  if (delivery.state === "accepted") return `${kind === "email" ? "Email" : "SMS"} accepted — waiting for callback`;
  if (delivery.state === "delivered") return `${kind === "email" ? "Email" : "SMS"} delivered`;
  if (delivery.state === "failed") return `${kind === "email" ? "Email" : "SMS"} failed — open to retry`;
  if (delivery.state === "sending") return `Send in progress`;
  return `Ready — open campaign to send`;
}

function formatWhen(value: string) {
  return new Date(value).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
