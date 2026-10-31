import { bearerMatches } from "@/utils/bearer-auth";

/** Shared, testable authorization boundary kept outside the Next.js route module. */
export function isAuthorizedEmailFlowCron(request: Request, secret = process.env.CRON_SECRET): boolean {
  return bearerMatches(request, secret);
}
