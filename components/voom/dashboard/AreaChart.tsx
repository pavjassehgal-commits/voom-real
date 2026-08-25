"use client";

import { SERIES } from "@/lib/voom/demoData";

function smoothPath(points: [number, number][]): string {
  return points
    .map((c, i) => {
      if (i === 0) return `M${c[0]},${c[1]}`;
      const pr = points[i - 1];
      const cx = (pr[0] + c[0]) / 2;
      return `C${cx},${pr[1]} ${cx},${c[1]} ${c[0]},${c[1]}`;
    })
    .join(" ");
}

export function AreaChart() {
  const W = 560;
  const H = 200;
  const mx = Math.max(...SERIES.reach) * 1.15;
  const pts = (a: number[]): [number, number][] => a.map((v, i) => [i * (W / (a.length - 1)), H - (v / mx) * H]);
  const path = (a: number[]) => smoothPath(pts(a));
  const area = (a: number[]) => `${path(a)} L${W},${H} L0,${H} Z`;

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-full w-full overflow-visible">
      <defs>
        <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e8481f" stopOpacity=".34" />
          <stop offset="100%" stopColor="#e8481f" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="g2" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#0f6f68" stopOpacity=".26" />
          <stop offset="100%" stopColor="#0f6f68" stopOpacity="0" />
        </linearGradient>
      </defs>
      {[0, 0.25, 0.5, 0.75, 1].map((f) => (
        <line key={f} x1="0" y1={H * f} x2={W} y2={H * f} stroke="var(--line)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
      ))}
      <path d={area(SERIES.reach)} fill="url(#g1)" />
      <path d={area(SERIES.eng)} fill="url(#g2)" />
      <path d={path(SERIES.reach)} fill="none" stroke="#e8481f" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      <path d={path(SERIES.eng)} fill="none" stroke="#0f6f68" strokeWidth="2.5" vectorEffect="non-scaling-stroke" strokeLinecap="round" />
      {pts(SERIES.reach).map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r="3.5" fill="var(--surface)" stroke="#e8481f" strokeWidth="2.5" vectorEffect="non-scaling-stroke">
          <title>
            {SERIES.labels[i]} · {SERIES.reach[i]}K reach
          </title>
        </circle>
      ))}
    </svg>
  );
}
