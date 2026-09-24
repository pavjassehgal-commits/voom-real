/**
 * Server-safe class-name composition for shared server-rendered surfaces.
 *
 * Keep this helper free of React client directives so server components can
 * compose class names without crossing a client-module boundary.
 */
export function cx(...parts: (string | false | null | undefined)[]) {
  return parts.filter(Boolean).join(" ");
}
