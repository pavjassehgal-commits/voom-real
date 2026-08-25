"use client";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function DisconnectInstagramModal() {
  const { close } = useModal();
  const { igDisconnect } = useVoomActions();

  return (
    <ModalShell maxWidth={400}>
      <ModalHead title="Disconnect Instagram?" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          MARA will stop publishing immediately. 3 scheduled Reels will revert to drafts and insights will stop updating.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Keep connected
        </Btn>
        <Btn
          variant="danger"
          onClick={() => {
            igDisconnect();
            close();
          }}
        >
          Disconnect
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
