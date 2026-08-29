"use client";
/* eslint-disable @next/next/no-img-element -- the optional source asset uses a short-lived private signed URL */

import { useEffect, useRef, useState } from "react";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { isReelComposition } from "@/lib/mara/reel-composition";

interface PrivateAsset { mimeType: string; previewUrl: string | null; }

export function ReelCompositionPlayer({ actionId, value }: { actionId: string; value: Record<string, unknown> }) {
  const composition = isReelComposition(value.reelComposition) ? value.reelComposition : null;
  const [playing, setPlaying] = useState(false); const [elapsed, setElapsed] = useState(0); const [asset, setAsset] = useState<PrivateAsset | null>(null); const startedAt = useRef(0);
  useEffect(() => {
    if (!composition?.usesAsset) return;
    let active = true;
    void fetch(`/api/reels/assets/${actionId}`, { cache: "no-store" }).then((response) => response.json()).then((body: { asset?: PrivateAsset }) => { if (active && body.asset) setAsset(body.asset); }).catch(() => undefined);
    return () => { active = false; };
  }, [actionId, composition?.usesAsset]);
  useEffect(() => {
    if (!playing || !composition) return;
    const timer = window.setInterval(() => {
      const next = performance.now() - startedAt.current;
      if (next >= composition.durationMs) { setElapsed(composition.durationMs); setPlaying(false); }
      else setElapsed(next);
    }, 100);
    return () => window.clearInterval(timer);
  }, [playing, composition]);
  if (!composition) return null;
  let boundary = 0; let sceneIndex = composition.scenes.length - 1;
  for (let index = 0; index < composition.scenes.length; index += 1) { boundary += composition.scenes[index].durationMs; if (elapsed < boundary) { sceneIndex = index; break; } }
  const scene = composition.scenes[sceneIndex]; const durationMs = composition.durationMs; const progress = Math.min(100, (elapsed / durationMs) * 100);
  function play() { const nextElapsed = elapsed >= durationMs ? 0 : elapsed; if (nextElapsed !== elapsed) setElapsed(nextElapsed); startedAt.current = performance.now() - nextElapsed; setPlaying(true); }
  return <section className="mt-5 rounded-xl border border-green/30 bg-green/5 p-3.5 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-display text-base font-semibold">Playable Reel preview</h3><p className="text-xs text-text-3">Live Voom composition · 9:16 · {(composition.durationMs / 1000).toFixed(1)} seconds</p></div><Tag tone="t-green">Ready for review</Tag></div>
    <div className="mt-4 grid items-start gap-4 md:grid-cols-[minmax(220px,300px)_1fr]">
      <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[22px] border border-white/10 bg-[#151515] shadow-xl">
        <div className="relative aspect-[9/16] overflow-hidden bg-gradient-to-br from-[#e8481f] via-[#8c2c1b] to-[#181513] text-white">
          {composition.usesAsset && asset?.previewUrl && (asset.mimeType.startsWith("video/") ? <video key={playing ? "playing" : "paused"} className="absolute inset-0 h-full w-full object-cover opacity-65" src={asset.previewUrl} autoPlay={playing} muted loop playsInline /> : <img className="absolute inset-0 h-full w-full object-cover opacity-65" src={asset.previewUrl} alt="Private Reel source asset" />)}
          <div className="absolute inset-0 bg-gradient-to-b from-black/20 via-black/10 to-black/70" />
          <div key={sceneIndex} className="absolute inset-0 flex flex-col justify-between p-6 [animation:voom-reel-scene_.35s_ease-out]">
            <div className="text-[10px] font-bold uppercase tracking-[.16em] opacity-90">{composition.brandName}</div>
            <div><span className="rounded-full bg-white/15 px-2 py-1 text-[9px] font-bold uppercase tracking-widest backdrop-blur-sm">{scene.role}</span><p className="mt-3 text-[25px] font-bold leading-[1.05] drop-shadow-lg">{scene.text}</p></div>
            <div><div className="h-1 overflow-hidden rounded-full bg-white/25"><div className="h-full bg-white transition-[width] duration-100" style={{ width: `${progress}%` }} /></div><p className="mt-2 text-[10px] font-medium opacity-80">Produced inside Voom · Not published</p></div>
          </div>
        </div>
      </div>
      <div><h4 className="text-xs font-semibold uppercase tracking-wide text-text-3">Concept</h4><p className="mt-1 text-sm font-medium text-text-2">{composition.concept}</p><h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-3">Caption</h4><p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-sm text-text-2">{composition.caption}</p><div className="mt-4 flex flex-wrap gap-2"><Btn size="sm" variant="primary" onClick={playing ? () => setPlaying(false) : play}>{playing ? "Pause" : elapsed > 0 && elapsed < composition.durationMs ? "Continue" : "Play Reel"}</Btn><Btn size="sm" variant="outline" onClick={() => { setPlaying(false); setElapsed(0); }}>Restart</Btn></div><p className="mt-3 text-[11px] leading-relaxed text-text-3">This is a persisted, playable Voom composition—not a rendered MP4. It uses timed scenes and {composition.usesAsset ? "your private uploaded asset" : "truthful branded text visuals"}.</p></div>
    </div>
  </section>;
}
