/**
 * Optional, centralised haptic feedback for direct user actions.
 *
 * Uses only the standard Vibration API (`navigator.vibrate`). Where it is
 * missing — iOS Safari and every desktop browser except some Android/Chromium
 * builds — every call is a silent no-op: no fallback, no audio tricks.
 *
 * A pulse fires only when ALL of these hold:
 * - the API exists;
 * - the browser positively reports a CURRENTLY active user gesture
 *   (`navigator.userActivation.isActive === true`). Missing activation
 *   metadata fails closed, so page loads, passive notifications, timers,
 *   background events and late save results can never vibrate, even if a
 *   caller mistakenly asks;
 * - the owner has not turned haptics off (Settings → Appearance);
 * - the owner has not asked for reduced motion (system or in-app).
 */
export type HapticKind = "light" | "success" | "warning" | "error";

const PATTERNS: Record<HapticKind, number | number[]> = {
  light: 10,
  success: 20,
  warning: [12, 60, 12],
  error: [16, 60, 16],
};

export const HAPTICS_STORAGE_KEY = "voom-haptics";
export const MOTION_STORAGE_KEY = "voom-motion";

type VibratingNavigator = Navigator & {
  vibrate?: (pattern: number | number[]) => boolean;
  userActivation?: { isActive: boolean };
};

function storedPreference(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** True when this browser can vibrate at all (for showing the Settings note). */
export function hapticsSupported(): boolean {
  return typeof navigator !== "undefined" && typeof (navigator as VibratingNavigator).vibrate === "function";
}

/** The owner's saved choice; on by default. */
export function hapticsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  return storedPreference(HAPTICS_STORAGE_KEY) !== "off";
}

export function reducedMotionPreferred(): boolean {
  if (typeof window === "undefined") return false;
  if (storedPreference(MOTION_STORAGE_KEY) === "reduce") return true;
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Fire a short pulse in direct response to the owner's own action. */
export function haptic(kind: HapticKind): void {
  if (typeof window === "undefined" || typeof navigator === "undefined") return;
  const nav = navigator as VibratingNavigator;
  if (typeof nav.vibrate !== "function") return;
  if (nav.userActivation?.isActive !== true) return; // no positive evidence: fail closed
  if (!hapticsEnabled() || reducedMotionPreferred()) return;
  try {
    nav.vibrate(PATTERNS[kind]);
  } catch {
    /* Some embedded browsers throw instead of returning false — ignore. */
  }
}

/** Mirror the in-app motion choice onto <html data-motion> so CSS can honour it. */
export function applyMotionPreference(): void {
  if (typeof document === "undefined") return;
  if (storedPreference(MOTION_STORAGE_KEY) === "reduce") document.documentElement.setAttribute("data-motion", "reduce");
  else document.documentElement.removeAttribute("data-motion");
}

export const HAPTIC_PATTERNS = PATTERNS;
