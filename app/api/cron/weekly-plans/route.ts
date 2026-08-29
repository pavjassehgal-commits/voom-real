import { runWeeklyPlanAutomation } from "@/lib/voom/weekly-automation";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ error: "Weekly automation is not configured." }, { status: 503 });
  if (request.headers.get("authorization") !== `Bearer ${secret}`) return Response.json({ error: "Unauthorized." }, { status: 401 });
  try {
    return Response.json(await runWeeklyPlanAutomation(), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Weekly automation could not complete safely." }, { status: 503 });
  }
}
