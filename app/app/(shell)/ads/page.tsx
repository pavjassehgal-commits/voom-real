"use client";

import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { nfc } from "@/lib/voom/demoData";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Donut } from "@/components/voom/ads/Donut";
import { MaxRequiredModal } from "@/components/voom/modals/MaxRequiredModal";
import { DeclineAdsModal } from "@/components/voom/modals/DeclineAdsModal";
import { ApproveAdsModal } from "@/components/voom/modals/ApproveAdsModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { AdSepNote, DemoTag, ExTag, ProtoNote } from "@/components/voom/ui/Notes";

const STEPS = [
  "Connect your Meta or Google advertising account.",
  "Add your payment card directly to Meta or Google.",
  "MARA creates a campaign and suggests a budget.",
  "You approve, reduce or decline it.",
  "Meta or Google charges your card gradually as advertisements run.",
  "MARA optimises within the amount you approved.",
  "Any increase requires another approval.",
];

const BUDGET_CHIPS = [600, 800, 1200, 2000];

export default function AdsPage() {
  const { adAlloc, adTotal, approvedPlan, changeMode, plan, adHistory } = useVoomState();
  const { setAdTotal, setAdAlloc, resetAlloc, normalizeAlloc, requestChange, cancelChange, pauseAds, resumeAds, askMara, goTo, toast } =
    useVoomActions();
  const { open } = useModal();

  const sum = adAlloc.reduce((a, b) => a + b.pct, 0);
  const proj = Math.round(adAlloc.reduce((a, b) => a + (adTotal * b.pct) / 100 * parseFloat(b.roas), 0));
  const roas = (proj / adTotal || 0).toFixed(1);
  const locked = plan !== "max";
  const editable = !approvedPlan || changeMode;
  const spentPct = approvedPlan ? Math.min(100, Math.round((approvedPlan.spent / approvedPlan.limit) * 100)) : 0;

  function guardedApprove(isChange: boolean) {
    if (sum !== 100) {
      toast(`Allocation is ${sum}% — balance it to 100% first`, "err");
      return;
    }
    if (locked) {
      open(<MaxRequiredModal />);
      return;
    }
    open(<ApproveAdsModal isChange={isChange} />);
  }

  function submitChange() {
    if (!approvedPlan) return;
    if (sum !== 100) {
      toast(`Allocation is ${sum}% — balance it to 100% first`, "err");
      return;
    }
    if (adTotal === approvedPlan.limit && JSON.stringify(adAlloc) === JSON.stringify(approvedPlan.alloc)) {
      toast("Nothing has changed yet", "err");
      return;
    }
    if (adTotal < approvedPlan.spent) {
      toast(`AED ${nfc(approvedPlan.spent)} is already spent — the new limit cannot be lower`, "err");
      return;
    }
    guardedApprove(true);
  }

  return (
    <div>
      <PageHead
        title="Paid advertising"
        description="MARA builds the allocation. Nothing spends until you approve it."
        tags={
          <>
            <DemoTag />
            <Tag>
              <Icon name="info" size={12} /> Optional — separate from your subscription
            </Tag>
          </>
        }
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={() => askMara("Explain this ad budget", () => goTo("mara"))}>
              <Icon name="spark" size={14} /> Ask MARA why
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => toast("Spend history exported", "ok", true)}>
              <Icon name="down" size={14} /> Export
            </Btn>
          </>
        }
      />

      <div className="mb-3.5">
        <AdSepNote />
      </div>

      {locked && (
        <Card className="mb-3.5 flex flex-wrap items-center justify-between gap-3 border-brand bg-[var(--brand-soft)] p-3.5">
          <div className="flex items-center gap-2.5">
            <Icon name="crown" className="text-brand" />
            <span className="text-[13.5px]">
              Paid ad management is a <b>Max</b> feature. You can review the plan below — approving requires an upgrade.
            </span>
          </div>
          <Btn variant="primary" size="sm" onClick={() => goTo("pricing")}>
            See Max
          </Btn>
        </Card>
      )}

      {approvedPlan && !changeMode && (
        <Card className={`mb-3.5 p-4 ${approvedPlan.paused ? "border-amber" : "border-green"}`}>
          <div className="mb-3.5 flex flex-wrap items-start justify-between gap-3">
            <div className="flex items-start gap-2.5">
              <span className={`mt-0.5 grid place-items-center ${approvedPlan.paused ? "text-amber" : "text-green"}`}>
                <Icon name={approvedPlan.paused ? "clock" : "check"} />
              </span>
              <div>
                <div className="flex flex-wrap items-center gap-2">
                  <b className="text-[15px]">Approved campaign</b>
                  <Tag tone={approvedPlan.paused ? "t-amber" : "t-green"}>{approvedPlan.paused ? "Spend paused" : "Running"}</Tag>
                  <Tag>
                    <Icon name="shield" size={12} /> Budget locked
                  </Tag>
                </div>
                <div className="mt-0.5 text-[12.5px] text-text-3">MARA may optimise and pause campaigns inside this limit. She cannot increase it.</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant={approvedPlan.paused ? "primary" : "danger"} size="sm" onClick={approvedPlan.paused ? resumeAds : pauseAds}>
                <Icon name={approvedPlan.paused ? "play" : "clock"} size={14} /> {approvedPlan.paused ? "Resume spend" : "Pause spend"}
              </Btn>
              <Btn variant="outline" size="sm" onClick={requestChange}>
                <Icon name="edit" size={14} /> Request budget change
              </Btn>
            </div>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-3">
            <div className="rounded-xl bg-surface-2 p-2.5 text-center">
              <b className="block font-display text-[19px]">AED {nfc(approvedPlan.limit)}</b>
              <span className="text-[11px] text-text-3">Approved limit</span>
            </div>
            <div className="rounded-xl bg-surface-2 p-2.5 text-center">
              <b className="block font-display text-[19px]">AED {nfc(approvedPlan.spent)}</b>
              <span className="text-[11px] text-text-3">Spent so far</span>
            </div>
            <div className="rounded-xl bg-surface-2 p-2.5 text-center">
              <b className="block font-display text-[19px]">AED {nfc(approvedPlan.limit - approvedPlan.spent)}</b>
              <span className="text-[11px] text-text-3">Remaining</span>
            </div>
          </div>
          <div className="mt-3.5">
            <div className="mb-1.5 flex items-center justify-between text-xs text-text-2">
              <span>{spentPct}% of approved limit used</span>
              <span className="font-mono">
                AED {nfc(approvedPlan.spent)} / AED {nfc(approvedPlan.limit)}
              </span>
            </div>
            <div className="h-2.5 overflow-hidden rounded-full bg-surface-2">
              <div className="h-full rounded-full" style={{ width: `${spentPct}%`, background: approvedPlan.paused ? "var(--amber)" : "var(--green)" }} />
            </div>
          </div>
          <div className="my-3.5 h-px bg-line" />
          <div className="flex flex-wrap gap-5.5">
            <div>
              <div className="text-[11.5px] text-text-3">Start date</div>
              <b className="text-[13.5px]">{approvedPlan.start}</b>
            </div>
            <div>
              <div className="text-[11.5px] text-text-3">End date</div>
              <b className="text-[13.5px]">{approvedPlan.end}</b>
            </div>
            <div>
              <div className="text-[11.5px] text-text-3">Campaigns</div>
              <b className="text-[13.5px]">{approvedPlan.alloc.length}</b>
            </div>
          </div>
          <div className="mt-3.5">
            <ProtoNote />
          </div>
        </Card>
      )}

      {changeMode && approvedPlan && (
        <Card className="mb-3.5 border-amber bg-amber/[.08] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <div className="max-w-[560px]">
              <div className="flex items-center gap-2">
                <Icon name="warn" className="text-amber" />
                <b className="text-[15px]">Budget change request — not approved yet</b>
              </div>
              <p className="mt-2 text-[13.3px] leading-[1.6] text-text-2">
                Your approved limit of <b>AED {nfc(approvedPlan.limit)}</b> is still the only amount MARA may spend.{" "}
                <b>No additional money can be spent until you explicitly approve the new amount.</b>
              </p>
              <div className="mt-3 flex flex-wrap gap-4.5">
                <div>
                  <div className="text-[11.5px] text-text-3">Currently approved</div>
                  <b className="font-mono text-[15px]">AED {nfc(approvedPlan.limit)}</b>
                </div>
                <div className="grid place-items-center text-text-3">
                  <Icon name="arrow" />
                </div>
                <div>
                  <div className="text-[11.5px] text-text-3">Proposed</div>
                  <b className={`font-mono text-[15px] ${adTotal > approvedPlan.limit ? "text-red" : "text-green"}`}>AED {nfc(adTotal)}</b>
                </div>
                <div>
                  <div className="text-[11.5px] text-text-3">Difference</div>
                  <b className="font-mono text-[15px]">
                    {adTotal >= approvedPlan.limit ? "+" : "−"}AED {nfc(Math.abs(adTotal - approvedPlan.limit))}
                  </b>
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant="ghost" size="sm" onClick={cancelChange}>
                Cancel change
              </Btn>
              <Btn variant="primary" size="sm" onClick={submitChange}>
                <Icon name="check" size={14} /> Submit for approval
              </Btn>
            </div>
          </div>
        </Card>
      )}

      {!approvedPlan && !changeMode && (
        <div className="voom-grad-deep relative mb-3.5 overflow-hidden rounded-[22px] p-6.5 text-white">
          <div className="flex flex-wrap items-center justify-between gap-4.5">
            <div className="max-w-[460px]">
              <span className="inline-flex items-center gap-1 rounded-full bg-white/20 px-2.5 py-1 text-[11.5px] font-semibold">
                <Icon name="clock" size={12} /> Awaiting your approval
              </span>
              <h2 className="my-3 font-display text-2xl font-bold">MARA suggests AED {nfc(adTotal)} over 14 days</h2>
              <p className="text-sm leading-[1.6] opacity-90">
                Weighted toward your Reels, because that&apos;s where reach compounds fastest in this demo dataset. Nothing is spent until you approve it,
                and the money is charged by your own ad account — never by your Voom subscription.
              </p>
              <div className="mt-3 flex flex-wrap gap-2.5">
                <Btn variant="plain" className="bg-white text-[#a82c08] hover:bg-white/90" onClick={() => guardedApprove(false)}>
                  <Icon name="check" size={14} /> Approve AED {nfc(adTotal)}
                </Btn>
                <Btn
                  variant="plain"
                  className="bg-white/18 text-white hover:bg-white/25"
                  onClick={() => document.querySelector<HTMLInputElement>('input[type="range"]')?.scrollIntoView({ behavior: "smooth", block: "center" })}
                >
                  Adjust budget
                </Btn>
                <Btn variant="plain" className="border border-white/40 text-white hover:bg-white/10" onClick={() => open(<DeclineAdsModal />)}>
                  Decline
                </Btn>
              </div>
            </div>
            <div className="grid place-items-center text-white">
              <Donut />
            </div>
          </div>
        </div>
      )}

      <div className="grid gap-3.5 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-1.5 flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="font-display text-lg font-semibold">Allocation</h2>
              <p className="mt-0.5 text-[12.5px] text-text-3">{editable ? "Drag to rebalance — total must be 100%" : "Locked by your approval"}</p>
            </div>
            <div className="flex flex-wrap items-center gap-1.5">
              {!editable && (
                <Tag>
                  <Icon name="shield" size={12} /> Locked
                </Tag>
              )}
              <Tag tone={sum === 100 ? "t-green" : "t-red"}>{sum}% allocated</Tag>
            </div>
          </div>
          <div className="my-3.5 h-px bg-line" />
          {adAlloc.map((a, i) => (
            <div key={a.n} className="flex items-center gap-3.5 border-b border-line py-3.5 last:border-0">
              <span className="h-[34px] w-2.5 flex-none rounded-[5px]" style={{ background: a.c }} />
              <div className="min-w-0 flex-1">
                <div className="mb-1.5 flex items-center justify-between gap-2">
                  <div className="min-w-0 truncate">
                    <b className="text-[13.5px]">{a.n}</b>
                    <div className="text-[11.5px] text-text-3">
                      {a.ch} · past ROAS {a.roas}
                    </div>
                  </div>
                  <b className="flex-none font-mono text-[13.5px]">AED {nfc(Math.round((adTotal * a.pct) / 100))}</b>
                </div>
                <div className="flex items-center gap-2.5">
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={a.pct}
                    disabled={!editable}
                    onChange={(e) => setAdAlloc(i, +e.target.value)}
                    className="flex-1 accent-brand disabled:opacity-45"
                  />
                  <b className="w-[38px] text-right font-mono text-[12.5px]">{a.pct}%</b>
                </div>
              </div>
            </div>
          ))}
          <div className="mt-3.5 flex flex-wrap justify-between gap-2">
            <Btn variant="ghost" size="sm" disabled={!editable} onClick={resetAlloc}>
              <Icon name="spark" size={14} /> Reset to MARA&apos;s split
            </Btn>
            <Btn variant="outline" size="sm" disabled={!editable} onClick={normalizeAlloc}>
              Balance to 100%
            </Btn>
          </div>
          {!editable && (
            <p className="mt-3 text-xs leading-[1.55] text-text-3">
              These controls unlock only inside a budget change request, which needs your approval before anything else is spent.
            </p>
          )}
        </Card>

        <div>
          <Card className="mb-3.5 p-4">
            <div className="mb-1 flex flex-wrap items-center gap-1.5">
              <h2 className="font-display text-lg font-semibold">Example scenario</h2>
              <ExTag />
            </div>
            <p className="mb-3 text-[12.5px] text-text-3">These figures demonstrate how ROAS works. They are not guaranteed results.</p>
            <div className="grid grid-cols-2 gap-2.5">
              <div className="rounded-xl bg-surface-2 p-2.5 text-center">
                <b className="block font-display text-[19px]">AED {nfc(adTotal)}</b>
                <span className="text-[11px] text-text-3">Ad spend</span>
              </div>
              <div className="rounded-xl bg-surface-2 p-2.5 text-center">
                <b className="block font-display text-[19px]">AED {nfc(proj)}</b>
                <span className="text-[11px] text-text-3">Tracked revenue</span>
              </div>
              <div className="rounded-xl bg-surface-2 p-2.5 text-center">
                <b className="block font-display text-[19px]">{roas}×</b>
                <span className="text-[11px] text-text-3">ROAS</span>
              </div>
              <div className="rounded-xl bg-surface-2 p-2.5 text-center">
                <b className="block font-display text-[19px]">~148</b>
                <span className="text-[11px] text-text-3">Est. new customers</span>
              </div>
            </div>
            <Card className="mt-3 bg-surface-2 p-3.5">
              <div className="flex items-start gap-2.5">
                <Icon name="info" className="text-text-3" />
                <p className="text-[12.8px] leading-[1.6] text-text-2">
                  <b>4× ROAS</b> means AED 4 in tracked revenue for every AED 1 spent on advertising. Revenue is not the same as profit.
                </p>
              </div>
            </Card>
            <div className="my-3.5 h-px bg-line" />
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <label className="text-[12.5px] font-semibold text-text-2">Total budget</label>
              {!editable && (
                <Tag>
                  <Icon name="shield" size={12} /> Locked
                </Tag>
              )}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {BUDGET_CHIPS.map((v) => (
                <button
                  key={v}
                  disabled={!editable}
                  onClick={() => setAdTotal(v)}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-3.5 py-1.5 text-[13px] font-medium transition disabled:pointer-events-none disabled:opacity-40 ${adTotal === v ? "border-brand bg-[var(--brand-soft)] font-semibold text-brand" : "border-line bg-surface-2 text-text-2 hover:border-brand hover:text-text"}`}
                >
                  AED {nfc(v)}
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-2.5">
              <input
                type="range"
                min={200}
                max={5000}
                step={100}
                value={adTotal}
                disabled={!editable}
                onChange={(e) => setAdTotal(+e.target.value)}
                className="flex-1 accent-brand disabled:opacity-45"
              />
              <b className="w-[86px] flex-none whitespace-nowrap text-right font-mono">AED {nfc(adTotal)}</b>
            </div>
            {!editable && approvedPlan && (
              <p className="mt-2.5 text-xs leading-[1.55] text-text-3">
                Your approved limit is fixed at <b>AED {nfc(approvedPlan.limit)}</b>. Use <b>Request budget change</b> to propose a different amount.
              </p>
            )}
          </Card>
          <Card className="border-brand bg-[var(--brand-soft)] p-4">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 h-2.5 w-2.5 flex-none rounded-full voom-grad" />
              <div>
                <b className="text-[13.5px]">What MARA may and may not do</b>
                <ul className="mt-2 list-none space-y-2 text-[12.8px] leading-[1.5] text-text-2">
                  <li>May pause any campaign below 1.5× ROAS after AED 80 spend</li>
                  <li>May move spend between campaigns inside the approved limit</li>
                  <li>
                    <b>May never</b> exceed the approved limit, even if performance is strong
                  </li>
                  <li>
                    <b>May never</b> start a new campaign or raise the limit without your approval
                  </li>
                </ul>
              </div>
            </div>
          </Card>
        </div>
      </div>

      <Card className="mt-3.5 p-4">
        <h2 className="mb-1 font-display text-lg font-semibold">How paid advertising works</h2>
        <p className="mb-4 text-[12.5px] text-text-3">Where the money actually goes, step by step.</p>
        <div className="flex flex-col gap-3">
          {STEPS.map((t, i) => (
            <div key={t} className="flex items-start gap-3">
              <span className="grid h-[26px] w-[26px] flex-none place-items-center rounded-[8px] border border-line bg-surface-2 font-mono text-[11.5px] font-semibold text-text-2">
                {i + 1}
              </span>
              <span className="pt-0.5 text-[13.5px] leading-[1.55]">{t}</span>
            </div>
          ))}
        </div>
        <Card className="mt-4 bg-surface-2 p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="shield" className="text-brand" />
            <p className="text-[13px] leading-[1.6]">
              <b>Voom does not receive or store your advertising money or advertising card details.</b>
            </p>
          </div>
        </Card>
      </Card>

      <Card className="mt-3.5 p-4">
        <div className="mb-3.5 flex flex-wrap items-center gap-2">
          <h2 className="font-display text-lg font-semibold">Spend history</h2>
          <DemoTag />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-[13.5px]">
            <thead>
              <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
                <th className="pb-2.5">Campaign</th>
                <th className="pb-2.5">Budget</th>
                <th className="pb-2.5">ROAS</th>
                <th className="pb-2.5">Period</th>
                <th className="pb-2.5">Status</th>
              </tr>
            </thead>
            <tbody>
              {adHistory.map((h) => (
                <tr key={h.n} className="border-t border-line">
                  <td className="py-3.5">
                    <b>{h.n}</b>
                  </td>
                  <td className="py-3.5 font-mono">{h.amt}</td>
                  <td className={`py-3.5 font-mono font-semibold ${parseFloat(h.roas) >= 2 ? "text-green" : "text-red"}`}>{h.roas}</td>
                  <td className="py-3.5 text-[12.5px] text-text-2">{h.when}</td>
                  <td className="py-3.5">
                    <Tag tone={h.t}>{h.st}</Tag>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
