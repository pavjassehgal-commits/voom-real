"use client";

import { useVoomState } from "@/lib/voom/store";
import { nfc } from "@/lib/voom/demoData";

export function Donut() {
  const { adAlloc, adTotal } = useVoomState();
  const R = 62;
  const C = 2 * Math.PI * R;

  const segments = adAlloc.reduce<{ a: (typeof adAlloc)[number]; len: number; offset: number }[]>((acc, a) => {
    const len = C * (a.pct / 100);
    const offset = acc.length ? acc[acc.length - 1].offset + acc[acc.length - 1].len : 0;
    return [...acc, { a, len, offset }];
  }, []);

  return (
    <svg viewBox="0 0 150 150" className="h-[150px] w-[150px] flex-none">
      <circle cx="75" cy="75" r="72" fill="rgba(255,255,255,.13)" />
      <circle cx="75" cy="75" r={R} fill="none" stroke="rgba(255,255,255,.22)" strokeWidth="19" />
      {segments.map(({ a, len, offset }) => (
        <circle
          key={a.n}
          cx="75"
          cy="75"
          r={R}
          fill="none"
          stroke={a.c}
          strokeWidth="19"
          strokeDasharray={`${len - 2.5} ${C - len + 2.5}`}
          strokeDashoffset={-offset}
          transform="rotate(-90 75 75)"
          strokeLinecap="butt"
        >
          <title>
            {a.n} — {a.pct}%
          </title>
        </circle>
      ))}
      <text x="75" y="70" textAnchor="middle" fontSize="21" fontWeight="700" fill="currentColor" fontFamily="var(--font-display)">
        AED {nfc(adTotal)}
      </text>
      <text x="75" y="88" textAnchor="middle" fontSize="10" fill="currentColor" opacity=".72">
        14-day budget
      </text>
    </svg>
  );
}
