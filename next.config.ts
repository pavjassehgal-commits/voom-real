import type { NextConfig } from "next";

/**
 * Baseline security headers for every response.
 *
 * The Content-Security-Policy is deliberately limited to directives that
 * cannot break rendering (framing, base URI, form targets, plugins). Script,
 * image and connect sources are not restricted here because the app renders
 * signed Supabase Storage URLs and provider CDN thumbnails; tighten them with
 * a nonce-based policy once those origins are fixed for production.
 */
const securityHeaders = [
  { key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "SAMEORIGIN" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
  {
    key: "Content-Security-Policy",
    value: "frame-ancestors 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; upgrade-insecure-requests",
  },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
