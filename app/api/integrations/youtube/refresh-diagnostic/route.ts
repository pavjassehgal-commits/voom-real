import { runOwnerRefreshDiagnostic } from "@/lib/youtube/refresh-diagnostic-server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Temporary POST-only route; there is no worker/admin-token entry point.
export async function POST(request: Request) {
  return runOwnerRefreshDiagnostic(request);
}
