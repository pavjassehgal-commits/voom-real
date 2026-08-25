"use client";

import { useState } from "react";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { nfc } from "@/lib/voom/demoData";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, StatMini } from "../ui/primitives";
import { AdSepNote, PROTO_TEXT } from "../ui/Notes";

export function ApproveAdsModal({ isChange }: { isChange: boolean }) {
  const { close } = useModal();
  const { adAlloc, adTotal, approvedPlan } = useVoomState();
  const { confirmAds, toast } = useVoomActions();
  const [checked, setChecked] = useState(false);

  const proj = Math.round(adAlloc.reduce((a, b) => a + (adTotal * b.pct) / 100 * parseFloat(b.roas), 0));
  const roas = (proj / adTotal).toFixed(1);
  const ap = approvedPlan;
  const up = isChange && ap ? adTotal > ap.limit : false;

  function submit() {
    if (!checked) {
      toast("Tick the authorisation box to continue", "err");
      return;
    }
    confirmAds(isChange);
    close();
  }

  return (
    <ModalShell>
      <ModalHead
        title={`${isChange ? "Approve new limit of" : "Approve"} AED ${nfc(adTotal)}`}
        sub={isChange && ap ? `Change request · was AED ${nfc(ap.limit)}` : `14 days · ${adAlloc.length} campaigns`}
        onClose={close}
      />
      <ModalBody>
        {isChange && ap && (
          <Card className={`mb-3.5 p-4 ${up ? "border-red bg-red/[.08]" : "border-green bg-green/[.08]"}`}>
            <div className="flex flex-wrap gap-4">
              <div>
                <div className="text-[11.5px] text-text-3">Approved now</div>
                <b className="font-mono">AED {nfc(ap.limit)}</b>
              </div>
              <div className="grid place-items-center text-text-3">
                <Icon name="arrow" size={16} />
              </div>
              <div>
                <div className="text-[11.5px] text-text-3">New limit</div>
                <b className="font-mono">AED {nfc(adTotal)}</b>
              </div>
              <div>
                <div className="text-[11.5px] text-text-3">{up ? "Extra authorised" : "Reduction"}</div>
                <b className={`font-mono ${up ? "text-red" : "text-green"}`}>
                  {up ? "+" : "−"}AED {nfc(Math.abs(adTotal - ap.limit))}
                </b>
              </div>
              <div>
                <div className="text-[11.5px] text-text-3">Already spent</div>
                <b className="font-mono">AED {nfc(ap.spent)}</b>
              </div>
            </div>
          </Card>
        )}
        {adAlloc.map((a) => (
          <div key={a.n} className="flex items-center justify-between border-b border-line py-2.5">
            <span className="flex items-center gap-1.5 text-[13.3px]">
              <span className="h-2 w-2 rounded-full" style={{ background: a.c }} />
              {a.n}
            </span>
            <b className="font-mono text-[13.3px]">AED {nfc(Math.round((adTotal * a.pct) / 100))}</b>
          </div>
        ))}
        <div className="flex items-center justify-between py-3.5">
          <b>{isChange ? "New total limit" : "Total"}</b>
          <b className="font-display text-lg">AED {nfc(adTotal)}</b>
        </div>
        <div className="grid grid-cols-2 gap-2.5">
          <StatMini value={`AED ${nfc(proj)}`} label="Example tracked revenue" />
          <StatMini value={`${roas}×`} label="Example ROAS" />
        </div>
        <p className="mt-2 text-[11.5px] text-text-3">Example scenario from demo data — not a guaranteed result. Revenue is not profit.</p>
        <label className="mt-4 flex cursor-pointer items-start gap-2.5 text-[13px]">
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => setChecked(e.target.checked)}
            className="mt-0.5 h-[17px] w-[17px] accent-brand"
          />
          <span>
            I authorise MARA to spend up to <b>AED {nfc(adTotal)}</b> in total from <b>my own advertising account</b>. MARA may optimise and pause
            inside this limit, and must ask me again before any increase. My Voom subscription is billed separately.
          </span>
        </label>
        <Card className="mt-3.5 border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="text-amber" />
            <p className="text-[12.8px] leading-[1.55]">
              No ad account is connected — approving here simulates the launch and generates sample performance.
              <br />
              <b>{PROTO_TEXT}</b>
            </p>
          </div>
        </Card>
        <div className="mt-2.5">
          <AdSepNote />
        </div>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={submit}>
          <Icon name="check" size={14} /> {isChange ? "Approve new limit" : "Approve & launch"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
