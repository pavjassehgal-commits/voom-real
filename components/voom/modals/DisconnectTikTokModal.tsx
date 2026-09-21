"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function DisconnectTikTokModal({ onDisconnected }: { onDisconnected?: () => void }) {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/tiktok/disconnect", { method: "DELETE" });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "TikTok could not be disconnected.");
      window.dispatchEvent(new Event("voom:data-changed"));
      onDisconnected?.();
      close();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "TikTok could not be disconnected.", "err");
      setBusy(false);
    }
  }

  return (
    <ModalShell maxWidth={420}>
      <ModalHead title="Disconnect TikTok?" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          Voom will delete its encrypted tokens, ask TikTok to revoke them, and stop all future TikTok publishing.
          Items that never reached TikTok are withdrawn from the queue.
        </p>
        <p className="mt-2 text-sm leading-[1.6] text-text-2">
          Your posts on TikTok are never touched — Voom cannot delete or edit them and never asks for that
          permission. Posts already with TikTok keep their provider state, and your Voom history (drafts, queue
          records, proven publication facts) stays readable.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Keep connected</Btn>
        <Btn variant="danger" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect"}</Btn>
      </ModalFoot>
    </ModalShell>
  );
}
