"use client";

import { KPIS } from "@/lib/voom/demoData";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { AreaChart } from "../dashboard/AreaChart";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Tag } from "../ui/primitives";
import { DemoTag } from "../ui/Notes";

export function KpiDetailModal({ kpiKey }: { kpiKey: string }) {
  const { close } = useModal();
  const { askMara, goTo } = useVoomActions();
  const x = KPIS.find((k) => k.k === kpiKey);
  if (!x) return null;

  return (
    <ModalShell>
      <ModalHead title={x.lab} sub="Last 30 days" onClose={close} />
      <ModalBody>
        <div className="flex items-baseline gap-3">
          <span className="font-display text-[38px]">{x.val}</span>
          <Tag tone={x.up ? "t-green" : "t-red"}>{x.d}</Tag>
        </div>
        <div className="mt-2 flex flex-wrap gap-1.5">
          <DemoTag />
        </div>
        <div className="relative my-3.5 h-[150px]">
          <AreaChart />
        </div>
        <Card className="border-brand bg-[var(--brand-soft)] p-4">
          <p className="text-[13.5px] leading-[1.6]">
            {x.up
              ? "The lift is mostly Reels — evening posts drove 71% of the change. I'd double down on that slot."
              : "Revenue dipped because we paused paid retargeting on Aug 9. Approving the new budget should recover it inside a week."}
          </p>
        </Card>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Close
        </Btn>
        <Btn
          variant="primary"
          onClick={() => {
            close();
            askMara(`Why did ${x.lab} change?`, () => goTo("mara"));
          }}
        >
          Ask MARA about this
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
