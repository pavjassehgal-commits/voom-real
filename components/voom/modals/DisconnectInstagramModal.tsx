"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function DisconnectInstagramModal() {
  const { close } = useModal();
  const { igDisconnect, toast } = useVoomActions();
  const [busy, setBusy] = useState(false);

  async function disconnect() {
    setBusy(true);
    try {
      const response = await fetch("/api/integrations/instagram/disconnect", { method: "DELETE" });
      const value = await response.json() as { error?: string };
      if (!response.ok) throw new Error(value.error ?? "Instagram could not be disconnected.");
      igDisconnect(); window.dispatchEvent(new Event("voom:instagram-changed")); close();
    } catch (cause) { toast(cause instanceof Error ? cause.message : "Instagram could not be disconnected.", "err"); setBusy(false); }
  }

  return (
    <ModalShell maxWidth={400}>
      <ModalHead title="Disconnect Instagram?" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          Voom will delete its stored access token and stop all Instagram access. Existing Voom drafts and calendar items will remain drafts.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Keep connected
        </Btn>
        <Btn
          variant="danger"
          disabled={busy}
          onClick={() => void disconnect()}
        >
          {busy ? "Disconnecting…" : "Disconnect"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
