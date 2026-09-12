"use client";

import { useState } from "react";
import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { TMPLS } from "@/lib/voom/demoData";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { ConnectInstagramFirstModal } from "@/components/voom/modals/ConnectInstagramFirstModal";
import { Btn, Card, IconBtn, Tag, Textarea } from "@/components/voom/ui/primitives";
import { DemoTag, ExTag } from "@/components/voom/ui/Notes";
import { DEFAULT_TIMEZONE, localDate } from "@/lib/voom/timezone";

export default function ReelsPage() {
  const { reelTmpl, reelCaption, reelTime, igConnected, reelQueue, brand } = useVoomState();
  const { setReelTmpl, setReelCaption, setReelTime, maraRewriteCaption, scheduleReel, bestTimeAll, goTo, toast, reelDelete, reelSchedule, reelChangeTime } =
    useVoomActions();
  const { open } = useModal();
  const pack = useCurrentPack();
  const [reelDate, setReelDate] = useState(() => localDate(new Date(), DEFAULT_TIMEZONE));

  const tmpl = TMPLS[reelTmpl];
  const cap = reelCaption || pack.cap;

  function handleSchedule() {
    if (!igConnected) {
      open(<ConnectInstagramFirstModal />);
      return;
    }
    scheduleReel();
  }

  return (
    <div>
      <PageHead
        title="Reel scheduling"
        description="Sample workspace for building a Reel preview. The persisted MARA Reel production flow is under Approvals."
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={bestTimeAll}>
              <Icon name="clock" size={14} /> Optimise whole queue
            </Btn>
            <Btn variant="primary" size="sm" onClick={handleSchedule}>
              <Icon name="plus" size={14} /> Schedule Reel
            </Btn>
          </>
        }
      />

      <Card className="mb-3.5 border-brand/30 bg-[var(--brand-soft)] p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="voom-grad grid h-[26px] w-[26px] flex-none place-items-center rounded-[9px] text-white">
                <Icon name="film" size={14} />
              </span>
              <h2 className="font-display text-[15px] font-semibold">The real MARA Reel workflow</h2>
            </div>
            <p className="mt-1.5 max-w-xl text-[13px] leading-[1.55] text-text-2">
              Create with MARA, asset upload and the playable preview run from <b>Approvals</b>, not from this studio.
              Click path: <b>Marketing Plan → Generate/Refresh plan → Approvals → “Reel production choice” → Create with MARA</b>.
              A Reel choice appears only when your plan includes a Reel recommendation.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Btn variant="outline" size="sm" onClick={() => goTo("plan")}>
              <Icon name="spark" size={14} /> Review marketing plan
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => goTo("approvals")}>
              <Icon name="check" size={14} /> Open real Reel workflow
            </Btn>
          </div>
        </div>
        <p className="mt-3 rounded-[9px] bg-surface/70 px-3 py-2 text-[11.5px] leading-relaxed text-text-3">
          <DemoTag /> Everything below this card is a <b>sample workspace</b>: the preview, queue and dates are illustration-only and not saved.
        </p>
      </Card>

      {!igConnected && (
        <Card className="mb-3.5 flex flex-wrap items-center justify-between gap-3 border-amber bg-amber/[.07] p-3.5">
          <div className="flex items-center gap-2.5">
            <Icon name="warn" className="text-amber" />
            <span className="text-[13.5px]">Instagram isn&apos;t connected — Reels will stay in draft until it is.</span>
          </div>
          <Btn variant="dark" size="sm" onClick={() => goTo("instagram")}>
            Connect Instagram
          </Btn>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-[340px_1fr]">
        <Card className="p-4">
          <h2 className="mb-3.5 text-center font-display text-lg font-semibold">Preview</h2>
          <div className="mx-auto w-[250px] rounded-[32px] bg-black p-2.5 shadow-[var(--shadow-lg)]">
            <div className="relative flex aspect-[9/16] flex-col justify-end overflow-hidden rounded-[25px] p-3.5 text-white" style={{ background: tmpl.g }}>
              <div className="absolute inset-0" style={{ background: "linear-gradient(transparent 45%, rgba(0,0,0,.72))" }} />
              <div className="absolute right-2.5 bottom-[60px] z-[2] flex flex-col items-center gap-3.5">
                {[
                  ["heart", "4.2K"],
                  ["chat", "318"],
                  ["send", "1.1K"],
                ].map(([icon, n]) => (
                  <div key={icon} className="flex flex-col items-center gap-0.5 text-[9.5px] font-semibold">
                    <Icon name={icon} size={20} className="fill-white drop-shadow" />
                    <span>{n}</span>
                  </div>
                ))}
              </div>
              <div className="relative z-[2] pr-[38px] text-[11.5px] leading-[1.45]" style={{ textShadow: "0 1px 8px rgba(0,0,0,.6)" }}>
                <div className="mb-1.5 flex items-center gap-1.5 font-bold">
                  <span className="grid h-5 w-5 place-items-center rounded-full bg-white/30 text-[9px]">L</span>
                  {brand.handle} · <span className="font-medium opacity-80">Follow</span>
                </div>
                {cap.split("\n").map((line, i) => (
                  <span key={i}>
                    {line}
                    <br />
                  </span>
                ))}
                <div className="mt-1.5 flex items-center gap-1 text-[10px] opacity-85">
                  <Icon name="music" size={11} /> Original audio · {brand.name}
                </div>
              </div>
            </div>
          </div>
          <div className="mt-3.5 flex justify-center gap-2">
            <Btn variant="ghost" size="sm" onClick={() => toast("Playing preview (visual only)", "info")}>
              <Icon name="play" size={14} /> Play
            </Btn>
            <Btn variant="ghost" size="sm" onClick={() => toast("Cover frame updated", "info")}>
              <Icon name="img" size={14} /> Cover
            </Btn>
          </div>
        </Card>

        <div>
          <Card className="mb-3.5 p-4">
            <h2 className="mb-3 font-display text-lg font-semibold">Template</h2>
            <div className="grid grid-cols-3 gap-2.5 sm:grid-cols-4">
              {TMPLS.map((t, i) => (
                <button
                  key={t.n}
                  onClick={() => setReelTmpl(i)}
                  className={`flex aspect-[9/13] items-end rounded-[11px] border-[2.5px] p-1.5 text-[10.5px] font-semibold text-white transition hover:-translate-y-0.5 ${reelTmpl === i ? "scale-[.97] border-brand" : "border-transparent"}`}
                  style={{ background: t.g, textShadow: "0 1px 5px rgba(0,0,0,.7)" }}
                >
                  {t.n}
                </button>
              ))}
            </div>
            <div className="my-3.5 h-px bg-line" />
            <label className="mb-3.5 block">
              <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Caption</span>
              <Textarea rows={4} value={cap} onChange={(e) => setReelCaption(e.target.value)} />
            </label>
            <div className="mb-3.5 flex flex-wrap gap-2">
              <Btn variant="outline" size="sm" onClick={maraRewriteCaption}>
                <Icon name="spark" size={14} /> Rewrite with Voom
              </Btn>
              <Btn variant="outline" size="sm" onClick={() => toast("12 hashtags added from your top posts")}>
                <Icon name="plus" size={14} /> Suggest hashtags
              </Btn>
              <Btn variant="outline" size="sm" onClick={() => toast('Trending audio attached: "sunset drive"')}>
                <Icon name="music" size={14} /> Pick audio
              </Btn>
            </div>
            <div className="flex gap-2.5">
              <label className="mb-0 block flex-1">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Date</span>
                <input type="date" value={reelDate} onChange={(e) => setReelDate(e.target.value)} className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]" />
              </label>
              <label className="mb-0 block flex-1">
                <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">Time</span>
                <input
                  type="time"
                  value={reelTime}
                  onChange={(e) => setReelTime(e.target.value)}
                  className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px]"
                />
              </label>
            </div>
            <Card className="mt-3.5 border-brand bg-[var(--brand-soft)] p-3.5">
              <div className="flex flex-wrap items-center justify-between gap-2.5">
                <div className="flex items-start gap-2.5">
                  <span className="mt-0.5 h-2.5 w-2.5 flex-none rounded-full voom-grad" />
                  <div>
                    <div className="flex flex-wrap items-center gap-1.5">
                      <b className="text-[13.5px]">Best time: {pack.slot}</b>
                      <ExTag />
                    </div>
                    <p className="mt-0.5 text-[12.5px] text-text-2">
                      In this demo dataset the last 6 evening Reels averaged 41K views against 12K in the morning — {pack.slotWhy}.
                    </p>
                  </div>
                </div>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={() => {
                    setReelTime("19:10");
                    toast("Slot set to " + pack.slot);
                  }}
                >
                  Use it
                </Btn>
              </div>
            </Card>
            <Btn variant="primary" size="lg" block className="mt-3.5" onClick={handleSchedule}>
              <Icon name="clock" size={16} /> Schedule Reel for {labelDate(reelDate)}
            </Btn>
          </Card>

          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="font-display text-lg font-semibold">Queue</h2>
              <span className="text-[12.5px] text-text-3">{reelQueue.length} Reels</span>
            </div>
            {reelQueue.map((r, i) => (
              <div key={i} className="mb-2.5 flex items-center gap-3 rounded-2xl border border-line p-3 transition hover:border-line-2">
                <div className="h-[62px] w-[46px] flex-none rounded-[9px]" style={{ background: r.g }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.8px] font-semibold">{r.t}</div>
                  <div className="mt-0.5 text-xs text-text-3">
                    {r.when}
                    {r.views !== "—" ? ` · ${r.views} views` : ""}
                  </div>
                  <div className="mt-1.5 flex items-center gap-1.5">
                    <Tag tone={r.t2}>{r.st}</Tag>
                    {r.st !== "Live" && (
                      <button className="text-xs font-semibold text-brand" onClick={() => reelChangeTime(i)}>
                        Change time
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex gap-1">
                  {r.st === "Draft" && (
                    <Btn variant="primary" size="sm" onClick={() => reelSchedule(i)}>
                      Schedule
                    </Btn>
                  )}
                  <IconBtn onClick={() => reelDelete(i)}>
                    <Icon name="trash" />
                  </IconBtn>
                </div>
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

function labelDate(value: string) {
  const date = new Date(`${value}T00:00`);
  if (Number.isNaN(date.getTime())) return "the chosen date";
  return new Intl.DateTimeFormat("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric" }).format(date);
}
