/**
 * The only accepted target for the one-off Wikidata staging collection:
 * https://qcdpegwjofrqnfudyrqq.supabase.co (voom-staging) with a service key
 * present. Checks presence only; the key value is never read further or printed.
 */
export const STAGING_PROJECT_ID = "qcdpegwjofrqnfudyrqq";

export function verifyStagingTarget(env) {
  const raw = env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  if (!raw) return { ok: false, code: "missing_supabase_url" };
  let url;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, code: "invalid_supabase_url" };
  }
  if (url.protocol !== "https:" || url.hostname !== `${STAGING_PROJECT_ID}.supabase.co` || url.port || (url.pathname !== "/" && url.pathname !== "")) {
    return { ok: false, code: "wrong_project" };
  }
  if (!env.SUPABASE_SECRET_KEY?.trim()) return { ok: false, code: "missing_service_key" };
  return { ok: true, projectId: STAGING_PROJECT_ID };
}
