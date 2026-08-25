"use client";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function MaxRequiredModal() {
  const { close } = useModal();
  const { goTo } = useVoomActions();

  return (
    <ModalShell maxWidth={420}>
      <ModalHead
        title={
          <span className="flex items-center gap-1.5">
            <Icon name="crown" size={18} /> Max required
          </span>
        }
        sub="Paid ad management"
        onClose={close}
      />
      <ModalBody>
        <p className="text-sm leading-[1.6] text-text-2">
          MARA can build and monitor budgets on any plan, but she can only run spend on <b>Max</b> — that&apos;s where budget limits and automatic
          performance pauses live.
        </p>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Not now
        </Btn>
        <Btn
          variant="primary"
          onClick={() => {
            close();
            goTo("pricing");
          }}
        >
          Upgrade to Max
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
