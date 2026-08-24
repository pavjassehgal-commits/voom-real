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
 * Resolves the app's public site URL for building absolute links (e.g. email
 * redirects), in priority order: an explicit NEXT_PUBLIC_SITE_URL, then
 * NEXT_PUBLIC_VERCEL_URL in production, then the current request's Origin
 * header, then localhost as the final development fallback.
 */
export function resolveSiteUrl(requestOrigin: string | null): URL {
  const vercelUrl =
    process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_VERCEL_URL
      ? `https://${process.env.NEXT_PUBLIC_VERCEL_URL}`
      : undefined;

  const candidates = [
    process.env.NEXT_PUBLIC_SITE_URL,
    vercelUrl,
    requestOrigin,
    "http://localhost:3000",
  ];

  for (const candidate of candidates) {
    const url = parseValidUrl(candidate);
    if (url) return url;
  }

  return new URL("http://localhost:3000");
}
