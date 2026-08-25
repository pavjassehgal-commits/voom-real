"use client";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function ConnectInstagramFirstModal() {
  const { close } = useModal();
  const { goTo, saveReelDraft } = useVoomActions();

  return (
    <ModalShell maxWidth={420}>
      <ModalHead title="Connect Instagram first" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          MARA can save this as a draft now, but she needs a connected Instagram account to publish it automatically.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn
          variant="ghost"
          onClick={() => {
            saveReelDraft();
            close();
          }}
        >
          Save as draft
        </Btn>
        <Btn
          variant="primary"
          onClick={() => {
            close();
            goTo("instagram");
          }}
        >
          Connect Instagram
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
