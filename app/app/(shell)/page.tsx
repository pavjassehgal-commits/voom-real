"use client";

import { useState } from "react";
import { useVoomActions, useVoomState, CHANNEL_SHARE, KPIS } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon, type IconName } from "@/components/voom/icons";
import { AreaChart } from "@/components/voom/dashboard/AreaChart";
import { PageHead } from "@/components/voom/shell/AppShell";
import { KpiDetailModal } from "@/components/voom/modals/KpiDetailModal";
import { PostDetailModal } from "@/components/voom/modals/PostDetailModal";
import { ComposeModal } from "@/components/voom/modals/ComposeModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { DemoTag } from "@/components/voom/ui/Notes";

export default function DashboardPage() {
  const { brand, posts, insights, displayName } = useVoomState();
  const { goTo, askMara, toast } = useVoomActions();
  const { open } = useModal();
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());

  const hour = new Date().getHours();
  const greet = hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const firstName = displayName.trim().split(" ")[0];
  const brandLabel = brand.name || "your business";

  return (
    <div>
      <PageHead
        title={firstName ? `${greet}, ${firstName}` : greet}
        description={`Here's how ${brandLabel} performed over the last 30 days.`}
        tags={
          <>
            <DemoTag />
            <Tag tone="t-grey">
              <Icon name="info" size={12} /> Every figure on this page is sample data
            </Tag>
          </>
        }
        actions={
          <>
            <select
              className="h-[38px] w-auto rounded-xl border border-line bg-surface-2 px-3 text-sm"
              onChange={(e) => toast("Range set to " + e.target.value, "info")}
            >
              <option>Last 30 days</option>
              <option>Last 7 days</option>
              <option>This quarter</option>
              <option>Year to date</option>
            </select>
            <Btn variant="ghost" size="sm" onClick={() => toast("Report exported as PDF", "ok", true)}>
              <Icon name="down" size={14} /> Export
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => goTo("mara")}>
              <Icon name="spark" size={14} /> Ask MARA
            </Btn>
          </>
        }
      />

      <div className="mb-4 grid grid-cols-2 gap-3.5 lg:grid-cols-4">
        {KPIS.map((k) => (
          <button
            key={k.k}
            onClick={() => open(<KpiDetailModal kpiKey={k.k} />)}
            className="rounded-[var(--r-lg)] border border-line bg-surface p-4 text-left shadow-[var(--shadow)] transition hover:-translate-y-0.5 hover:border-line-2"
          >
            <div className="flex items-center justify-between">
              <span className="text-[12.5px] font-medium text-text-2">{k.lab}</span>
              <span
                className="grid h-6.5 w-6.5 place-items-center rounded-lg"
                style={{ background: `color-mix(in srgb, var(${k.c}) 14%, transparent)`, color: `var(${k.c})` }}
              >
                <Icon name={k.ic as IconName} size={14} />
              </span>
            </div>
            <div className="my-2 font-display text-[22px] font-bold tracking-tight sm:text-[27px]">{k.val}</div>
            <div className={`flex items-center gap-1 text-[12.5px] font-semibold ${k.up ? "text-green" : "text-red"}`}>
              <Icon name={k.up ? "up" : "down"} size={14} />
              {k.d}
              <span className="hidden font-medium text-text-3 sm:inline">vs last period</span>
            </div>
          </button>
        ))}
      </div>

      <div className="mb-3.5 grid gap-3.5 lg:grid-cols-[1.55fr_1fr]">
        <Card className="p-4">
          <div className="mb-1 flex items-start justify-between">
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="font-display text-lg font-semibold">Reach & engagement</h2>
                <DemoTag />
              </div>
              <p className="mt-0.5 text-[12.5px] text-text-3">Thousands, last 30 days — sample dataset</p>
            </div>
            <div className="hidden gap-4 text-[12.5px] text-text-2 sm:flex">
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: "#e8481f" }} /> Reach
              </span>
              <span className="flex items-center gap-1.5">
                <i className="inline-block h-2.5 w-2.5 rounded-[3px]" style={{ background: "#0f6f68" }} /> Engagements
              </span>
            </div>
          </div>
          <div className="relative mt-1.5 h-[220px]">
            <AreaChart />
          </div>
        </Card>

        <Card className="p-4">
          <h2 className="mb-1.5 font-display text-lg font-semibold">Where growth came from</h2>
          <p className="mb-2.5 text-[12.5px] text-text-3">Share of total engagements</p>
          {CHANNEL_SHARE.map((c) => (
            <div key={c.n} className="flex items-center gap-3 py-2.5">
              <span className="w-[106px] flex-none truncate text-[13px]">{c.n}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-surface-2">
                <div className="h-full rounded-full transition-[width]" style={{ width: `${c.v}%`, background: c.c }} />
              </div>
              <b className="w-[34px] text-right font-mono text-[12.5px]">{c.v}%</b>
            </div>
          ))}
          <div className="my-3.5 h-px bg-line" />
          <Btn variant="ghost" size="sm" block onClick={() => goTo("campaigns")}>
            Break down by campaign <Icon name="arrow" size={14} />
          </Btn>
        </Card>
      </div>

      <div className="mb-3.5 grid gap-3.5 lg:grid-cols-[1.55fr_1fr]">
        <Card className="p-4">
          <div className="mb-3.5 flex items-center justify-between">
            <div className="flex flex-wrap items-center gap-2">
              <span
                className="relative h-[26px] w-[26px] flex-none rounded-full"
                style={{ background: "conic-gradient(from 200deg,#e8481f,#f2a516,#0f6f68,#e8481f)", boxShadow: "0 0 0 3px var(--surface)" }}
              >
                <span className="absolute inset-1 rounded-full bg-surface" />
                <span className="voom-grad absolute rounded-full" style={{ inset: 7 }} />
              </span>
              <h2 className="font-display text-lg font-semibold">MARA&apos;s recommendations</h2>
              <DemoTag />
            </div>
            <Btn variant="ghost" size="sm" onClick={() => goTo("mara")}>
              Open chat
            </Btn>
          </div>
          {insights
            .map((x, i) => ({ x, i }))
            .filter(({ i }) => !dismissed.has(i))
            .map(({ x, i }) => (
              <div key={x.t} className="mb-2.5 flex gap-3 rounded-2xl border border-line p-3.5 transition hover:border-brand">
                <span
                  className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px]"
                  style={{ background: `color-mix(in srgb, var(${x.c}) 14%, transparent)`, color: `var(${x.c})` }}
                >
                  <Icon name={x.ic as IconName} size={17} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <b className="text-[13.8px]">{x.t}</b>
                    {x.ex && <Tag tone="t-grey">Example result</Tag>}
                  </div>
                  <p className="my-1.5 text-[13px] text-text-2">{x.b}</p>
                  <div className="flex flex-wrap gap-2">
                    <Btn variant="primary" size="sm" onClick={() => goTo(x.go)}>
                      {x.act}
                    </Btn>
                    <Btn variant="outline" size="sm" onClick={() => askMara(`Tell me more about: ${x.t}`, () => goTo("mara"))}>
                      Ask MARA
                    </Btn>
                    <Btn
                      variant="plain"
                      size="sm"
                      onClick={() => {
                        setDismissed((prev) => new Set(prev).add(i));
                        toast("Dismissed", "info");
                      }}
                    >
                      Dismiss
                    </Btn>
                  </div>
                </div>
              </div>
            ))}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between">
            <h2 className="font-display text-lg font-semibold">Coming up</h2>
            <Btn variant="ghost" size="sm" onClick={() => goTo("calendar")}>
              Calendar
            </Btn>
          </div>
          {posts.slice(0, 6).map((p) => {
            const idx = posts.indexOf(p);
            return (
              <div
                key={idx}
                className="flex cursor-pointer items-center gap-2.5 border-b border-line py-2.5 last:border-0"
                onClick={() => open(<PostDetailModal index={idx} />)}
              >
                <span className="h-2 w-2 flex-none rounded-full" style={{ background: p.c }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.3px] font-semibold">{p.t}</div>
                  <span className="text-[11.5px] text-text-3">
                    Aug {p.d} · {p.time}
                  </span>
                </div>
                <Tag tone={p.st === "Scheduled" ? "t-green" : p.st === "Draft" ? "t-amber" : "t-grey"}>{p.st}</Tag>
              </div>
            );
          })}
          <Btn variant="primary" size="sm" block className="mt-3.5" onClick={() => open(<ComposeModal />)}>
            <Icon name="plus" size={14} /> Create post
          </Btn>
        </Card>
      </div>

      <CampaignTable />
    </div>
  );
}

