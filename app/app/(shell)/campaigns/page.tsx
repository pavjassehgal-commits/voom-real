"use client";

import { useCallback, useEffect, useState } from "react";

import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { SendCampaignModal } from "@/components/voom/modals/SendCampaignModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { DemoTag } from "@/components/voom/ui/Notes";

export default function CampaignsPage() {
  const { campTab, emails, sms, brand } = useVoomState();
  const { setCampTab, goTo, toast, openNewCampaign } = useVoomActions();
  const { open } = useModal();
  const pack = useCurrentPack();
  const brandLabel = brand.name || "your business";
  const [savedCampaigns, setSavedCampaigns] = useState<Array<{ id: string; kind: "email" | "sms"; name: string; audience: string; proposed_send_at: string | null; status: string }>>([]);
  const [campaignError, setCampaignError] = useState<string | null>(null);

  const loadCampaigns = useCallback(async () => {
    try { const response = await fetch("/api/voom/campaigns", { cache: "no-store" }); const body = await response.json() as { campaigns?: typeof savedCampaigns; error?: string }; if (!response.ok) throw new Error(body.error || "Campaign drafts couldn't load."); setSavedCampaigns(body.campaigns ?? []); setCampaignError(null); }
    catch (reason) { setCampaignError(reason instanceof Error ? reason.message : "Campaign drafts couldn't load."); }
  }, []);
  useEffect(() => { const timer = window.setTimeout(() => void loadCampaigns(), 0); return () => window.clearTimeout(timer); }, [loadCampaigns]);
  useEffect(() => { const refresh = () => void loadCampaigns(); window.addEventListener("voom:data-changed", refresh); return () => window.removeEventListener("voom:data-changed", refresh); }, [loadCampaigns]);

  const em = campTab === "email";
  const savedList = savedCampaigns.filter((item) => item.kind === campTab).map((item) => ({ id: item.id, n: item.name, seg: item.audience || "Audience not set", st: "Draft" as const, t: "t-grey", o: "—", c: "—", r: "—", when: item.proposed_send_at ? new Date(item.proposed_send_at).toLocaleString() : "Not scheduled" }));
  const list = [...savedList, ...(em ? emails : sms)];

  const stats = em
    ? [
        ["Subscribers", "8,412", "+312 this month"],
        ["Avg. open rate", "41.2%", "+4.1 pts"],
        ["Revenue / send", "AED 1.45", "+AED 0.22"],
      ]
    : [
        ["SMS opt-ins", "3,190", "+184 this month"],
        ["Avg. click rate", "11.4%", "+1.8 pts"],
        ["Revenue / send", "AED 2.93", "+AED 0.41"],
      ];

  const maraTake = em
    ? [
        ["Win-back 1,284 cold subscribers", "Projected +AED 3,100 recovered"],
        ["Move sends to Tuesday 9 AM", "Your opens are 12% higher then"],
        ["Segment out non-openers before launch", "Protects your sender reputation"],
      ]
    : [
        ["Send only on restock days", "Over-texting is the #1 cause of opt-outs"],
        ["Keep under 160 characters", "Splitting messages doubles your cost"],
        ["Add SMS opt-in to checkout", "You're leaving ~40 signups/week on the table"],
      ];

  function openNew() {
    openNewCampaign();
    open(<SendCampaignModal kind={campTab} index={0} />);
  }

  return (
    <div>
      <PageHead
        title="Email & SMS"
        description="Campaigns, flows and broadcasts — prepared by Voom, approved by you."
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
            <Icon name="info" size={12} /> No provider connected — sends are simulated
          </Tag>
        </div>
      </div>

      <div className="mb-3.5 grid gap-3.5 sm:grid-cols-3">
        {stats.map(([a, b, c]) => (
          <Card key={a} className="p-4">
            <span className="text-[12.5px] text-text-2">{a}</span>
            <div className="my-1.5 font-display text-[26px]">{b}</div>
            <span className="text-[12.5px] font-semibold text-green">{c}</span>
          </Card>
        ))}
      </div>

      <Card className="p-4">
        <div className="mb-3.5 flex items-center justify-between">
          <h2 className="font-display text-lg font-semibold">{em ? "Email campaigns" : "SMS broadcasts"}</h2>
          <Btn variant="ghost" size="sm" onClick={() => toast("Filters are visual-only", "info")}>
            <Icon name="filter" size={14} /> Filter
          </Btn>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
                <th className="pb-2.5">Campaign</th>
                <th className="pb-2.5">Audience</th>
                <th className="pb-2.5">{em ? "Open" : "Delivered"}</th>
                <th className="pb-2.5">Click</th>
                <th className="pb-2.5 text-right">Revenue</th>
                <th className="pb-2.5">When</th>
                <th className="pb-2.5" />
              </tr>
            </thead>
            <tbody>
              {list.map((c, i) => (
                <tr key={`${c.n}-${i}`} className="border-t border-line">
                  <td className="py-3.5">
                    <b>{c.n}</b>
                    <div className="mt-1">
                      <Tag tone={c.t}>{c.st}</Tag>
                    </div>
                  </td>
                  <td className="py-3.5 text-text-2">{c.seg}</td>
                  <td className="py-3.5 font-mono">{c.o}</td>
                  <td className="py-3.5 font-mono">{c.c}</td>
                  <td className="py-3.5 text-right font-mono">
                    <b>{c.r}</b>
                  </td>
                  <td className="py-3.5 text-[12.5px] text-text-2">{c.when}</td>
                  <td className="whitespace-nowrap py-3.5 text-right">
                    {"id" in c ? (
                      <Btn variant="outline" size="sm" onClick={() => toast(`“${c.n}” is saved as a draft. Nothing has been sent.`, "info")}>Saved draft</Btn>
                    ) : c.st === "Draft" ? (
                      <Btn variant="primary" size="sm" onClick={() => open(<SendCampaignModal kind={campTab} index={i} />)}>
                        Review & send
                      </Btn>
                    ) : c.st === "Scheduled" ? (
                      <Btn variant="outline" size="sm" onClick={() => open(<SendCampaignModal kind={campTab} index={i} />)}>
                        Edit
                      </Btn>
                    ) : (
                      <Btn variant="ghost" size="sm" onClick={() => toast(`Opening report for "${c.n}" (demo)`, "info")}>
                        Report
                      </Btn>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>

      <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-3 font-display text-lg font-semibold">{em ? "Email preview" : "SMS preview"}</h2>
          {em ? (
            <div className="overflow-hidden rounded-2xl border border-line">
              <div className="voom-grad-deep p-[30px_22px] text-center text-white">
                <div className="font-display text-[22px] font-bold">{brandLabel}</div>
                <p className="mt-1.5 text-[13px] opacity-85">{pack.emailN}</p>
              </div>
              <div className="p-5">
                <h3 className="mb-2.5 font-display text-[17px]">{pack.emailSub}</h3>
                <p className="text-[13.5px] leading-[1.65] text-text-2">Hi {"{{first_name}}"} — {pack.emailBody}</p>
                <Btn variant="primary" size="sm" className="mt-3.5">
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
              <p className="mb-3 text-center text-[11px] text-text-3">Today 11:00 AM</p>
              <div className="ml-auto max-w-[88%] break-words rounded-[17px] rounded-br-[5px] bg-brand px-3.5 py-2.5 text-[13px] leading-[1.5] text-white">
                {pack.smsT}
              </div>
              <div className="mt-1.5 flex justify-end">
                <span className="text-[10.5px] text-text-3">Delivered</span>
              </div>
            </div>
          )}
        </Card>
        <Card className="p-4">
          <div className="mb-3 flex items-center gap-2">
            <span className="voom-grad h-[26px] w-[26px] flex-none rounded-full" />
            <h2 className="font-display text-lg font-semibold">Voom&apos;s recommendation</h2>
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
