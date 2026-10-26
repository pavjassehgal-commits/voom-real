import "server-only";
import { json, LINKEDIN_MESSAGES, oneShotInput, sameOrigin, UUID } from "./http.ts";

export async function handleLinkedInOneShot(request: Request, draftId: string, deps: {
  enabled: boolean;
  owner: () => Promise<string | null>;
  publish: (ownerId: string, draftId: string, input: unknown) => Promise<string>;
}) {
  if (!deps.enabled) return json({ error: "Not found." }, 404);
  if (request.method !== "POST") return json({ error: "Use explicit posting confirmation." }, 405);
  const ownerId = await deps.owner();
  if (!ownerId) return json({ error: "Please log in again." }, 401);
  if (!sameOrigin(request)) return json({ error: "That request was not valid." }, 403);
  const input = oneShotInput.safeParse(await request.json().catch(() => null));
  if (!UUID.safeParse(draftId).success || !input.success) return json({ error: "Confirm this exact approved post and its public visibility." }, 400);
  try {
    const outcome = await deps.publish(ownerId, draftId, input.data);
    if (outcome === "published") return json({ outcome, message: "LinkedIn confirmed this one public post. No other jobs were processed." });
    const manualWait = outcome === "rate_limited" || outcome === "unavailable"
      ? "This attempt could not complete. Refresh for its status and retry wait, then explicitly confirm again if eligible. No automatic retry was started."
      : null;
    return json({ outcome, error: manualWait ?? LINKEDIN_MESSAGES[outcome] ?? "This post was not submitted. Refresh and review its approval, account and send time." }, 409);
  } catch {
    return json({ error: "The result could not be confirmed. Refresh and check LinkedIn before taking further action; do not blindly retry." }, 503);
  }
}
