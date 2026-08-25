"use client";

import { useEffect, useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "../icons";
import { Orb } from "../ui/primitives";

const ITEMS = [
  "Reading your description",
  "Learning your brand voice",
  "Reviewing sample competitor posts",
  "Choosing your best posting times",
  "Drafting your first 14 days",
];

export function AnalyzingScreen({ onDone }: { onDone: () => void }) {
  const [done, setDone] = useState<Set<number>>(new Set());
  const { toast } = useVoomActions();

  useEffect(() => {
    const timers = ITEMS.map((_, i) =>
      setTimeout(() => setDone((prev) => new Set(prev).add(i)), 500 + i * 750),
    );
    const finish = setTimeout(
      () => {
        onDone();
        toast("Your workspace is ready — 14 days of content drafted", "ok", true);
      },
      500 + ITEMS.length * 750 + 600,
    );
    return () => {
      timers.forEach(clearTimeout);
      clearTimeout(finish);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="fixed inset-0 z-[100] grid place-items-center bg-[rgba(7,9,18,.55)] p-5 backdrop-blur-[5px]">
      <div className="w-full max-w-[420px] rounded-[22px] border border-line bg-surface p-9 text-center shadow-[var(--shadow-lg)]">
        <div className="grid place-items-center">
          <Orb size="lg" />
        </div>
        <h2 className="mt-4 font-display text-lg font-semibold">MARA is studying your brand</h2>
        <p className="mt-1.5 text-[13.5px] text-text-2">This takes about ten seconds.</p>
        <div className="mx-auto mt-6.5 flex max-w-[340px] flex-col gap-3 text-left">
          {ITEMS.map((t, i) => (
            <div key={t} className={`flex items-center gap-2.5 text-sm transition ${done.has(i) ? "text-text" : "text-text-3"}`}>
              <span
                className={`grid h-[22px] w-[22px] flex-none place-items-center rounded-full border-2 transition ${done.has(i) ? "border-green bg-green" : "border-line-2"}`}
              >
                {done.has(i) && <Icon name="check" size={12} className="text-white" />}
              </span>
              {t}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
