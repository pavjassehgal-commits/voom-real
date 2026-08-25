"use client";

import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

const ROWS: [string, string][] = [
  ["Autonomy level", "Ask before publishing"],
  ["Daily briefing", "8:00 AM · Email"],
  ["Tone", "Warm, playful, expert"],
  ["Banned words", "“miracle”, “cure”, “anti-aging”"],
];

export function MaraMenuModal() {
  const { close } = useModal();
  const { toast, clearChat } = useVoomActions();

  return (
    <ModalShell>
      <ModalHead title="MARA settings" onClose={close} />
      <ModalBody>
        {ROWS.map(([a, b]) => (
          <div key={a} className="flex items-center justify-between border-b border-line py-2.5 last:border-0">
            <span className="text-[13.5px] font-semibold">{a}</span>
            <button
              className="flex items-center gap-1.5 text-[13px] text-text-3"
              onClick={() => toast(`Editing ${a} — visual only`, "info")}
            >
              {b} <Icon name="arrow" size={14} />
            </button>
          </div>
        ))}
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn
          variant="danger"
          size="sm"
          onClick={() => {
            clearChat();
            close();
          }}
        >
          <Icon name="trash" size={14} /> Clear chat
        </Btn>
        <Btn variant="primary" onClick={close}>
          Done
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
