/**
 * Theme: the ONE hydration-safe definition of the workspace theme.
 *
 * The bug this replaces: the client store read `localStorage` *during render*
 * (`initialState()`), so a returning dark-theme user got
 *
 *   server HTML  → light markup,
 *   first client render → dark markup,
 *
 * which made the toggle's icon and accessible label differ during hydration.
 *
 * The rules now:
 *   1. `initialTheme()` is the theme for the server render AND for the first
 *      client render. It never touches browser state, so they always agree.
 *   2. The persisted value is adopted after hydration (`readStoredTheme`, called
 *      from a mount effect in the store), then kept in `localStorage`.
 *   3. `THEME_INIT_SCRIPT` runs before the first paint in the browser (see
 *      `app/layout.tsx`) and moves the already-known theme onto the document
 *      element, so a returning dark-theme user never sees a light flash even
 *      though the React state starts at the default.
 */
export type ThemeValue = "light" | "dark";

/** Persisted key — unchanged, so existing users keep their choice. */
export const THEME_STORAGE_KEY = "voom-theme";

/** Voom 2.0 workspace default: warm light. Dark is opt-in via the toggle. */
export const DEFAULT_THEME: ThemeValue = "light";

export function isThemeValue(value: unknown): value is ThemeValue {
  return value === "light" || value === "dark";
}

/**
 * The theme of the server render and of the first client render.
 * Deliberately constant: any browser read here would re-introduce a hydration
 * mismatch for users with a persisted theme.
 */
export function initialTheme(): ThemeValue {
  return DEFAULT_THEME;
}

/**
 * The persisted theme, read after hydration. Browser-only and defensive: a
 * storage that throws (private mode, disabled cookies) falls back to the
 * default instead of breaking the shell.
 */
export function readStoredTheme(storage: Pick<Storage, "getItem"> | null | undefined): ThemeValue {
  try {
    const stored = storage?.getItem(THEME_STORAGE_KEY) ?? null;
    return isThemeValue(stored) ? stored : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/** Broadcast when the persisted theme changes (this tab). */
export const THEME_EVENT = "voom:theme-changed";

/**
 * The authoritative theme for the client. Read through `useSyncExternalStore`
 * so React uses the shared default while hydrating and switches to the stored
 * value immediately after — the reason the current theme is never part of the
 * render-time state that has to match the server.
 */
export function themeSnapshot(): ThemeValue {
  return readStoredTheme(typeof window === "undefined" ? null : window.localStorage);
}

/** Subscribes to theme changes: this tab's toggle, and other tabs' writes. */
export function subscribeToTheme(onStoreChange: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener(THEME_EVENT, onStoreChange);
  window.addEventListener("storage", onStoreChange);
  return () => {
    window.removeEventListener(THEME_EVENT, onStoreChange);
    window.removeEventListener("storage", onStoreChange);
  };
}

/** Persists a chosen theme and notifies subscribers. */
export function persistTheme(theme: ThemeValue): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  } catch {
    // Storage unavailable (private mode): the theme still applies for this page.
  }
  window.dispatchEvent(new Event(THEME_EVENT));
}

/**
 * Writes the authoritative theme onto `<html>`. Same value the pre-paint script
 * used, so this is a no-op during hydration and never downgrades a returning
 * dark user to light for a frame.
 */
export function applyThemeToDocument(theme: ThemeValue): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
}

/** Accessible toggle label — preserved from the shipped toggle. */
export function themeToggleLabel(theme: ThemeValue): string {
  return `Switch to ${theme === "dark" ? "light" : "dark"} mode`;
}

/** Toggle icon — preserved from the shipped toggle. */
export function themeToggleIcon(theme: ThemeValue): "sun" | "moon" {
  return theme === "dark" ? "sun" : "moon";
}

/**
 * Pre-paint theme bootstrap. Inline (no request, no dependency) and tiny on
 * purpose: it resolves the same default as `initialTheme()`, then applies a
 * persisted choice onto `<html data-theme>` before anything is painted.
 */
export const THEME_INIT_SCRIPT = `(function(){var t="light";try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="dark"||s==="light")t=s;}catch(e){}document.documentElement.setAttribute("data-theme",t);})();`;