function CampaignTable() {
  const { campaignsTable } = useVoomState();
  const { toast } = useVoomActions();
  return (
    <Card className="mt-3.5 p-4">
      <div className="mb-3.5 flex items-center justify-between">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-semibold">Campaign performance</h2>
          <DemoTag />
        </div>
        <Btn variant="ghost" size="sm" onClick={() => toast("Full report exported", "ok", true)}>
          <Icon name="down" size={14} /> Export CSV
        </Btn>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
              <th className="pb-2.5">Campaign</th>
              <th className="pb-2.5">Channel</th>
              <th className="pb-2.5">Sent / Impr.</th>
              <th className="pb-2.5">Open / View</th>
              <th className="pb-2.5">Click</th>
              <th className="pb-2.5 text-right">Revenue</th>
              <th className="pb-2.5">Status</th>
            </tr>
          </thead>
          <tbody>
            {campaignsTable.map((r) => (
              <tr
                key={r.n}
                className="cursor-pointer border-t border-line hover:bg-surface-2"
                onClick={() => toast(`Opening "${r.n}" report (demo)`, "info")}
              >
                <td className="py-3.5">
                  <b>{r.n}</b>
                </td>
                <td className="py-3.5 text-text-2">{r.ch}</td>
                <td className="py-3.5 font-mono text-text-2">{r.sent}</td>
                <td className="py-3.5 font-mono">{r.open}</td>
                <td className="py-3.5 font-mono">{r.clk}</td>
                <td className="py-3.5 text-right font-mono">
                  <b>{r.rev}</b>
                </td>
                <td className="py-3.5">
                  <Tag tone={r.t}>{r.st}</Tag>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
