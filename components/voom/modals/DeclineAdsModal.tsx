"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Chip, Textarea } from "../ui/primitives";
import { ProtoNote } from "../ui/Notes";

const REASONS = ["Too expensive right now", "Wrong channel mix", "Want to test organic first", "Not the right timing"];

export function DeclineAdsModal() {
  const { close } = useModal();
  const { declineAds } = useVoomActions();
  const [reason, setReason] = useState<string | null>(null);

  return (
    <ModalShell maxWidth={420}>
      <ModalHead title="Decline this budget?" onClose={close} />
      <ModalBody>
        <p className="mb-3.5 text-sm leading-[1.6] text-text-2">Tell MARA why, and she&apos;ll rebuild the plan around it. Nothing is spent either way.</p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {REASONS.map((r) => (
            <Chip key={r} active={reason === r} onClick={() => setReason(r)}>
              {r}
            </Chip>
          ))}
        </div>
        <Textarea rows={3} placeholder="Anything else?" />
        <div className="mt-3">
          <ProtoNote />
        </div>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <Btn
          variant="danger"
          onClick={() => {
            declineAds();
            close();
          }}
        >
          Decline budget
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
