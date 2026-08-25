"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Orb, Tag } from "../ui/primitives";
import { ProtoNote } from "../ui/Notes";

const ACCOUNTS: [string, string, string, string][] = [
  ["Lumé Skincare", "@lumeskin", "48.2K followers", "Business"],
  ["Priya Sharma", "@priya.writes", "3,190 followers", "Creator"],
];

const PERMISSIONS = ["Publish Reels, posts and stories", "Read insights and audience data", "Manage comments and messages", "Access your media library"];

export function InstagramConnectModal() {
  const { close } = useModal();
  const { igConnect, toast } = useVoomActions();
  const [step, setStep] = useState<1 | 2 | "syncing">(1);

  if (step === "syncing") {
    return (
      <ModalShell maxWidth={360}>
        <div className="p-9 text-center">
          <div className="grid place-items-center">
            <Orb size="lg" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold">Syncing @lumeskin</h2>
          <p className="mt-1.5 text-[13.5px] text-text-2">Pulling 90 days of posts and insights…</p>
        </div>
      </ModalShell>
    );
  }

  if (step === 2) {
    return (
      <ModalShell maxWidth={420}>
        <ModalHead title="Voom is requesting access" sub="as @lumeskin" onClose={close} />
        <ModalBody>
          {PERMISSIONS.map((p) => (
            <div key={p} className="flex items-start gap-2.5 py-1.5">
              <span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-green">
                <Icon name="check" size={11} className="text-white" />
              </span>
              <span className="text-[13.5px]">{p}</span>
            </div>
          ))}
          <div className="my-3.5 h-px bg-line" />
          <p className="text-xs leading-[1.55] text-text-3">
            You can revoke access at any time from Instagram settings. This prototype does not contact Instagram.
          </p>
          <div className="mt-3">
            <ProtoNote />
          </div>
        </ModalBody>
        <ModalFoot>
          <Btn
            variant="ghost"
            onClick={() => {
              close();
              toast("Connection cancelled", "info");
            }}
          >
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={() => {
              setStep("syncing");
              setTimeout(() => {
                igConnect();
                close();
              }, 1800);
            }}
          >
            Allow access
          </Btn>
        </ModalFoot>
      </ModalShell>
    );
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
          <div>
            <b className="text-[15px]">Continue to Instagram</b>
            <div className="text-xs text-text-3">Simulated authorisation</div>
          </div>
        </div>
        <button onClick={close} className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 hover:bg-surface-2">
          <Icon name="x" />
        </button>
      </div>
      <ModalBody>
        <p className="mb-4 text-[13.5px] leading-[1.6] text-text-2">Choose the account you&apos;d like Voom to manage.</p>
        {ACCOUNTS.map(([n, h, f, ty]) => (
          <button
            key={n}
            onClick={() => setStep(2)}
            className="mb-2.5 flex w-full items-center gap-3.5 rounded-2xl border border-line p-3.5 text-left transition hover:border-brand hover:bg-[var(--brand-soft)]"
          >
            <span
              className="flex h-12 w-12 flex-none items-center justify-center rounded-full p-[2.5px]"
              style={{ background: "linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)" }}
            >
              <span className="voom-grad grid h-full w-full place-items-center rounded-full border-2 border-surface text-white">{n[0]}</span>
            </span>
            <div className="min-w-0 flex-1">
              <b className="text-[14px]">{n}</b>
              <div className="text-[12.5px] text-text-3">
                {h} · {f}
              </div>
            </div>
            <Tag tone={ty === "Business" ? "t-brand" : "t-grey"}>{ty}</Tag>
          </button>
        ))}
        <p className="mt-2 text-[11.5px] text-text-3">Only Business and Creator accounts can be automated by Instagram.</p>
      </ModalBody>
    </ModalShell>
  );
}
