/** Auth redirects never derive from Host, Origin, forwarded headers or next. */
export function authSiteUrl(): URL {
  const value = process.env.NEXT_PUBLIC_SITE_URL || "https://voom-real.vercel.app";
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/" ||
      (url.protocol !== "https:" && !(process.env.NODE_ENV !== "production" && url.protocol === "http:"))) {
    throw new Error("invalid_auth_site_url");
  }
  return url;
}
export function authCallbackUrl(kind: "signup" | "recovery"): string {
  return new URL(kind === "signup" ? "/auth/callback" : "/auth/recovery", authSiteUrl()).toString();
}
