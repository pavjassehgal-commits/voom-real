"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { ModalBody, ModalFoot, ModalShell } from "@/components/voom/ui/Modal";
import { Btn } from "@/components/voom/ui/primitives";

/**
 * The TikTok connect modal — the exact permissions Voom asks TikTok for,
 * stated plainly before the redirect. Least privilege, and nothing else:
 * the basic identity (user.info.basic) and direct posting (video.publish).
 * No drafts, no content listing, no delete — none of those scopes are
 * requested.
 */
const PERMISSIONS = [
  "Post videos to your account only after you approve and schedule them in Voom",
  "Read your basic account identity (display name, avatar) and each post's status",
];
const NEVERS = [
  "Delete or edit your existing posts — Voom never asks for that permission",
  "Read your followers, profile stats or any performance data",
  "Store tokens in your browser — they stay encrypted on Voom's server",
];

export function TikTokConnectModal() {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/integrations/tiktok/connect", { method: "POST" });
      const value = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !value.authorizationUrl) throw new Error(value.error ?? "TikTok connection could not be started.");
      window.location.assign(value.authorizationUrl);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "TikTok connection could not be started.";
      setError(message); toast(message, "err"); setBusy(false);
    }
  }

  return (
    <ModalShell maxWidth={440}>
      <div className="flex items-start justify-between gap-3.5 px-[22px] pt-5">
        <div className="flex items-center gap-2.5">
          <div className="grid h-9 w-9 place-items-center rounded-[11px] bg-[#010101] text-white">
            <Icon name="film" />
          </div>
          <div><b className="text-[15px]">Connect TikTok</b><div className="text-xs text-text-3">Secure TikTok authorization</div></div>
        </div>
        <button onClick={close} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 hover:bg-surface-2">
          <Icon name="x" />
        </button>
      </div>
      <ModalBody>
        <p className="mb-3 text-[13.5px] leading-[1.6] text-text-2">
          Voom will redirect you to TikTok. Sign in there and approve the request. Voom asks for basic identity
          and direct-post access only — the minimum that lets it publish what you approve and report what TikTok
          confirms.
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
          Until Voom&apos;s TikTok app passes TikTok&apos;s content-sharing audit, TikTok restricts posts through it to
          private (Only me) viewership and caps posting users per day. Voom tells you that plainly and reports
          what TikTok actually accepts — it never claims a public post happened. Your tokens are encrypted with
          AES-256-GCM on Voom&apos;s server and never sent to your browser.
        </p>
        {error ? <p className="mt-3 rounded-lg border border-red/30 bg-red/10 p-2.5 text-xs text-red">{error}</p> : null}
      </ModalBody>
      <ModalFoot><Btn variant="ghost" onClick={close}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => void connect()}>{busy ? "Opening TikTok…" : "Continue to TikTok"}</Btn></ModalFoot>
    </ModalShell>
  );
}
