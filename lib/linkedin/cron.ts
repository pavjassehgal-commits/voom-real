import "server-only";
import { bearerMatches } from "../../utils/bearer-auth.ts";
import { json } from "./http.ts";

// Vercel supplies the existing Production CRON_SECRET as a bearer token.
// Reject Preview/local invocations before creating an admin client or claiming work.
export async function handleLinkedInCron(request: Request, deps: {
  environment: string | undefined;
  secret: string | undefined;
  run: () => Promise<unknown>;
}) {
  if (deps.environment !== "production") return json({ error: "LinkedIn scheduling is disabled outside Production." }, 503);
  if (!deps.secret) return json({ error: "Worker is not configured." }, 503);
  if (!bearerMatches(request, deps.secret)) return json({ error: "Unauthorized." }, 401);
  try { return json(await deps.run()); }
  catch { return json({ error: "LinkedIn publishing could not complete safely." }, 503); }
}
