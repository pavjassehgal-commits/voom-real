"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useVoomState } from "@/lib/voom/store";
import { Icon } from "../icons";
import { ChannelGlyph } from "../redesign/ui";
import { VoomLogo } from "../shell/VoomLogo";

type PlanItem = { draftId: string; concept: string; channelLabel: string; dayLabel?: string | null; localDate?: string | null; localTime?: string | null; statusLabel?: string | null };

/**
 * Setup complete — redesign Batch 4A (Figma "14 — Setup complete · Your
 * workspace is ready", Keep).
 *
 * Every card repeats what the owner just saved. Setup does not create posts,
 * so the reference's "MARA drafted your first week" list shows the account's
 * real plan items when there are any and otherwise says plainly that the
 * first plan is built from Marketing Plan. The reference's "Invite your team"
 * step is not shown: Voom has no team seats.
 */
export function SetupComplete({ skipped }: { skipped: boolean }) {
  const { onboard, displayName } = useVoomState();
  const [items, setItems] = useState<PlanItem[] | null>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/voom/workflow", { cache: "no-store" })
      .then(async (response) => {
        const body = (await response.json()) as { snapshot?: { items?: PlanItem[] } };
        if (active) setItems(response.ok ? body.snapshot?.items ?? [] : []);
      })
      .catch(() => { if (active) setItems([]); });
    return () => { active = false; };
  }, []);

  const name = displayName?.trim() || onboard.displayName.trim();
  const join = (values: string[]) => values.filter(Boolean).join(" · ");
  const summary: { icon: string; label: string; value: string; note: string }[] = skipped ? [] : [
    { icon: "share", label: "Channels", value: onboard.channels.join(", ") || "None chosen yet", note: "Connect each from Channels" },
    { icon: "sparkles", label: "MARA", value: onboard.auto || "Not chosen", note: onboard.permission || "Publishing permission not chosen" },
    { icon: "comment", label: "Brand voice", value: join(onboard.tone) || "Not chosen", note: "Shapes every caption" },
    { icon: "contacts", label: "Audience", value: onboard.customer.slice(0, 2).join(", ") || "Not chosen", note: onboard.goal ? `Goal: ${onboard.goal.toLowerCase()}` : "No goal chosen" },
    { icon: "folder", label: "Business", value: onboard.name.trim() || "Name not set", note: join([onboard.industry, onboard.site.trim()]) || "No category chosen" },
    { icon: "card", label: "Ad budget", value: onboard.budget || "Not chosen", note: "Paid separately, never by Voom" },
    { icon: "cal", label: "Pace", value: onboard.freq || "Not chosen", note: "How often MARA plans posts" },
    { icon: "file", label: "Brand brief", value: onboard.desc.trim() ? "Sent to MARA" : "Not written", note: "Used before every suggestion" },
  ];

  return (
    <div className="voom-public flex min-h-dvh flex-col">
      <header className="border-b border-[var(--line)] bg-white/90">
        <div className="flex h-[68px] items-center justify-between gap-4 px-4 sm:px-6">
          <VoomLogo size={30} />
          <span className="hidden h-[4px] max-w-[340px] flex-1 rounded-full bg-[linear-gradient(90deg,#8645fa,#cc40ea)] md:block" aria-hidden="true" />
          <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-[var(--green)]"><Icon name="check" size={14} /> Setup complete</span>
        </div>
      </header>

      <main className="voom-setup-wash flex-1">
        <div className="mx-auto w-full max-w-[1100px] px-4 py-10 sm:px-6 sm:pb-14 sm:pt-16">
          <div className="text-center">
            <span className="voom-create-btn mx-auto grid h-14 w-14 place-items-center rounded-[16px] text-white shadow-[0_14px_30px_-14px_rgba(134,69,250,.9)]"><Icon name="check" size={26} /></span>
            <h1 className="mt-5 text-[clamp(1.75rem,3.4vw,2.35rem)] font-bold tracking-[-0.04em] text-text">Your workspace is ready{name ? `, ${name}` : ""}</h1>
            <p className="mx-auto mt-2 max-w-[520px] text-[15px] leading-relaxed text-text-2">
              {skipped ? "You skipped the questions — tell MARA about your brand any time in Settings." : "MARA has everything it needs to plan your first week. Here’s what you told us — you can change any of it in Settings."}
            </p>
          </div>

          {summary.length > 0 && (
            <ul className="mt-8 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
              {summary.map((card) => (
                <li key={card.label} className="rounded-[16px] border border-[var(--line)] bg-white p-4">
                  <div className="flex items-center justify-between gap-2">
                    <span className="inline-flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.1em] text-text-2">
                      <span className="grid h-7 w-7 place-items-center rounded-[8px] bg-[var(--brand-soft)] text-[var(--brand-ink)]"><Icon name={card.icon} size={14} /></span>
                      {card.label}
                    </span>
                    <Link href="/app/settings" className="text-[12px] font-semibold text-[var(--brand)] hover:underline" aria-label={`Edit ${card.label} in Settings`}>Edit</Link>
                  </div>
                  <p className="mt-3 line-clamp-2 text-[14px] font-semibold leading-snug text-text">{card.value}</p>
                  <p className="mt-1 line-clamp-2 text-[12px] text-text-2">{card.note}</p>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-5 grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
            <section className="rounded-[18px] border border-[var(--line)] bg-white p-5" aria-labelledby="setup-first-week">
              <div className="flex items-center gap-2.5">
                <span className="voom-create-btn grid h-8 w-8 place-items-center rounded-[9px] text-white"><Icon name="sparkles" size={15} /></span>
                <h2 id="setup-first-week" className="text-[15px] font-semibold text-text">Your first week</h2>
                {items && items.length > 0 && <span className="ml-auto rounded-full bg-[var(--brand-soft)] px-2.5 py-0.5 text-[12px] font-semibold text-[var(--brand-ink)]">{items.length} planned</span>}
              </div>
              {items === null ? (
                <p className="mt-4 text-[13.5px] text-text-3">Checking your plan…</p>
              ) : items.length ? (
                <ul className="mt-4 flex flex-col gap-2">
                  {items.slice(0, 3).map((item) => (
                    <li key={item.draftId} className="flex items-center gap-3 rounded-[12px] border border-[var(--line)] px-3 py-2.5">
                      <ChannelGlyph channelLabel={item.channelLabel} size={22} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13.5px] font-semibold text-text">{item.concept}</span>
                        <span className="block text-[12px] text-text-2">{[item.dayLabel ?? item.localDate, item.localTime].filter(Boolean).join(", ")}</span>
                      </span>
                      {item.statusLabel && <span className="text-[12px] text-text-2">{item.statusLabel}</span>}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-4 rounded-[12px] border border-dashed border-[var(--line-2)] px-4 py-4 text-[13.5px] leading-relaxed text-text-2">
                  Nothing is planned yet. Build your first week from <Link href="/app/plan" className="font-semibold text-[var(--brand)] hover:underline">Marketing Plan</Link> — MARA drafts each post for your approval.
                </p>
              )}
              <p className="mt-4 flex items-center gap-1.5 text-[12px] text-text-3"><Icon name="lock" size={12} /> Nothing publishes until you approve it.</p>
            </section>

            <section className="flex flex-col rounded-[18px] border border-[var(--line)] bg-white p-5" aria-labelledby="setup-next">
              <h2 id="setup-next" className="text-[15px] font-semibold text-text">Next steps</h2>
              <ol className="mt-4 flex flex-col gap-3.5">
                <li className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[var(--brand)] text-[12px] font-bold text-white">1</span>
                  <span><b className="block text-[13.5px] font-semibold text-text">Connect your channels</b><span className="text-[12.5px] text-text-2">Each uses the provider&apos;s own sign-in.</span></span>
                </li>
                <li className="flex gap-3">
                  <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-[var(--line-2)] text-[12px] font-bold text-text-2">2</span>
                  <span><b className="block text-[13.5px] font-semibold text-text">{items && items.length ? "Review MARA’s plan" : "Build your first plan"}</b><span className="text-[12.5px] text-text-2">Approve, edit or ask for another idea.</span></span>
                </li>
              </ol>
              <div className="mt-auto grid grid-cols-2 gap-2.5 pt-6">
                <Link href="/app/connections" className="inline-flex h-11 items-center justify-center rounded-full border border-[var(--line)] bg-white text-[14px] font-semibold text-text transition hover:bg-[var(--surface-2)]">Connect channels</Link>
                <Link href="/app/today" className="voom-create-btn inline-flex h-11 items-center justify-center gap-2 rounded-full text-[14px] font-semibold text-white">Go to dashboard <Icon name="arrow" size={15} /></Link>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}
