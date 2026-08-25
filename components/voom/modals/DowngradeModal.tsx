"use client";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function DowngradeModal() {
  const { close } = useModal();
  const { setPlan, toast } = useVoomActions();

  return (
    <ModalShell maxWidth={400}>
      <ModalHead title="Downgrade to Free?" onClose={close} />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          MARA will pause paid ad management and cap you at 5 scheduled posts a month. Your content stays put.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Keep my plan
        </Btn>
        <Btn
          variant="danger"
          onClick={() => {
            setPlan("free");
            close();
            toast("Moved to the Free plan", "info");
          }}
        >
          Downgrade
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
