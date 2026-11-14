"use client";

import { useState } from "react";
import { useVoomState } from "@/lib/voom/store";
import { nfc } from "@/lib/voom/demoData";
import { creditCostForMedia } from "@/lib/billing/credits";
import { AUTOPILOT_POST_APPROVAL } from "@/lib/voom/automation";
import { getPlanConfig, PLAN_IDS } from "@/lib/billing/plans";

import { Icon } from "@/components/voom/icons";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { AD_SEPARATION, AdSepNote } from "@/components/voom/ui/Notes";

const PLAN_DETAILS = {
  free: ["Plan and draft content with your own media", "Review posts and choose when to schedule them"],
  pro: ["MARA prepares drafts and proposes times", "You review posts before scheduling and choose when to generate media"],
  max: [AUTOPILOT_POST_APPROVAL, "Enable automatic image and video generation within your credit and spending limits"],
};

const FAQS: [string, string][] = [
  [
    "What are Voom credits?",
    `An AI image uses ${creditCostForMedia({ mediaType: "image" })} credits and a short AI video uses ${creditCostForMedia({ mediaType: "video" })}. Planning, copy and scheduling use zero media credits.`,
  ],
  [
    "What happens when I run out of credits?",
    "Voom shows the credits you need and your remaining balance before starting generation. You can still plan, write copy and upload your own media.",
  ],
  [
    "Can Voom spend my ad budget without asking?",
    "No. Voom can never start a campaign, increase a total budget or exceed an approved limit without your explicit permission — and paid advertising isn't connected yet, so nothing can spend today.",
  ],
  [
    "Is billing active?",
    "Billing is offline. You can see your assigned plan and media credits in Settings. Paid subscriptions are unavailable.",
  ],
  [
    "What happens to my content if plans change?",
    "Nothing is deleted. Your drafts, schedules and history stay in Voom regardless of plan.",
  ],
  ["Does my subscription pay for my advertising?", "No. " + AD_SEPARATION],
];

export default function PricingPage() {
  const { plan } = useVoomState();
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  return (
    <div>
      <div className="mx-auto mb-6.5 max-w-[620px] text-center">
        <Tag tone="t-brand">
          <Icon name="crown" size={12} /> Plans & Credits
        </Tag>
        <h1 className="my-3 font-display text-[26px] font-bold sm:text-[32px]">Plans & billing</h1>
        <p className="text-[15px] text-text-2">Compare automation modes and monthly media credits.</p>
        <div className="mt-4 flex flex-wrap justify-center gap-2">
          <Tag>Billed monthly once billing is active</Tag>
          <Tag>
            <Icon name="info" size={12} /> No payment is taken today
          </Tag>
        </div>
        <div className="mx-auto mt-4 max-w-[600px]">
          <AdSepNote />
        </div>
      </div>

      <Card className="mx-auto mb-4 flex max-w-[760px] flex-wrap items-center justify-between gap-3 border-brand bg-[var(--brand-soft)] p-4">
        <div className="flex items-center gap-2.5">
          <Icon name="info" className="text-brand" />
          <span className="text-[13.5px]">
            Your workspace is on the <b>{getPlanConfig(plan).name}</b> plan. Billing is offline. All plans include the content calendar, post approvals and email campaigns. Sending email requires a configured sender and eligible recipients.
          </span>
        </div>
      </Card>

      <div className="grid items-start gap-4 sm:grid-cols-3">
        {PLAN_IDS.map((id) => {
          const p = getPlanConfig(id);
          const cur = plan === p.id;
          return (
            <div
              key={p.id}
              className={`relative rounded-[22px] border-[1.5px] bg-surface p-6.5 ${p.id === "max" ? "border-brand shadow-[0_20px_50px_-24px_var(--brand)] sm:order-first" : "border-line"}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-display text-[19px] font-bold">{p.name}</h3>
                {cur && <Tag tone="t-green">Your plan</Tag>}
              </div>
              <p className="my-1.5 text-[13.3px] text-text-2">{p.allowedModes.map((mode) => mode[0].toUpperCase() + mode.slice(1)).join(" + ")}</p>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-[34px] font-bold tracking-tight">${nfc(p.priceUsd)}</span>
                <span className="text-[13.5px] text-text-3">/month</span>
              </div>
              <div className="mt-1 text-xs text-text-3">{p.priceUsd ? "Software subscription only — ad budget is separate" : "No card required"}</div>
              <Btn variant={p.id === "max" ? "primary" : "outline"} block className="mt-4" disabled>
                {cur ? "Your current plan" : "Available when billing activates"}
              </Btn>
              <ul className="mt-4.5 flex flex-col gap-2.5">
                {PLAN_DETAILS[id].map((f) => (
                  <li key={f} className="flex items-start gap-2 text-[13.5px] text-text-2">
                    <Icon name="check" size={16} className="mt-0.5 flex-none stroke-green" />
                    <span>{f}</span>
                  </li>
                ))}
                <li className="flex items-start gap-2 text-[13.5px] text-text-2">
                  <Icon name={p.allowsExplicitMedia ? "check" : "x"} size={16} className="mt-0.5 flex-none" />
                  <span>{p.allowsExplicitMedia ? `${p.monthlyCredits} AI media credits per month` : "AI media generation is unavailable on Free"}</span>
                </li>
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
              aria-expanded={openFaq === i}
            >
              {q}
              <span className="text-text-3">
                <Icon name={openFaq === i ? "up" : "down"} size={16} />
              </span>
            </button>
            {openFaq === i && <p className="pb-3.5 text-[13.3px] leading-[1.6] text-text-2">{a}</p>}
          </div>
        ))}
      </Card>
    </div>
  );
}
