import { createAdminClient } from "@/utils/supabase/admin";
import { unsubscribeHandler } from "@/lib/email/unsubscribe-handler";

export const POST = unsubscribeHandler(createAdminClient);
export async function GET(request: Request) {
  const target = new URL("/unsubscribe", request.url);
  target.searchParams.set("token", new URL(request.url).searchParams.get("token") ?? "");
  return new Response(null, { status: 303, headers: { Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
