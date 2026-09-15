"use client";

import { useState } from "react";
import { Icon } from "@/components/voom/icons";
import { Btn, cx } from "@/components/voom/ui/primitives";
import {
  AUTOMATION_MODES,
  AUTOMATION_MODE_LABELS,
  automationModeCards,
  type AutomationModeCard,
  type AutomationModeValue,
} from "@/lib/voom/automation";
import { getPlanConfig, type PlanId } from "@/lib/billing/plans";

export function AutomationMode({
  initial,
  plan = "free",
  compact = false,
  describe = false,
}: {
  initial: AutomationModeValue;
  plan?: PlanId;
  compact?: boolean;
  describe?: boolean;
}) {
  const [mode, setMode] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const planConfig = getPlanConfig(plan);

  function isModeAllowed(value: AutomationModeValue): boolean {
    return planConfig.allowedModes.includes(value);
  }

  async function choose(next: AutomationModeValue) {
    if (next === mode || busy) return;
    if (!isModeAllowed(next)) {
      setError(
        next === "autopilot"
          ? "Autopilot is available on Max plan only. Upgrade to Max to use Autopilot."
          : "Assisted is available on Pro and Max plans. Upgrade to use Assisted.",
      );
      return;
    }
    setBusy(true);
    setError("");
    const response = await fetch("/api/automation-mode", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: next }),
    });
    const body = (await response.json()) as { error?: string };
    if (response.ok) setMode(next);
    else setError(body.error ?? "Voom couldn't save that mode.");
    setBusy(false);
  }

  const cards = automationModeCards(mode);
  return (
    <div>
      <div role="group" className={cx("flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1", !compact && "max-w-md")} aria-label="Automation mode">
        {AUTOMATION_MODES.map((value) => {
          const allowed = isModeAllowed(value);
          return (
            <Btn
              key={value}
              size="sm"
              variant={mode === value ? "primary" : "plain"}
              aria-pressed={mode === value}
              disabled={busy || !allowed}
              onClick={() => void choose(value)}
              className={compact ? "px-2.5" : undefined}
              title={!allowed ? (value === "autopilot" ? "Requires Max plan" : "Requires Pro or Max plan") : undefined}
            >
              {AUTOMATION_MODE_LABELS[value]}
              {!allowed && <span className="ml-1 text-[10px] opacity-60">🔒</span>}
            </Btn>
          );
        })}
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs text-red">{error}</p>}
      <p className="mt-2 text-[11px] text-text-3">
        Current plan: {planConfig.name} · Allowed modes: {planConfig.allowedModes.join(", ")} · {planConfig.blurb}
      </p>
      {describe && (
        <div className="mt-6 grid gap-3 md:grid-cols-3">
          {cards.map((card) => (
            <ModeCard key={card.value} card={card} allowed={isModeAllowed(card.value)} plan={plan} />
          ))}
        </div>
      )}
    </div>
  );
}

function ModeCard({ card, allowed, plan }: { card: AutomationModeCard; allowed: boolean; plan: PlanId }) {
  return (
    <div
      data-mode={card.value}
      data-active={card.active ? "true" : "false"}
      aria-current={card.active ? "true" : undefined}
      className={cx("rounded-xl border p-4", card.active ? "border-brand bg-[var(--brand-soft)]" : "border-line bg-surface-2", !allowed && "opacity-60")}
    >
      <div className="flex flex-wrap items-center gap-2">
        <b>{card.label}</b>
        {card.active && (
          <span className="inline-flex items-center gap-1 rounded-[7px] border border-brand/40 bg-surface px-2.5 py-[3px] text-[11.5px] font-semibold text-brand">
            <Icon name="check" size={11} />
            Active
          </span>
        )}
        {card.recommended && (
          <span className="inline-flex items-center rounded-[7px] border border-line bg-surface px-2.5 py-[3px] text-[11.5px] font-medium text-text-3">
            Recommended
          </span>
        )}
        {!allowed && <span className="inline-flex items-center rounded-[7px] border border-amber/40 bg-amber/10 px-2.5 py-[3px] text-[11.5px] font-medium text-amber">Requires {card.value === "autopilot" ? "Max" : "Pro"}</span>}
      </div>
      <p className="mt-1 text-xs leading-relaxed text-text-3">{card.summary}</p>
      <p className="mt-2 text-xs leading-relaxed text-text-2">
        <b className="font-semibold">Paid media:</b> {card.media}
      </p>
      {card.warning && (
        <p className={cx("mt-2.5 flex items-start gap-1.5 rounded-lg border border-amber/35 px-2.5 py-2 text-xs leading-relaxed text-amber", card.active ? "bg-amber/15" : "bg-amber/10")}>
          <Icon name="warn" size={13} className="mt-[1px] flex-none" />
          <span>{card.warning}</span>
        </p>
      )}
      {!allowed && (
        <p className="mt-2 text-[11px] text-text-3">
          Your {plan} plan does not support {card.label} mode.
        </p>
      )}
    </div>
  );
}
