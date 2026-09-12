"use client";

import { useCallback, useEffect, useState } from "react";

import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import type { CampaignDeliveryState, CampaignDeliveryView, CampaignRecord, CampaignStatus } from "@/lib/voom/types";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { CampaignEditorModal } from "@/components/voom/modals/CampaignEditorModal";
import { Btn, Card, Chip, Tag } from "@/components/voom/ui/primitives";

type StatusFilter = "all" | CampaignStatus;

const FILTERS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "draft", label: "Draft" },
  { id: "approved", label: "Approved" },
  { id: "rejected", label: "Not approved" },
];

const HOW_IT_WORKS: [string, string][] = [
  ["Drafts stay inside Voom", "Campaigns are saved drafts until you approve one and send it explicitly. Nothing is ever sent automatically."],
  ["One real recipient at a time", "A send goes to the verified recipient you choose in the campaign — there is no bulk blast from this screen."],
  ["Delivery is only ever real", "Voom marks a campaign Delivered only after the provider's verified callback confirms it. Failed sends say so and can be retried."],
];

export default function CampaignsPage() {
  const { campTab } = useVoomState();
  const { setCampTab, goTo } = useVoomActions();
  const { open } = useModal();
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
        <Tag>
          <Icon name="info" size={12} /> Delivery status stays truthful — Voom never fabricates a send
        </Tag>
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

      <Card className="mt-3.5 p-4">
        <h2 className="font-display text-lg font-semibold">How email & SMS work in Voom</h2>
        <div className="mt-3 grid gap-2.5 sm:grid-cols-3">
          {HOW_IT_WORKS.map(([title, body]) => (
            <div key={title} className="rounded-2xl border border-line p-3.5">
              <div className="flex items-center gap-2">
                <span className="voom-grad grid h-[26px] w-[26px] flex-none place-items-center rounded-full text-white">
                  <Icon name="check" size={13} />
                </span>
                <b className="text-[13.5px]">{title}</b>
              </div>
              <p className="mt-1.5 text-[12.5px] leading-relaxed text-text-2">{body}</p>
            </div>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <Btn variant="outline" size="sm" onClick={() => goTo("plan")}>
            <Icon name="spark" size={14} /> Review marketing plan
          </Btn>
          <Btn variant="outline" size="sm" onClick={() => goTo("contacts")}>
            <Icon name="users" size={14} /> Manage contacts
          </Btn>
        </div>
      </Card>

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
