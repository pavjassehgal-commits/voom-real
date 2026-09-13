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

/**
 * The automation-mode control.
 *
 * `mode` is the SAVED mode: it changes only after `PATCH /api/automation-mode`
 * succeeds, so a failed save never moves the UI. The segmented control and the
 * explanatory cards (`describe`) both read that one piece of state, which is
 * why the highlighted card always matches the mode that is stored — no mode is
 * hard-coded as active or as "current".
 *
 * Presentational only: it saves the mode and nothing else. No cron, provider,
 * approval or publishing behaviour lives here.
 */
export function AutomationMode({
  initial,
  compact = false,
  describe = false,
}: {
  initial: AutomationModeValue;
  compact?: boolean;
  describe?: boolean;
}) {
  const [mode, setMode] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function choose(next: AutomationModeValue) {
    if (next === mode || busy) return;
    setBusy(true); setError("");
    const response = await fetch("/api/automation-mode", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ mode: next }) });
    const body = await response.json() as { error?: string };
    if (response.ok) setMode(next); else setError(body.error ?? "Voom couldn't save that mode.");
    setBusy(false);
  }
  // Exactly one card is active and it is the saved mode's card.
  const cards = automationModeCards(mode);
  return <div>
    <div role="group" className={cx("flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1", !compact && "max-w-md")} aria-label="Automation mode">
      {AUTOMATION_MODES.map((value) => <Btn key={value} size="sm" variant={mode === value ? "primary" : "plain"} aria-pressed={mode === value} disabled={busy} onClick={() => void choose(value)} className={compact ? "px-2.5" : undefined}>{AUTOMATION_MODE_LABELS[value]}</Btn>)}
    </div>
    {error && <p role="alert" className="mt-1.5 text-xs text-red">{error}</p>}
    {describe && <div className="mt-6 grid gap-3 md:grid-cols-3">
      {cards.map((card) => <ModeCard key={card.value} card={card} />)}
    </div>}
  </div>;
}

/**
 * One descriptive card. `card.active` comes from the saved mode, so the visual
 * active state, the "Active" badge and `aria-current` all follow the stored
 * value. "Recommended" is a separate, mode-independent suggestion: it stays on
 * Assisted whichever mode is saved, and it never claims to be the current mode.
 */
function ModeCard({ card }: { card: AutomationModeCard }) {
  return <div
    data-mode={card.value}
    data-active={card.active ? "true" : "false"}
    aria-current={card.active ? "true" : undefined}
    className={cx("rounded-xl border p-4", card.active ? "border-brand bg-[var(--brand-soft)]" : "border-line bg-surface-2")}
  >
    <div className="flex flex-wrap items-center gap-2">
      <b>{card.label}</b>
      {/* "Active" is the current-state badge and only ever renders on the card
          matching the saved mode. "Recommended" is a mode-independent
          suggestion, so it stays on Assisted whichever mode is saved. */}
      {card.active && <span className="inline-flex items-center gap-1 rounded-[7px] border border-brand/40 bg-surface px-2.5 py-[3px] text-[11.5px] font-semibold text-brand"><Icon name="check" size={11} />Active</span>}
      {card.recommended && <span className="inline-flex items-center rounded-[7px] border border-line bg-surface px-2.5 py-[3px] text-[11.5px] font-medium text-text-3">Recommended</span>}
    </div>
    <p className="mt-1 text-xs leading-relaxed text-text-3">{card.summary}</p>
    <p className="mt-2 text-xs leading-relaxed text-text-2"><b className="font-semibold">Paid media:</b> {card.media}</p>
    {card.warning && <p className={cx(
      "mt-2.5 flex items-start gap-1.5 rounded-lg border border-amber/35 px-2.5 py-2 text-xs leading-relaxed text-amber",
      card.active ? "bg-amber/15" : "bg-amber/10",
    )}>
      <Icon name="warn" size={13} className="mt-[1px] flex-none" />
      <span>{card.warning}</span>
    </p>}
  </div>;
}
