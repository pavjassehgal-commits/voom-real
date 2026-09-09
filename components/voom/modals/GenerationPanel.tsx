"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Btn } from "@/components/voom/ui/primitives";
import { Icon } from "@/components/voom/icons";

/**
 * The MARA video generation panel for Post Studio (Reel / Story video).
 *
 * The four steps reflect REAL server-side job states — the panel only shows
 * "Generating" once a real provider job id exists on the durable job record,
 * and "Processing" while Voom downloads, validates and stores the output.
 * There is no simulated progress.
 */
export interface ClientGeneration {
  id: string;
  status: string;
  phase: "preparing" | "generating" | "processing" | "ready" | "failed" | "cancelled";
  mediaType: "video";
  generationMode: string | null;
  durationSeconds: number | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  safeError: string | null;
  previewUrl: string | null;
}

const STEPS = ["Preparing", "Generating", "Processing", "Ready"] as const;

function stepIndexFor(phase: ClientGeneration["phase"]): number {
  if (phase === "preparing") return 0;
  if (phase === "generating") return 1;
  if (phase === "processing") return 2;
  if (phase === "ready") return 3;
  return -1;
}

const ACTIVE_PHASES = new Set<string>(["generating", "processing"]);

export function GenerationPanel({
  postId,
  kind,
  initial,
  preparing,
  onSettled,
}: {
  postId: string;
  kind: "reel" | "story";
  /** The job returned by the start request (null before it resolves). */
  initial: ClientGeneration | null;
  /** True while the start request itself is in flight. */
  preparing: boolean;
  /** Called once when the panel reaches a terminal state. */
  onSettled: () => void;
}) {
  const [generation, setGeneration] = useState<ClientGeneration | null>(initial);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState<string | null>(null);
  const settledRef = useRef(false);

  const phase = preparing ? "preparing" : generation?.phase ?? "preparing";
  const active = preparing || (generation ? ACTIVE_PHASES.has(generation.phase) : false);

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/generation`, { cache: "no-store" });
      const body = await response.json() as { generation?: ClientGeneration | null; error?: string };
      if (!response.ok) throw new Error(body.error ?? "That generation could not be loaded.");
      if (body.generation) {
        setGeneration(body.generation);
        if (!ACTIVE_PHASES.has(body.generation.phase) && !settledRef.current) {
          settledRef.current = true;
          onSettled();
        }
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "That generation could not be loaded.");
    }
  }, [postId, onSettled]);

  // Lazy server-side polling: each GET advances the real job (provider poll,
  // validation, storage) — the same endpoint the server uses to finish work.
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => void refresh(), 6000);
    return () => window.clearInterval(timer);
  }, [active, refresh]);

  async function regenerate() {
    setAction("regenerate");
    setError("");
    setNotice("");
    settledRef.current = false;
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "regenerate", idempotencyKey: crypto.randomUUID() }),
      });
      const body = await response.json() as { generation?: ClientGeneration | null; error?: string; message?: string };
      if (!response.ok || !body.generation) throw new Error(body.error ?? "Voom couldn't start that generation safely.");
      setGeneration(body.generation);
      setNotice(body.message ?? "MARA started a new video generation. This can take a few minutes.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't start that generation safely.");
    } finally {
      setAction(null);
    }
  }

  async function confirmUse() {
    setAction("use");
    setNotice("");
    setError("");
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "use" }),
      });
      const body = await response.json() as { error?: string; message?: string };
      if (!response.ok) throw new Error(body.error ?? "Voom couldn't record that choice.");
      setNotice(body.message ?? "This video is in use.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't record that choice.");
    } finally {
      setAction(null);
    }
  }

  async function cancel() {
    setAction("cancel");
    setError("");
    try {
      const response = await fetch(`/api/posts/${encodeURIComponent(postId)}/generation`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "cancel" }),
      });
      const body = await response.json() as { generation?: ClientGeneration | null; error?: string; message?: string };
      if (!response.ok || !body.generation) throw new Error(body.error ?? "Voom couldn't cancel that generation.");
      setGeneration(body.generation);
      setNotice(body.message ?? "Generation cancelled.");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't cancel that generation.");
    } finally {
      setAction(null);
    }
  }

  const stepIndex = stepIndexFor(phase);
  const failed = phase === "failed" || phase === "cancelled";

  return (
    <div className="rounded-2xl border border-brand/30 bg-surface p-4">
      <div className="flex items-center gap-2">
        <span className="voom-grad grid h-8 w-8 place-items-center rounded-lg text-white">
          <Icon name="spark" size={14} />
        </span>
        <div>
          <b className="text-[13.5px]">MARA {kind === "reel" ? "Reel" : "Story"} video</b>
          <p className="text-[11px] text-text-3">9:16 · stored privately in Voom · nothing published</p>
        </div>
      </div>

      <div className="mt-3.5 grid grid-cols-4 gap-1.5">
        {STEPS.map((label, index) => {
          const done = !failed && (index < stepIndex || stepIndex === 3 && index === 3);
          const current = !failed && index === stepIndex && stepIndex !== 3;
          return (
            <div
              key={label}
              className={`rounded-lg border px-2 py-1.5 text-center text-[10.5px] font-semibold uppercase tracking-wide ${
                done ? "border-green/40 bg-green/10 text-green" : current ? "border-brand/50 bg-[var(--brand-soft)] text-brand" : "border-line bg-surface-2 text-text-3"
              }`}
            >
              {label}
            </div>
          );
        })}
      </div>

      {error ? <p role="alert" className="mt-3 rounded-lg border border-red/35 bg-red/10 px-3 py-2 text-[12.5px] text-red">{error}</p> : null}
      {notice ? <p role="status" className="mt-3 rounded-lg border border-green/35 bg-green/10 px-3 py-2 text-[12.5px] text-green">{notice}</p> : null}

      {phase === "preparing" ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">
          MARA is reading your brand and plan, writing the visual direction and starting the video job. This can take a minute.
        </p>
      ) : null}
      {phase === "generating" ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">
          The video provider is rendering your {kind === "reel" ? "Reel" : "Story"} — this usually takes a few minutes. Your current asset is unchanged until a new video is validated and stored.
        </p>
      ) : null}
      {phase === "processing" ? (
        <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">
          Voom is downloading the video and checking it (format, 9:16 frame, length) before attaching it.
        </p>
      ) : null}
      {failed ? <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">{generation?.safeError ?? "Generation didn't finish."}</p> : null}

      {phase === "ready" && generation?.previewUrl ? (
        <div className="mt-3.5">
          <div className="mx-auto w-full max-w-[220px] overflow-hidden rounded-[18px] border border-line bg-black">
            <video src={generation.previewUrl} controls playsInline preload="metadata" className="aspect-[9/16] h-auto w-full object-cover" />
          </div>
          <p className="mt-2 text-center text-[11px] text-text-3">
            {generation.durationSeconds ? `${generation.durationSeconds}s · ` : ""}private signed preview · regenerations keep the current video until a new one validates
          </p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Btn size="sm" variant="primary" disabled={action !== null} onClick={() => void confirmUse()}>
              <Icon name="check" size={13} /> {action === "use" ? "Saving…" : "Use this"}
            </Btn>
            <Btn size="sm" variant="outline" disabled={action !== null} onClick={() => void regenerate()}>
              <Icon name="spark" size={13} /> {action === "regenerate" ? "Starting…" : "Regenerate"}
            </Btn>
          </div>
        </div>
      ) : null}

      {failed ? (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Btn size="sm" variant="primary" disabled={action !== null} onClick={() => void regenerate()}>
            <Icon name="spark" size={13} /> {action === "regenerate" ? "Starting…" : "Try again"}
          </Btn>
        </div>
      ) : null}

      {generation?.status === "queued" && !preparing ? (
        <div className="mt-3 flex justify-center">
          <Btn size="sm" variant="ghost" disabled={action !== null} onClick={() => void cancel()}>
            {action === "cancel" ? "Cancelling…" : "Cancel (nothing started yet)"}
          </Btn>
        </div>
      ) : null}
    </div>
  );
}
