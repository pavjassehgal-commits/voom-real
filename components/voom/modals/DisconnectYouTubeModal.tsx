"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function DisconnectYouTubeModal({ onDisconnected }: { onDisconnected?: () => void }) {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/youtube/disconnect", { method: "DELETE" });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "YouTube could not be disconnected.");
      window.dispatchEvent(new Event("voom:data-changed"));
      onDisconnected?.();
      close();
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : "YouTube could not be disconnected.", "err");
      setBusy(false);
    }
  }

  return (
    <ModalShell maxWidth={420}>
      <ModalHead title="Disconnect YouTube?" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          Voom will delete its encrypted tokens, ask Google to revoke them, and stop all future YouTube publishing.
          Items that never reached YouTube are withdrawn from the queue.
        </p>
        <p className="mt-2 text-sm leading-[1.6] text-text-2">
          Your videos on YouTube are never touched — Voom cannot delete or edit them and never asks for that
          permission. Your Voom history (drafts, queue records, performance snapshots) stays readable.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Keep connected</Btn>
        <Btn variant="danger" disabled={busy} onClick={() => void disconnect()}>{busy ? "Disconnecting…" : "Disconnect"}</Btn>
      </ModalFoot>
    </ModalShell>
  );
}
