"use client";

import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Chip, Tag, Textarea } from "../ui/primitives";

export function PostDetailModal({ index }: { index: number }) {
  const { close } = useModal();
  const { posts } = useVoomState();
  const { deletePost, schedulePost, toast } = useVoomActions();
  const pack = useCurrentPack();
  const p = posts[index];
  if (!p) return null;

  const title = p.t.includes("· ") ? p.t.split("· ")[1] : p.t;
  const hashtags = ["#dubai", "#localbusiness", "#behindthescenes", "#smallbusiness"];

  return (
    <ModalShell>
      <ModalHead
        title={
          <>
            <span
              className="mb-2 inline-flex items-center rounded-[7px] px-2.5 py-[3px] text-[11.5px] font-semibold"
              style={{ background: `${p.c}1f`, color: p.c }}
            >
              {p.ch}
            </span>
            <div>{title}</div>
          </>
        }
        sub={`Aug ${p.d}, 2026 · ${p.time}`}
        onClose={close}
      />
      <ModalBody>
        <p className="mb-3.5 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-3">
          <span className="font-bold uppercase tracking-[.06em]">Sample</span> — this demo post is not saved in Voom. Use “New post” to save real, refresh-safe calendar items.
        </p>
        <label className="mb-3.5 block">
          <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Caption</span>
          <Textarea rows={4} defaultValue={pack.cap} />
        </label>
        <div className="mb-3.5 flex flex-wrap gap-1.5">
          {hashtags.map((h) => (
            <Chip key={h}>{h}</Chip>
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          <Btn variant="outline" size="sm" onClick={() => toast("MARA rewrote the caption")}>
            <Icon name="spark" size={14} /> Rewrite with MARA
          </Btn>
          <Btn variant="outline" size="sm" onClick={() => toast("Best time applied: 7:10 PM")}>
            <Icon name="clock" size={14} /> Best time
          </Btn>
        </div>
        <div className="my-3.5 h-px bg-line" />
        <div className="flex items-center justify-between">
          <span className="text-[13.5px] font-semibold">Status</span>
          <Tag tone={p.st === "Scheduled" ? "t-green" : p.st === "Draft" ? "t-amber" : "t-grey"}>{p.st}</Tag>
        </div>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn
          variant="danger"
          size="sm"
          onClick={() => {
            deletePost(index);
            close();
          }}
        >
          <Icon name="trash" size={14} /> Delete
        </Btn>
        <div className="flex gap-2.5">
          <Btn variant="ghost" onClick={close}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            onClick={() => {
              schedulePost(index);
              close();
              toast(`Post scheduled for Aug ${p.d}`, "ok", true);
            }}
          >
            Schedule
          </Btn>
        </div>
      </ModalFoot>
    </ModalShell>
  );
}
