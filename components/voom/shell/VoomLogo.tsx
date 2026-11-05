import { VOOM_APP_ICON } from "@/lib/voom/brand-assets";

/** Use the actual official icon, not a separately reconstructed SVG mark.
 * The opaque white source is intentional and identical in light/dark themes. */
export function VoomLogoMark({ size = 32, className, idPrefix }: { size?: number; className?: string; idPrefix?: string }) {
  return (
    // Preserve the exact static brand bytes without optimizer/theme variants.
    // eslint-disable-next-line @next/next/no-img-element
    <img src={VOOM_APP_ICON} alt="" aria-hidden="true" width={size} height={size}
      id={idPrefix} className={className} style={{ flex: "none" }} loading="lazy" decoding="async" />
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
