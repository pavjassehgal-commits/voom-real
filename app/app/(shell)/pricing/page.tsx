"use client";

import { useState } from "react";
import { useVoomState } from "@/lib/voom/store";
import { nfc } from "@/lib/voom/demoData";
import { getPlanConfig } from "@/lib/billing/plans";

const PLANS = [
  {
    id: "free" as const,
    name: "Free",
    get m() { return getPlanConfig("free").priceUsd; },
    y: 0,
    blurb: getPlanConfig("free").blurb,
    hot: false,
    f: [
      "Manual mode only — You control execution. MARA helps when you ask.",
      "Plan, draft and upload your own media",
      "No AI image/video generation (0 credits)",
      "No Autopilot",
      "Approvals & Content Calendar",
      "Instagram Posts, Reels & Stories (own assets)",
    ],
    off: ["AI generation with MARA", "Assisted mode", "Autopilot mode", "Automatic paid media"],
  },
  {
    id: "pro" as const,
    name: "Pro",
    get m() { return getPlanConfig("pro").priceUsd; },
    y: 290,
    blurb: getPlanConfig("pro").blurb,
    hot: false,
    f: [
      "Manual + Assisted mode",
      "MARA drafts your copy & schedules",
      "AI image & video generation (150 credits)",
      "Publishing queue automation",
      "You approve before Voom acts",
      "Email marketing (soon)",
    ],
    off: ["Autopilot mode", "Automatic paid media"],
  },
  {
    id: "max" as const,
    name: "Max",
    get m() { return getPlanConfig("max").priceUsd; },
    y: 790,
    blurb: getPlanConfig("max").blurb,
    hot: true,
    f: [
      "Manual + Assisted + Autopilot mode",
      "MARA runs your marketing within limits",
      "AI image & video generation (500 credits)",
      "Automatic paid media generation (toggle)",
      "Safe actions execute automatically",
      "Campaign intelligence & insights",
    ],
    off: [],
  },
];
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { AD_SEPARATION, AdSepNote } from "@/components/voom/ui/Notes";

const FAQS: [string, string][] = [
  [
    "What are Voom credits?",
    "Credits are used only when Voom generates AI images or videos. An image is 5 credits, a short video is 40 credits. Polling, retries that don't create a new job, planning, copy and scheduling use zero credits.",
  ],
  [
    "What happens when I run out of credits?",
    "You see 'You need 40 credits. You have 22 remaining.' No provider call happens when you're blocked, so you are never charged after the message. Planning continues even when media is blocked.",
  ],
  [
    "Can Voom spend my ad budget without asking?",
    "No. Voom can never start a campaign, increase a total budget or exceed an approved limit without your explicit permission — and paid advertising isn't connected yet, so nothing can spend today.",
  ],
  [
    "Is billing active?",
    "Billing UI is live for credits visibility, but Stripe isn't connected and no card is charged yet. Every account starts on Free while billing is offline; when billing activates you'll choose a plan explicitly before any payment.",
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
        <p className="text-[15px] text-text-2">Where Voom is heading — and what you pay today.</p>
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
            Billing isn’t active yet. Your account is on the <b>Free</b> plan and every feature you can see today works without a card. Credits are used only when Voom generates AI images or videos.
          </span>
        </div>
      </Card>

      <div className="grid items-start gap-4 sm:grid-cols-3">
        {PLANS.map((p) => {
          const cur = plan === p.id;
          return (
            <div
              key={p.id}
              className={`relative rounded-[22px] border-[1.5px] bg-surface p-6.5 ${p.hot ? "border-brand shadow-[0_20px_50px_-24px_var(--brand)] sm:order-first" : "border-line"}`}
            >
              <div className="flex items-center justify-between">
                <h3 className="font-display text-[19px] font-bold">{p.name}</h3>
                {cur && <Tag tone="t-green">Your plan</Tag>}
              </div>
              <p className="my-1.5 text-[13.3px] text-text-2">{p.blurb}</p>
              <div className="flex items-baseline gap-1.5">
                <span className="font-display text-[34px] font-bold tracking-tight">${nfc(p.m)}</span>
                <span className="text-[13.5px] text-text-3">/month</span>
              </div>
              <div className="mt-1 text-xs text-text-3">{p.m ? "Software subscription only — ad budget is separate" : "No card required"}</div>
              <Btn variant={p.hot ? "primary" : "outline"} block className="mt-4" disabled>
                {cur ? "Your current plan" : "Available when billing activates"}
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
