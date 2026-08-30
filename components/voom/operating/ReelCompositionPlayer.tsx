"use client";
/* eslint-disable @next/next/no-img-element -- the optional source assets use short-lived private signed URLs */

import { useEffect, useRef, useState } from "react";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { isReelComposition } from "@/lib/mara/reel-composition";

interface PrivateAsset { id?: string; name?: string; mimeType: string; byteSize?: number; status?: string; updatedAt?: string; previewUrl: string | null; }

const IMAGE_TREATMENT = [
  { animation: "voom-reel-kenburns-a 3.4s ease-in-out infinite alternate", position: "50% 28%" },
  { animation: "voom-reel-kenburns-b 3s ease-in-out infinite alternate", position: "18% 52%" },
  { animation: "voom-reel-kenburns-c 3.2s ease-in-out infinite alternate", position: "82% 56%" },
  { animation: "voom-reel-kenburns-d 3.6s ease-in-out infinite alternate", position: "50% 40%" },
] as const;

const VIDEO_TREATMENT = ["scale(1)", "scale(1.1)", "scale(1.05) translate(-2%, 1%)", "scale(1.15)"] as const;

const SCENE_LAYOUT: Record<string, { align: string; size: string; animation: string }> = {
  hook: { align: "justify-center pb-20 text-center", size: "text-[26px] leading-[1.06] sm:text-[30px]", animation: "voom-reel-text-pop" },
  message: { align: "justify-center text-center", size: "text-[23px] leading-[1.12] sm:text-[26px]", animation: "voom-reel-text-rise" },
  body: { align: "justify-center text-center", size: "text-[23px] leading-[1.12] sm:text-[26px]", animation: "voom-reel-text-rise" },
  value: { align: "justify-end pb-20 text-center", size: "text-[23px] leading-[1.12] sm:text-[26px]", animation: "voom-reel-text-rise" },
  cta: { align: "justify-center text-center", size: "text-[24px] leading-[1.08] sm:text-[28px]", animation: "voom-reel-text-pop" },
};

function roleLabel(role: string) {
  if (role === "hook") return "Hook";
  if (role === "message" || role === "body") return "Main message";
  if (role === "value") return "Value";
  return "CTA";
}

