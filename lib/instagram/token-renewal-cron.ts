import "server-only";

import { bearerMatches } from "../../utils/bearer-auth.ts";
import type { RenewalOutcome } from "./token-renewal.ts";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * HTTP gate for the token-renewal worker. Preview deployments share the
 * Production database and may carry CRON_SECRET, so anything but Vercel
 * Production is refused before the secret is checked, the admin client is
 * created or a token is claimed. Staging validation calls
 * renewInstagramTokens() directly instead. `run` resolves null when Instagram
 * is not configured.
 */
export async function handleInstagramTokenRenewalCron(request: Request, deps: {
  environment: string | undefined;
  secret: string | undefined;
  run: () => Promise<RenewalOutcome | null>;
}): Promise<Response> {
  if (deps.environment !== "production") {
    return Response.json({ error: "Instagram token renewal is disabled outside Production." }, { status: 503, headers: NO_STORE });
  }
  const secret = deps.secret;
  if (!secret) return Response.json({ error: "Instagram token renewal is not configured." }, { status: 503, headers: NO_STORE });
  if (!bearerMatches(request, secret)) return Response.json({ error: "Unauthorized." }, { status: 401, headers: NO_STORE });
  try {
    const result = await deps.run();
    if (!result) return Response.json({ error: "Instagram token renewal is not configured." }, { status: 503, headers: NO_STORE });
    return Response.json(result, { headers: NO_STORE });
  } catch {
    return Response.json({ error: "Instagram token renewal could not complete safely." }, { status: 503, headers: NO_STORE });
  }
}
