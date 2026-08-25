"use client";

import { useState } from "react";
import { useVoomState } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { nfc, PLANS } from "@/lib/voom/demoData";
import { Icon } from "@/components/voom/icons";
import { UpgradeModal } from "@/components/voom/modals/UpgradeModal";
import { DowngradeModal } from "@/components/voom/modals/DowngradeModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { AD_SEPARATION, AdSepNote } from "@/components/voom/ui/Notes";

const FAQS: [string, string][] = [
  [
    "Can MARA spend my ad budget without asking?",
    "MARA can never start a new campaign, increase the total budget or exceed an approved limit without your permission. After approval, MARA may optimise and pause campaigns within that fixed limit.",
  ],
  [
    "What happens to my content if I downgrade?",
    "Nothing is deleted. Scheduled posts beyond your new plan limit pause as drafts until you upgrade again.",
  ],
  [
    "Do you charge per connected channel?",
    "No. Channels are included; plans differ by brands, seats and whether MARA can manage paid spend.",
  ],
  [
    "Is billing live in this prototype?",
    "No. Stripe is not connected and no payment is taken. Upgrading here simulates a checkout so you can see the full flow — a prototype demonstration only.",
  ],
  ["Does my subscription pay for my advertising?", "No. " + AD_SEPARATION],
];

export default function PricingPage() {
  const { plan } = useVoomState();
  const { open } = useModal();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div>
      <div className="mx-auto mb-6.5 max-w-[620px] text-center">
        <Tag tone="t-brand">
          <Icon name="crown" size={12} /> Plans
        </Tag>
        <h1 className="my-3 font-display text-[26px] font-bold sm:text-[32px]">Give MARA more room to work</h1>
        <p className="text-[15px] text-text-2">Start free. Upgrade when she&apos;s earning more than she costs.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Tag>Billed monthly · prototype pricing</Tag>
          <Tag>
            <Icon name="info" size={12} /> No payment is taken
          </Tag>
        </div>
        <div className="mx-auto mt-4 max-w-[600px]">
          <AdSepNote />
        </div>
      </div>

      <div className="grid items-start gap-4 sm:grid-cols-3">
        {PLANS.map((p) => {
          const cur = plan === p.id;
          return (
            <div
              key={p.id}
              className={`relative rounded-[22px] border-[1.5px] bg-surface p-6.5 transition hover:-translate-y-1 hover:shadow-[var(--shadow-lg)] ${p.hot ? "border-brand shadow-[0_20px_50px_-24px_var(--brand)]" : "border-line"} ${p.hot ? "order-first sm:order-none" : ""}`}
            >
              {p.hot && (
                <div className="voom-grad absolute -top-2.5 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full px-3.5 py-1 text-[10px] font-extrabold tracking-[.1em] text-white">
                  MOST POPULAR
                </div>
              )}
              <div className="flex items-center justify-between">
                <h3 className="font-display text-[19px] font-bold">{p.name}</h3>
                {cur && <Tag tone="t-green">Current</Tag>}
              </div>
              <p className="my-1.5 text-[13.3px] text-text-2">{p.blurb}</p>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-[34px] font-bold tracking-tight">AED {nfc(p.m)}</span>
                <span className="text-[13.5px] text-text-3">/month</span>
              </div>
              <div className="mt-1 text-xs text-text-3">{p.m ? "Software subscription only — ad budget is separate" : "No card required"}</div>
              <Btn
                variant={p.hot ? "primary" : "outline"}
                block
                className="mt-4"
                disabled={cur}
                onClick={() => {
                  if (p.id === "free") open(<DowngradeModal />);
                  else open(<UpgradeModal planId={p.id} />);
                }}
              >
                {cur ? "Your current plan" : p.id === "free" ? "Downgrade to Free" : `Upgrade to ${p.name}`}
              </Btn>
              <ul className="mt-4.5 flex flex-col gap-2.5">
                {p.f.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13.5px] text-text-2">
                    <Icon name="check" size={16} className="mt-0.5 flex-none stroke-green" />
                    <span>{f}</span>
                  </li>
                ))}
                {p.off.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13.5px] text-text-2 opacity-40">
                    <Icon name="x" size={16} className="mt-0.5 flex-none stroke-text-3" />
                    <span>{f}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>

      <Card className="mx-auto mt-6 max-w-[900px] p-4">
        <h2 className="mb-3 font-display text-lg font-semibold">Frequently asked</h2>
        {FAQS.map(([q, a], i) => (
          <div key={q} className="border-b border-line last:border-0">
            <button
              className="flex w-full items-center justify-between py-3.5 text-left text-sm font-semibold"
              onClick={() => setOpenFaq(openFaq === i ? null : i)}
            >
              {q}
              <span className="text-text-3">
                <Icon name="plus" size={16} />
              </span>
            </button>
            {openFaq === i && <p className="pb-3.5 text-[13.3px] leading-[1.6] text-text-2">{a}</p>}
          </div>
        ))}
      </Card>
    </div>
  );
}
