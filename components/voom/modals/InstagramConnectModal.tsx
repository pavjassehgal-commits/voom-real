"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

const PERMISSIONS = ["Read your professional account identity", "Create feed and Reel publishing containers after explicit approval"];

export function InstagramConnectModal() {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function connect() {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/integrations/instagram/connect", { method: "POST" });
      const value = await response.json() as { authorizationUrl?: string; error?: string };
      if (!response.ok || !value.authorizationUrl) throw new Error(value.error ?? "Instagram connection could not be started.");
      window.location.assign(value.authorizationUrl);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Instagram connection could not be started.";
      setError(message); toast(message, "err"); setBusy(false);
    }
  }

  return (
    <ModalShell maxWidth={420}>
      <div className="flex items-start justify-between gap-3.5 px-[22px] pt-5">
        <div className="flex items-center gap-2.5">
          <div
            className="grid h-9 w-9 place-items-center rounded-[11px] text-white"
            style={{ background: "linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)" }}
          >
            <Icon name="ig" />
          </div>
          <div><b className="text-[15px]">Connect Instagram</b><div className="text-xs text-text-3">Secure Meta authorization</div></div>
        </div>
        <button onClick={close} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 hover:bg-surface-2">
          <Icon name="x" />
        </button>
      </div>
      <ModalBody>
        <p className="mb-3 text-[13.5px] leading-[1.6] text-text-2">Voom will redirect you to Instagram. Sign in there and choose the professional account you want to connect.</p>
        {PERMISSIONS.slice(0, 2).map((permission) => <div key={permission} className="flex items-start gap-2.5 py-1.5"><span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-green"><Icon name="check" size={11} className="text-white" /></span><span className="text-[13.5px]">{permission}</span></div>)}
        <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">Only professional Business or Creator accounts are supported. Voom stores access tokens encrypted on the server and never sends them to the browser.</p>
        {error ? <p className="mt-3 rounded-lg border border-red/30 bg-red/10 p-2.5 text-xs text-red">{error}</p> : null}
      </ModalBody>
      <ModalFoot><Btn variant="ghost" onClick={close}>Cancel</Btn><Btn variant="primary" disabled={busy} onClick={() => void connect()}>{busy ? "Opening Instagram…" : "Continue to Instagram"}</Btn></ModalFoot>
    </ModalShell>
  );
}
