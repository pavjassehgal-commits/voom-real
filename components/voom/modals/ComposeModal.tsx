"use client";

import { useState } from "react";
import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Field, Input, Textarea } from "../ui/primitives";
import type { Channel } from "@/lib/voom/types";

const CHANNELS: [string, Channel][] = [
  ["🎬", "Reel"],
  ["🖼️", "Feed"],
  ["✉️", "Email"],
  ["💬", "SMS"],
];

const COLORS: Record<Channel, string> = { Reel: "#e8481f", Feed: "#c9306b", Email: "#0f6f68", SMS: "#f2a516" };

export function ComposeModal({ day }: { day?: number }) {
  const { close } = useModal();
  const { addPost, toast } = useVoomActions();
  const pack = useCurrentPack();
  const { brand } = useVoomState();
  const d = day || 24;

  const [channel, setChannel] = useState<Channel>("Reel");
  const [topic, setTopic] = useState(pack.p[0]);
  const [caption, setCaption] = useState("");
  const [generating, setGenerating] = useState(false);

  function generate() {
    setGenerating(true);
    setCaption("Writing…");
    setTimeout(() => {
      setCaption(
        `Nobody tells you this about ${(topic || "your topic").toLowerCase()} — here's the 30-second version.\n\n#dubai #smallbusiness ${brand.handle.replace("@", "#")}`,
      );
      setGenerating(false);
      toast("MARA wrote your caption");
    }, 700);
  }

  function submit(status: "Draft" | "Scheduled") {
    addPost({ d, t: `${channel} · ${topic || "New post"}`, c: COLORS[channel], ch: channel, time: "7:10 PM", st: status });
    close();
    toast(status === "Scheduled" ? `${channel} scheduled for Aug ${d}, ${pack.slot}` : "Saved as draft", "ok", status === "Scheduled");
  }

  return (
    <ModalShell wide>
      <ModalHead title="Create content" sub="MARA will format it for the channel you pick." onClose={close} />
      <ModalBody>
        <label className="mb-2.5 block text-[12.5px] font-semibold text-text-2">Channel</label>
        <div className="mb-4.5 grid grid-cols-2 gap-2.5 sm:grid-cols-4">
          {CHANNELS.map(([emoji, name]) => (
            <button
              key={name}
              onClick={() => setChannel(name)}
              className={`rounded-[14px] border-[1.5px] p-3.5 text-left transition ${channel === name ? "border-brand bg-[var(--brand-soft)]" : "border-line hover:border-line-2"}`}
            >
              <span className="mb-1.5 block text-[22px]">{emoji}</span>
              <b className="text-[13.5px]">{name}</b>
            </button>
          ))}
        </div>
        <Field label="What's it about?">
          <Input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. what makes your best seller work" />
        </Field>
        <Btn variant="outline" size="sm" className="mb-3.5" onClick={generate} disabled={generating}>
          <Icon name="spark" size={14} /> Generate with MARA
        </Btn>
        <Field label="Caption">
          <Textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="MARA will write this for you…" />
        </Field>
        <div className="flex gap-2.5">
          <Field label="Date">
            <Input type="date" defaultValue={`2026-08-${String(d).padStart(2, "0")}`} />
          </Field>
          <Field label="Time">
            <Input type="time" defaultValue="19:10" />
          </Field>
        </div>
        <div className="flex items-center gap-1.5 text-[12.5px] text-brand">
          <Icon name="spark" size={14} /> {pack.slot} is the best-performing slot in this demo dataset.
        </div>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <Btn variant="outline" onClick={() => submit("Draft")}>
          Save draft
        </Btn>
        <Btn variant="primary" onClick={() => submit("Scheduled")}>
          <Icon name="clock" size={14} /> Schedule
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
