"use client";

import { useEffect } from "react";
import { applyMotionPreference, haptic } from "@/lib/voom/haptics";

/**
 * Browser-side motion wiring, mounted once in Providers:
 * - mirrors the saved in-app "Reduced motion" choice onto <html data-motion>;
 * - marks <html data-interacted> on the first pointer/key input, so selection
 *   animations never replay on page load;
 * - gives any control marked `data-haptic="light"` a light tap when the owner
 *   clicks it. One delegated listener; haptic() itself refuses to fire without
 *   a real user gesture, support or permission.
 */
export function MotionRuntime() {
  useEffect(() => {
    applyMotionPreference();
    function onClick(event: MouseEvent) {
      // Only genuine input: script-dispatched or timer-generated clicks never vibrate.
      if (!event.isTrusted) return;
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-haptic]") : null;
      if (!target || target.matches(":disabled, [aria-disabled='true']")) return;
      if (target.dataset.haptic === "light") haptic("light");
    }
    // Selection animations wait for the first real interaction (see globals.css).
    function markInteracted() { document.documentElement.setAttribute("data-interacted", ""); }
    document.addEventListener("click", onClick, { capture: true });
    document.addEventListener("pointerdown", markInteracted, { once: true, capture: true });
    document.addEventListener("keydown", markInteracted, { once: true, capture: true });
    return () => {
      document.removeEventListener("click", onClick, { capture: true });
      document.removeEventListener("pointerdown", markInteracted, { capture: true });
      document.removeEventListener("keydown", markInteracted, { capture: true });
    };
  }, []);
  return null;
}
