import Image from "next/image";
import { cx } from "@/lib/voom/cx";

/**
 * MARA's mark: Gurnoor's glossy gradient ribbon (public/redesign/mara-mark.webp,
 * 480×266, from his own site, 2026-11-04). It replaces the old conic "orb" in
 * our screens, which carried a gradient the redesign no longer uses. Sized by
 * height; the width follows the image's own ratio.
 */
export function MaraMark({ height = 22, className }: { height?: number; className?: string }) {
  const width = Math.round(height * (480 / 266));
  return (
    <Image
      src="/redesign/mara-mark.webp"
      alt=""
      aria-hidden="true"
      width={480}
      height={266}
      unoptimized
      draggable={false}
      className={cx("shrink-0 select-none object-contain", className)}
      style={{ width, height }}
    />
  );
}
