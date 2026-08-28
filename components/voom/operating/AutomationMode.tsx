"use client";

import { useState } from "react";
import { Btn } from "@/components/voom/ui/primitives";
import type { AutomationModeValue } from "@/lib/voom/automation";

export function AutomationMode({ initial, compact = false }: { initial: AutomationModeValue; compact?: boolean }) {
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
  return <div>
    <div className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1" aria-label="Automation mode">
      {(["manual", "assisted", "autopilot"] as const).map((value) => <Btn key={value} size="sm" variant={mode === value ? "primary" : "plain"} disabled={busy} onClick={() => void choose(value)} className={compact ? "px-2.5" : undefined}>{value[0].toUpperCase() + value.slice(1)}</Btn>)}
    </div>
    {error && <p role="alert" className="mt-1.5 text-xs text-red">{error}</p>}
  </div>;
}