export function ReelCompositionPlayer({ actionId, value }: { actionId: string; value: Record<string, unknown> }) {
  const composition = isReelComposition(value.reelComposition) ? value.reelComposition : null;
  const [playing, setPlaying] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [assets, setAssets] = useState<PrivateAsset[]>([]);
  const startedAt = useRef(0);
  const sharedVideoRef = useRef<HTMLVideoElement | null>(null);
  const sceneVideoRefs = useRef<Array<HTMLVideoElement | null>>([]);
  const lastActiveScene = useRef(0);

  useEffect(() => {
    if (!composition?.usesAsset) return;
    let active = true;
    void fetch(`/api/reels/assets/${actionId}`, { cache: "no-store" }).then((response) => response.json()).then((body: { assets?: PrivateAsset[]; asset?: PrivateAsset | null }) => {
      if (!active) return;
      const list = Array.isArray(body.assets) ? body.assets : body.asset ? [body.asset] : [];
      setAssets(list);
    }).catch(() => undefined);
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

  useEffect(() => {
    const video = sharedVideoRef.current;
    if (!video) return;
    if (playing) void video.play().catch(() => undefined);
    else video.pause();
  }, [playing]);

  let sceneIndex = 0;
  if (composition) {
    let boundary = 0;
    sceneIndex = composition.scenes.length - 1;
    for (let index = 0; index < composition.scenes.length; index += 1) {
      boundary += composition.scenes[index].durationMs;
      if (elapsed < boundary) { sceneIndex = index; break; }
    }
  }
  useEffect(() => {
    if (!composition) return;
    const changed = lastActiveScene.current !== sceneIndex;
    lastActiveScene.current = sceneIndex;
    sceneVideoRefs.current.forEach((video, index) => {
      if (!video) return;
      if (index === sceneIndex && playing) {
        if (changed) video.currentTime = 0;
        void video.play().catch(() => undefined);
      } else video.pause();
    });
  }, [sceneIndex, playing, composition]);

  if (!composition) return null;
  const sceneAsset = (index: number): PrivateAsset | null => {
    const scene = composition.scenes[index] as { assetId?: string | null };
    const byId = typeof scene.assetId === "string" ? assets.find((asset) => asset.id === scene.assetId) : undefined;
    return byId ?? assets[0] ?? null;
  };
  const scene = composition.scenes[sceneIndex];
  const layout = SCENE_LAYOUT[scene.role] ?? SCENE_LAYOUT.message!;
  const durationMs = composition.durationMs;
  const progress = Math.min(100, (elapsed / durationMs) * 100);
  const finished = elapsed >= durationMs;
  const boundaries = composition.scenes.map((item, index) => composition.scenes.slice(0, index + 1).reduce((sum, part) => sum + part.durationMs, 0) / durationMs * 100);
  const videoIds = new Set(composition.scenes.map((_, index) => sceneAsset(index)).filter((asset) => asset?.mimeType.startsWith("video/")).map((asset) => asset!.id ?? asset!.previewUrl));
  const scenesUseOnlyVideo = composition.scenes.every((_, index) => Boolean(sceneAsset(index)?.mimeType.startsWith("video/")));
  const sharedVideo = videoIds.size === 1 && scenesUseOnlyVideo;
  function play() {
    const nextElapsed = elapsed >= durationMs ? 0 : elapsed;
    if (nextElapsed !== elapsed) setElapsed(nextElapsed);
    startedAt.current = performance.now() - nextElapsed;
    setPlaying(true);
  }
  function restart() {
    setPlaying(false); setElapsed(0);
    if (sharedVideoRef.current) sharedVideoRef.current.currentTime = 0;
    sceneVideoRefs.current.forEach((video) => { if (video) video.currentTime = 0; });
  }
  function mediaLayer(index: number) {
    const media = sceneAsset(index);
    if (!media?.previewUrl) return (
      <div key={`media-${index}`} className={`absolute inset-0 transition-opacity duration-500 ${index === sceneIndex ? "opacity-100" : "opacity-0"}`}>
        <div className="absolute inset-0 bg-gradient-to-br from-[#e8481f] via-[#8c2c1b] to-[#181513]" />
        <div className="absolute inset-0 bg-[radial-gradient(circle_at_30%_18%,rgba(255,255,255,.16),transparent_46%)] [animation:voom-reel-kenburns-a_4.5s_ease-in-out_infinite_alternate]" />
      </div>
    );
    const isVideoScene = media.mimeType.startsWith("video/");
    if (isVideoScene && sharedVideo) return null;
    return (
      <div key={`media-${index}`} className={`absolute inset-0 transition-opacity duration-500 ease-out ${index === sceneIndex ? "opacity-100" : "opacity-0"}`}>
        {isVideoScene ? (
          <div className="absolute inset-0 transition-transform duration-700 ease-out" style={{ transform: VIDEO_TREATMENT[index % VIDEO_TREATMENT.length] }}>
            <video ref={(el) => { sceneVideoRefs.current[index] = el; }} className="absolute inset-0 h-full w-full object-cover" src={media.previewUrl} muted loop playsInline preload="metadata" aria-label="Private Reel source video" />
          </div>
        ) : (
          <div className="absolute inset-0 will-change-transform" style={{ animation: IMAGE_TREATMENT[index % IMAGE_TREATMENT.length].animation }}>
            <img className="absolute inset-0 h-full w-full object-cover" style={{ objectPosition: IMAGE_TREATMENT[index % IMAGE_TREATMENT.length].position }} src={media.previewUrl} alt="Private Reel source asset" />
          </div>
        )}
      </div>
    );
  }
  return <section className="mt-5 rounded-xl border border-green/30 bg-green/5 p-3.5 sm:p-4">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><h3 className="font-display text-base font-semibold">Playable Reel preview</h3><p className="text-xs text-text-3">Live Voom composition · 9:16 · {(composition.durationMs / 1000).toFixed(1)} seconds · {composition.scenes.length} viewer-facing scenes · {assets.length} private asset{assets.length === 1 ? "" : "s"}</p></div><Tag tone="t-green">Ready for review</Tag></div>
    <div className="mt-4 grid items-start gap-4 md:grid-cols-[minmax(220px,300px)_1fr]">
      <div className="mx-auto w-full max-w-[300px] overflow-hidden rounded-[22px] border border-white/10 bg-[#151513] shadow-xl">
        <div className="relative aspect-[9/16] overflow-hidden bg-gradient-to-br from-[#e8481f] via-[#8c2c1b] to-[#181513] text-white">
          {composition.usesAsset && assets.length > 0 ? composition.scenes.map((_, index) => mediaLayer(index)) : mediaLayer(sceneIndex)}
          {sharedVideo && assets.some((asset) => asset.mimeType.startsWith("video/")) && <div className="absolute inset-0 transition-transform duration-700 ease-out" style={{ transform: VIDEO_TREATMENT[sceneIndex % VIDEO_TREATMENT.length] }}>
            <video ref={sharedVideoRef} className="absolute inset-0 h-full w-full object-cover" src={assets.find((asset) => asset.mimeType.startsWith("video/"))?.previewUrl ?? undefined} muted loop playsInline preload="metadata" aria-label="Private Reel source video" />
          </div>}
          <div className="absolute inset-0 bg-gradient-to-b from-black/55 via-black/15 to-black/80" />
          {scene.role === "cta" && <div className="absolute inset-0 bg-black/25" />}
          <div key={`scene-${sceneIndex}`} className="absolute inset-0 flex flex-col p-5">
            <div className="flex items-start justify-between gap-3">
              <div className="truncate text-[10px] font-bold uppercase tracking-[.18em] opacity-95 drop-shadow">{composition.brandName}</div>
              <div className="flex flex-none items-center gap-1">{composition.scenes.map((part, index) => <span key={index} className={`h-1 w-1 rounded-full ${index === sceneIndex ? "bg-white" : "bg-white/40"}`} />)}</div>
            </div>
            <div className={`flex flex-1 flex-col ${layout.align} [animation:voom-reel-scene_.3s_ease-out]`}>
              <div style={{ animation: `${layout.animation} .5s cubic-bezier(.2,.7,.3,1) both` }}>
                {scene.role === "cta" && <p className="mb-2.5 text-[11px] font-bold uppercase tracking-[.16em] text-white/85 drop-shadow">{composition.brandName}</p>}
                <p className={`mx-auto max-w-[88%] break-words font-display font-bold tracking-tight drop-shadow-[0_2px_14px_rgba(0,0,0,.6)] ${layout.size}`}>{scene.text}</p>
              </div>
            </div>
            <div className="mt-auto">
              <div className="relative h-1 overflow-hidden rounded-full bg-white/25">
                <div className="h-full bg-white/90 transition-[width] duration-100" style={{ width: `${progress}%` }} />
                {boundaries.slice(0, -1).map((marker) => <div key={marker} className="absolute inset-y-0 w-px bg-black/35" style={{ left: `${marker}%` }} />)}
              </div>
              <div className="mt-2 flex items-center justify-between gap-2 text-[9.5px] font-semibold uppercase tracking-[.14em] text-white/75">
                <span>{playing ? "Playing" : finished ? "Finished" : "Paused"}</span>
                <span>Produced inside Voom · Not published</span>
              </div>
            </div>
          </div>
          {finished && <button type="button" onClick={restart} className="absolute inset-x-0 bottom-24 mx-auto w-fit rounded-full bg-black/50 px-4 py-2 text-[10.5px] font-bold uppercase tracking-[.14em] backdrop-blur-sm transition-colors hover:bg-black/65">↺ Replay</button>}
        </div>
      </div>
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-text-3">Viewer-facing scenes</h4>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {composition.scenes.map((part, index) => { const media = sceneAsset(index); return <div key={index} className="rounded-lg border border-line bg-surface-2 px-3 py-2"><span className="text-[10px] font-bold uppercase tracking-[.12em] text-brand">{roleLabel(part.role)}</span><p className="mt-0.5 text-sm font-medium leading-snug text-text-2">{part.text}</p>{media && <p className="mt-1 truncate text-[10px] text-text-3">{media.name ?? (media.mimeType.startsWith("video/") ? "Video" : "Photo")}</p>}</div>; })}
        </div>
        <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-3">Concept</h4>
        <p className="mt-1 text-sm font-medium text-text-2">{composition.concept}</p>
        <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-text-3">Caption</h4>
        <p className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-sm text-text-2">{composition.caption}</p>
        <div className="mt-4 flex flex-wrap gap-2"><Btn size="sm" variant="primary" onClick={playing ? () => setPlaying(false) : play}>{playing ? "Pause" : finished ? "Replay Reel" : elapsed > 0 && elapsed < composition.durationMs ? "Continue" : "Play Reel"}</Btn><Btn size="sm" variant="outline" onClick={restart}>Restart</Btn></div>
        <p className="mt-3 text-[11px] leading-relaxed text-text-3">This is a persisted, playable Voom composition — not a rendered MP4. MARA automatically assembled your provided assets into the Reel: it uses timed viewer-facing scenes and {composition.usesAsset ? `${assets.length} private uploaded asset${assets.length === 1 ? "" : "s"}` : "truthful branded text visuals"}. Internal shot directions are never shown on screen.</p>
      </div>
    </div>
  </section>;
}
