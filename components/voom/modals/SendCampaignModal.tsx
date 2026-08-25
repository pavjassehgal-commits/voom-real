"use client";

import { useState } from "react";
import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, StatMini, Textarea } from "../ui/primitives";
import { PROTO_TEXT } from "../ui/Notes";

export function SendCampaignModal({ kind, index }: { kind: "email" | "sms"; index: number }) {
  const { close } = useModal();
  const { emails, sms } = useVoomState();
  const { sendCampaign, toast } = useVoomActions();
  const pack = useCurrentPack();
  const em = kind === "email";
  const c = (em ? emails : sms)[index];
  const [smsLen, setSmsLen] = useState(pack.smsT.length);
  if (!c) return null;

  return (
    <ModalShell wide>
      <ModalHead title={c.n} sub={c.seg} onClose={close} />
      <ModalBody>
        {em ? (
          <>
            <Field label="Subject line">
              <Input defaultValue={pack.emailSub} />
            </Field>
            <Field label="Preview text">
              <Input defaultValue={pack.emailN} />
            </Field>
            <Field label="Body">
              <Textarea rows={5} defaultValue={`Hi {{first_name}} — ${pack.emailBody}`} />
            </Field>
          </>
        ) : (
          <Field
            label="Message"
            hint={`${smsLen}/160 characters · 1 segment · est. cost AED ${(3190 * 0.12).toFixed(2)}`}
          >
            <Textarea rows={4} maxLength={160} defaultValue={pack.smsT} onChange={(e) => setSmsLen(e.target.value.length)} />
          </Field>
        )}
        <Field label="Audience">
          <select className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]">
            <option>{c.seg}</option>
            <option>All subscribers · 8,412</option>
            <option>VIP buyers · 610</option>
            <option>Cold 60d · 1,284</option>
          </select>
        </Field>
        <div className="flex gap-2.5">
          <Field label="Date">
            <Input type="date" defaultValue="2026-08-26" />
          </Field>
          <Field label="Time">
            <Input type="time" defaultValue={em ? "09:00" : "11:00"} />
          </Field>
        </div>
        <div className="grid grid-cols-3 gap-2.5">
          <StatMini value={c.seg.split("· ")[1] || "—"} label="Recipients" />
          <StatMini value={em ? "3,466" : "3,129"} label="Est. opens" />
          <StatMini value={em ? "AED 3,100" : "AED 2,240"} label="Est. revenue" />
        </div>
        <Card className="mt-3.5 border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="text-amber" />
            <p className="text-[13px] leading-[1.55]">
              No {em ? "email" : "SMS"} provider is connected in this prototype — &quot;Send&quot; simulates the campaign and generates sample results.
              <br />
              <b>{PROTO_TEXT}</b>
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <div className="flex gap-2.5">
          <Btn variant="outline" onClick={() => toast("Test send simulated", "info", true)}>
            Send test
          </Btn>
          <Btn
            variant="primary"
            onClick={() => {
              sendCampaign(kind, index);
              close();
            }}
          >
            <Icon name="send" size={14} /> Send now
          </Btn>
        </div>
      </ModalFoot>
    </ModalShell>
  );
}
