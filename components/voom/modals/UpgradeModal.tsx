"use client";

import { useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { nfc, PLANS } from "@/lib/voom/demoData";
import type { Plan } from "@/lib/voom/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Orb } from "../ui/primitives";
import { AdSepNote, PROTO_TEXT } from "../ui/Notes";

export function UpgradeModal({ planId }: { planId: Plan["id"] }) {
  const { close } = useModal();
  const { setPlan, toast, goTo } = useVoomActions();
  const [phase, setPhase] = useState<"form" | "processing" | "done">("form");
  const p = PLANS.find((x) => x.id === planId)!;

  function submit() {
    setPhase("processing");
    setTimeout(() => {
      setPlan(planId);
      setPhase("done");
      toast(`Upgraded to ${p.name} — simulated`, "ok", true);
    }, 1600);
  }

  if (phase === "processing") {
    return (
      <ModalShell maxWidth={340}>
        <div className="p-9 text-center">
          <div className="grid place-items-center">
            <Orb size="lg" />
          </div>
          <h2 className="mt-4 font-display text-lg font-semibold">Processing…</h2>
        </div>
      </ModalShell>
    );
  }

  if (phase === "done") {
    return (
      <ModalShell maxWidth={400}>
        <div className="p-8 text-center">
          <div className="mx-auto mb-4 grid h-[60px] w-[60px] place-items-center rounded-full bg-green text-white">
            <Icon name="check" size={24} />
          </div>
          <h2 className="font-display text-lg font-semibold">You&apos;re on {p.name}</h2>
          <div className="mt-2 flex justify-center">
            <span className="rounded-[7px] bg-surface-2 px-2.5 py-[3px] text-[11.5px] font-semibold text-text-3">{PROTO_TEXT}</span>
          </div>
          <p className="mt-2.5 text-[13.8px] leading-[1.6] text-text-2">
            {planId === "max"
              ? "MARA can now manage paid budgets and run your channels end-to-end."
              : "Unlimited MARA chat, scheduling and campaigns are unlocked."}
          </p>
          <Btn
            variant="primary"
            block
            className="mt-5"
            onClick={() => {
              close();
              goTo(planId === "max" ? "ads" : "mara");
            }}
          >
            {planId === "max" ? "Review the ad budget" : "Talk to MARA"}
          </Btn>
          <Btn variant="ghost" block className="mt-2" onClick={close}>
            Back to plans
          </Btn>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell>
      <ModalHead title={`Upgrade to ${p.name}`} sub="Billed monthly · software subscription only" onClose={close} />
      <ModalBody>
        <Card className="mb-4 flex items-center justify-between bg-surface-2 p-4">
          <div>
            <b className="text-[14.5px]">Voom {p.name}</b>
            <div className="text-[12.5px] text-text-3">Renews monthly · software only</div>
          </div>
          <div className="text-right">
            <b className="font-display text-lg">AED {nfc(p.m)}</b>
            <div className="text-xs text-text-3">per month</div>
          </div>
        </Card>
        <AdSepNote />
        <div className="h-3.5" />
        <Field label="Card number">
          <Input value="4242 4242 4242 4242" readOnly />
        </Field>
        <div className="flex gap-2.5">
          <Field label="Expiry">
            <Input value="12 / 29" readOnly />
          </Field>
          <Field label="CVC">
            <Input value="•••" readOnly />
          </Field>
        </div>
        <Card className="border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="text-amber" />
            <p className="text-[13px] leading-[1.55]">
              Stripe isn&apos;t connected — these are placeholder details and no payment will be taken.
              <br />
              <b>{PROTO_TEXT}</b>
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={submit}>
          <Icon name="card" size={14} /> Simulate payment
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
