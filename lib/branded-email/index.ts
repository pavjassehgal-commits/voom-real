/**
 * Branded Email Engine v1 — public surface.
 *
 * Pure building blocks (no I/O, no server-only) are exported from here and
 * from the submodules directly; server-side loaders (`brand.ts`, `storage.ts`,
 * `sender`'s env reader) remain their own modules so the Node test suite never
 * drags `server-only` into a pure import.
 */

export * from "./assets";
export * from "./brand-profile";
export * from "./colors";
export * from "./derive";
export * from "./design";
export * from "./destinations";
export * from "./quality-guard";
export * from "./render";
export * from "./unsubscribe";
