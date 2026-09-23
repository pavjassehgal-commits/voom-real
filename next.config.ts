import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  async headers() {
    return ["/auth/:path*", "/login", "/signup", "/verify-email/:path*", "/forgot-password", "/reset-password/:path*"].map(source => ({
      source,
      headers: [
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "private, no-store, max-age=0" },
        { key: "X-Content-Type-Options", value: "nosniff" },
      ],
    }));
  },
};

export default nextConfig;
