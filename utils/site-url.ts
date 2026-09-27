function parseValidUrl(candidate: string | undefined | null): URL | undefined {
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol === "http:" || url.protocol === "https:") {
      return url;
    }
  } catch {
    // not a valid absolute URL — try the next candidate
  }
  return undefined;
}

/**
 * Resolves the app's public site URL for building absolute links (email
 * confirmation redirects, unsubscribe links), in priority order:
 *   1. NEXT_PUBLIC_SITE_URL (required in production — e.g. https://voom.today)
 *   2. NEXT_PUBLIC_VERCEL_URL in production (per-deployment fallback)
 *   3. the request's Origin header — DEVELOPMENT ONLY, because in production a
 *      client-controlled header must never decide where auth emails point
 *   4. localhost as the final development fallback.
 */
export function resolveSiteUrl(requestOrigin: string | null): URL {
  const production = process.env.NODE_ENV === "production";
  const vercelUrl =
    production && process.env.NEXT_PUBLIC_VERCEL_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
      : undefined;

  if (production && !parseValidUrl(process.env.NEXT_PUBLIC_SITE_URL)) {
    console.error("[site-url] NEXT_PUBLIC_SITE_URL is not set; links will use the deployment URL.");
  }

  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    vercelUrl,
    production ? null : requestOrigin,
    "http://localhost:3000",
  ];

  for (const candidate of candidates) {
    const url = parseValidUrl(candidate);
    if (url) return url;
  }

  return new URL("http://localhost:3000");
}
