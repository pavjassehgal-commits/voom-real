"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { ModalBody, ModalFoot, ModalShell } from "@/components/voom/ui/Modal";
import { Btn } from "@/components/voom/ui/primitives";

/**
 * The YouTube connect modal — the exact permissions Voom asks Google for,
 * stated plainly before the redirect. Least privilege, and nothing else:
 * upload (videos.insert) and read-only (channel identity, video status,
 * public statistics). No delete, no edit-existing-videos, no monetary
 * analytics scope is ever requested.
 */
const PERMISSIONS = [
  "Upload videos to your channel only after you approve and schedule them in Voom",
  "Read your channel identity and each uploaded video's processing status",
  "Read public statistics (views, likes, comments) for videos Voom published",
];
const NEVERS = [
  "Edit or delete your existing YouTube videos — Voom never asks for that permission",
  "Read revenue or any monetary analytics",
  "Store tokens in your browser — they stay encrypted on Voom's server",
];

export function YouTubeConnectModal() {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/integrations/youtube/connect", { method: "POST" });
      const value = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !value.authorizationUrl) throw new Error(value.error ?? "YouTube connection could not be started.");
      window.location.assign(value.authorizationUrl);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "YouTube connection could not be started.";
      setError(message); toast(message, "err"); setBusy(false);
    }
  }

  return (
    <ModalShell maxWidth={440}>
      <div className="flex items-start justify-between gap-3.5 px-[22px] pt-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#ff0000] text-white">
            <Icon name="play" />
          </div>
          <div><b className="text-[15px]">Connect YouTube</b><div className="text-xs text-text-3">Secure Google authorization</div></div>
        </div>
        <button onClick={close} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 hover:bg-surface-2">
          <Icon name="x" />
        </button>
      </div>
      <ModalBody>
        <p className="mb-3 text-[13.5px] leading-[1.6] text-text-2">
          Voom will redirect you to Google. Sign in there and choose the YouTube channel you want to connect.
          Voom asks for upload and read-only access — the minimum that lets it publish what you approve and
          report what YouTube confirms.
        </p>
        {PERMISSIONS.map((permission) => (
          <div key={permission} className="flex items-start gap-2.5 py-1.5">
            <span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-green"><Icon name="check" size={11} className="text-white" /></span>
            <span className="text-[13.5px]">{permission}</span>
          </div>
        ))}
        <div className="my-2 h-px bg-line" />
        {NEVERS.map((never) => (
          <div key={never} className="flex items-start gap-2.5 py-1">
            <span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-surface-3"><Icon name="x" size={10} className="text-text-3" /></span>
            <span className="text-[12.5px] text-text-3">{never}</span>
          </div>
        ))}
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
          Google may show an &quot;unverified app&quot; warning until Voom&apos;s OAuth consent screen passes Google&apos;s
          verification for the upload scope. Your tokens are encrypted with AES-256-GCM on Voom&apos;s server and never
          sent to your browser.
        </p>
        {error ? <p className="mt-3 rounded-lg border border-red/30 bg-red/10 p-2.5 text-xs text-red">{error}</p> : null}
      </ModalBody>
      <ModalFoot><Btn variant="ghost" onClick={close}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => void connect()}>{busy ? "Opening Google…" : "Continue to Google"}</Btn></ModalFoot>
    </ModalShell>
  );
}
