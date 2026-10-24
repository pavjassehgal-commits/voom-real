/**
 * Optional, centralised haptic feedback for direct user actions.
 *
 * Uses only the standard Vibration API (`navigator.vibrate`). Where it is
 * missing — iOS Safari and every desktop browser except some Android/Chromium
 * builds — every call is a silent no-op: no fallback, no audio tricks.
 *
 * Trust boundary. Every pulse needs a gesture token taken SYNCHRONOUSLY in
 * the handler of the event that caused it (`beginHapticGesture()`), and the
 * token is only issued when:
 * - the event being dispatched right now is trusted (`isTrusted`) — a script-
 *   or timer-generated click gets no token, even while a real gesture's user
 *   activation is still active; and
 * - the browser positively reports active user activation
 *   (`navigator.userActivation.isActive === true`); missing metadata fails
 *   closed.
 * `haptic(kind, token)` then fires only if that same gesture is still the most
 * recent real input (an unrelated later tap invalidates it), it is under 4s
 * old, activation is still active, the owner has not turned haptics off, and
 * reduced motion is not preferred. So a delayed save result can vibrate for
 * the tap that started it, but never by borrowing a different gesture, and
 * page loads, notifications and background events never can.
 */
export type HapticKind = "light" | "success" | "warning" | "error";

/** Opaque proof that a pulse answers one specific, genuine user gesture. */
export type HapticGesture = { readonly seq: number; readonly at: number } | null;

const PATTERNS: Record<HapticKind, number | number[]> = {
  light: 10,
  success: 20,
  warning: [12, 60, 12],
  error: [16, 60, 16],
};

/** How long a gesture may still be answered (inside the browser's ~5s activation window). */
const GESTURE_TTL_MS = 4000;

export const HAPTICS_STORAGE_KEY = "voom-haptics";
export const MOTION_STORAGE_KEY = "voom-motion";

type VibratingNavigator = Navigator & {
  vibrate?: (pattern: number | number[]) => boolean;
  userActivation?: { isActive?: boolean };
};

/* The event being dispatched right now, and a counter of genuine gestures. */
let dispatching: Event | null = null;
let gestureSeq = 0;
let installed = false;
const DISPATCH_TYPES = ["pointerdown", "pointerup", "touchend", "mousedown", "mouseup", "click", "keydown", "keyup", "change", "input", "submit"];
const GESTURE_TYPES = new Set(["pointerdown", "touchend", "mousedown", "click", "keydown"]);

function installDispatchTracking() {
  if (installed || typeof window === "undefined" || typeof window.addEventListener !== "function") return;
  installed = true;
  const begin = (event: Event) => {
    dispatching = event;
    if (event.isTrusted && GESTURE_TYPES.has(event.type)) gestureSeq += 1;
    // Cleared after this task even if a handler stops propagation.
    setTimeout(() => { if (dispatching === event) dispatching = null; }, 0);
  };
  const end = (event: Event) => { if (dispatching === event) dispatching = null; };
  for (const type of DISPATCH_TYPES) {
    window.addEventListener(type, begin, { capture: true });
    window.addEventListener(type, end);
  }
}
installDispatchTracking();

function now() {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function activationActive(): boolean {
  if (typeof navigator === "undefined") return false;
  return (navigator as VibratingNavigator).userActivation?.isActive === true;
}

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

/**
 * Call synchronously at the top of a user-event handler (before any await).
 * Pass the event when you have it; otherwise the event currently being
 * dispatched is used. Returns null — no haptics — unless that event is
 * trusted and user activation is positively active.
 */
export function beginHapticGesture(event?: Event | { nativeEvent: Event } | null): HapticGesture {
  installDispatchTracking();
  const native = event ? ("nativeEvent" in event ? event.nativeEvent : event) : dispatching;
  if (!native || native.isTrusted !== true) return null;
  if (!activationActive()) return null;
  return { seq: gestureSeq, at: now() };
}

/** Fire a short pulse for the gesture captured by beginHapticGesture(). */
export function haptic(kind: HapticKind, gesture: HapticGesture): void {
  if (!gesture || typeof window === "undefined" || typeof navigator === "undefined") return;
  const nav = navigator as VibratingNavigator;
  if (typeof nav.vibrate !== "function") return;
  if (gesture.seq !== gestureSeq) return; // a newer, unrelated gesture happened
  if (now() - gesture.at > GESTURE_TTL_MS) return;
  if (!activationActive()) return; // no positive evidence: fail closed
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
