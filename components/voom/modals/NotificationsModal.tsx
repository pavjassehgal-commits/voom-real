"use client";

import { useVoomActions, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon, type IconName } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn } from "../ui/primitives";

export function NotificationsModal() {
  const { close } = useModal();
  const { goTo } = useVoomActions();
  const pack = useCurrentPack();

  const items: [IconName, string, string, string, string][] = [
    ["wallet", "--green", "Sample: MARA needs budget approval", "AED 1,200 allocation ready for review in the sample dataset · 2h ago", "ads"],
    ["film", "--rose", "Sample: Reel queued", `"${pack.r[0]}" is in the sample queue at ${pack.slot} · nothing published · 5h ago`, "reels"],
    ["mail", "--brand", "Sample: email draft prepared", `"${pack.emailN}" was drafted by MARA. Nothing has been sent — connect a provider first. · 1d ago`, "campaigns"],
  ];

  return (
    <ModalShell>
      <ModalHead title="Notifications" sub="3 new" onClose={close} />
      <ModalBody className="flex flex-col gap-2.5">
        {items.map(([icon, color, title, body, go]) => (
          <button
            key={title}
            onClick={() => {
              close();
              goTo(go);
            }}
            className="flex w-full items-start gap-3 rounded-2xl border border-line p-3.5 text-left transition hover:border-brand"
          >
            <span
              className="grid h-[34px] w-[34px] flex-none place-items-center rounded-[10px]"
              style={{ background: `color-mix(in srgb, var(${color}) 14%, transparent)`, color: `var(${color})` }}
            >
              <Icon name={icon} size={17} />
            </span>
            <div className="min-w-0 flex-1">
              <b className="text-[13.5px]">{title}</b>
              <p className="mt-0.5 text-[13px] text-text-2">{body}</p>
            </div>
            <span className="text-text-3">
              <Icon name="arrow" size={16} />
            </span>
          </button>
        ))}
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Close
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
