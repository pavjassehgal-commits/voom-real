/**
 * Voom ribbon mark + wordmark from the redesign reference (Figma "15 — Today").
 * Vector reconstruction of the exported mark; server-safe (no client hooks).
 * Pass a distinct `idPrefix` when two marks share a page and one may be hidden:
 * gradients defined inside a `display: none` element do not paint elsewhere.
 */
export function VoomLogoMark({ size = 32, className, idPrefix = "voom-mark" }: { size?: number; className?: string; idPrefix?: string }) {
  return (
    <svg viewBox="0 0 48 40" width={size} height={(size * 40) / 48} aria-hidden="true" className={className} style={{ flex: "none" }}>
      <defs>
        <linearGradient id={`${idPrefix}-a`} x1="0" y1="0" x2="0.35" y2="1">
          <stop offset="0" stopColor="#f3b4f2" />
          <stop offset="0.35" stopColor="#b56cf6" />
          <stop offset="1" stopColor="#3b2aa6" />
        </linearGradient>
        <linearGradient id={`${idPrefix}-b`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stopColor="#2f2496" />
          <stop offset="0.55" stopColor="#6d3fe6" />
          <stop offset="1" stopColor="#c062f2" />
        </linearGradient>
        <linearGradient id={`${idPrefix}-c`} x1="0" y1="0" x2="1" y2="0.3">
          <stop offset="0" stopColor="#f6c3f4" />
          <stop offset="1" stopColor="#c77df5" />
        </linearGradient>
      </defs>
      <path d="M4 10.5 C 6.5 6, 13.5 4.6, 19 7.2 C 15 8.4, 12.6 10.6, 12.8 14.2 L 17.6 30.8 C 18.4 33.6, 16.6 35.6, 14.2 34.2 C 9.4 30.6, 4.6 20.6, 4 10.5 Z" fill={`url(#${idPrefix}-a)`} />
      <path d="M14.2 34.2 C 17.4 36.4, 22.2 35.6, 25.4 31.2 L 33.2 14.8 C 35.4 10.6, 39.8 7.4, 44.6 6.6 C 41.6 9.6, 40 12.2, 38.8 15.4 L 31 31.6 C 28.4 37, 20 38.6, 14.2 34.2 Z" fill={`url(#${idPrefix}-b)`} />
      <path d="M4 10.5 C 6.5 6, 13.5 4.6, 19 7.2 C 22.6 8.8, 26.6 9.2, 30.6 7.2 C 27.4 11.6, 22 12.4, 17.6 10.6 C 15.6 9.8, 13.6 10.8, 12.8 14.2 C 9.6 11.4, 6.6 10.2, 4 10.5 Z" fill={`url(#${idPrefix}-c)`} opacity="0.92" />
    </svg>
  );
}

export function VoomLogo({ size = 34, idPrefix }: { size?: number; idPrefix?: string }) {
  return (
    <span className="flex items-center gap-2.5">
      <VoomLogoMark size={size} idPrefix={idPrefix} />
      <span className="text-[22px] font-bold leading-none tracking-[-0.035em] text-text">voom</span>
    </span>
  );
}
