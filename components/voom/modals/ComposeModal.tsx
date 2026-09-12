"use client";

import { useState } from "react";
import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Field, Input, Textarea } from "../ui/primitives";
import type { Channel } from "@/lib/voom/types";
import { DEFAULT_TIMEZONE, localDate } from "@/lib/voom/timezone";

const CHANNELS: [string, Channel][] = [
  ["🎬", "Reel"],
  ["🖼️", "Feed"],
  ["✉️", "Email"],
  ["💬", "SMS"],
];

export function ComposeModal({ day }: { day?: number }) {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const pack = useCurrentPack();
  const { brand } = useVoomState();

  const [channel, setChannel] = useState<Channel>("Reel");
  const [topic, setTopic] = useState(pack.p[0]);
  const [caption, setCaption] = useState("");
  // Composing always starts from the real current date in the account
  // timezone — optionally on the calendar day the user clicked.
  const [date, setDate] = useState(() => {
    const today = localDate(new Date(), DEFAULT_TIMEZONE);
    return day ? `${today.slice(0, 8)}${String(day).padStart(2, "0")}` : today;
  });
  const [time, setTime] = useState("19:10");
  const [generating, setGenerating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  function generate() {
    setGenerating(true);
    setCaption("Writing…");
    setTimeout(() => {
      setCaption(
        `Nobody tells you this about ${(topic || "your topic").toLowerCase()} — here's the 30-second version.\n\n#dubai #smallbusiness ${brand.handle.replace("@", "#")}`,
      );
      setGenerating(false);
      toast("Sample caption added — save it to keep it");
    }, 700);
  }

  async function submit(status: "draft" | "scheduled") {
    if (!caption.trim()) {
      setError("Write a caption first.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const body = {
        title: `${channel} · ${topic || "New post"}`,
        channel,
        content: caption.trim(),
        topic: topic.trim(),
        publishAt: composePublishAt(date, time),
        status,
      };
      const response = await fetch("/api/voom/calendar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await response.json() as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Voom couldn't save that post. Please retry.");
        return;
      }
      window.dispatchEvent(new Event("voom:data-changed"));
      close();
      toast(
        status === "scheduled"
          ? `${channel} planned inside Voom for ${formatShort(date, time)} — nothing published externally`
          : `${channel} saved as a draft inside Voom`,
        "ok",
        status === "scheduled",
      );
    } catch {
      setError("Voom couldn't save that post. Please retry.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <ModalShell wide>
      <ModalHead title="Create content" sub="Saved as a real Voom calendar item — never published outside Voom without explicit approval." onClose={close} />
      <ModalBody>
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}
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
          <Icon name="spark" size={14} /> {generating ? "Writing…" : "Sample caption"}
        </Btn>
        <Field label="Caption">
          <Textarea rows={4} value={caption} onChange={(e) => setCaption(e.target.value)} placeholder="Write the caption here…" />
        </Field>
        <div className="flex gap-2.5">
          <Field label="Date">
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <Field label="Time">
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} />
          </Field>
        </div>
        <div className="flex items-center gap-1.5 text-[12.5px] text-brand">
          <Icon name="spark" size={14} /> {pack.slot} is the best-performing slot in this sample dataset.
        </div>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <Btn variant="outline" disabled={saving} onClick={() => void submit("draft")}>
          Save draft
        </Btn>
        <Btn variant="primary" disabled={saving} onClick={() => void submit("scheduled")}>
          <Icon name="clock" size={14} /> {saving ? "Saving…" : "Plan in calendar"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function composePublishAt(date: string, time: string): string {
  const value = new Date(time ? `${date}T${time}` : `${date}T00:00`);
  return Number.isNaN(value.getTime()) ? new Date().toISOString() : value.toISOString();
}

function formatShort(date: string, time: string): string {
  const value = new Date(time ? `${date}T${time}` : `${date}T00:00`);
  if (Number.isNaN(value.getTime())) return "the chosen date";
  return new Intl.DateTimeFormat("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(value);
}
