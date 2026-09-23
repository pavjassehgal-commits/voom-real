import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { authBoundary, NON_SESSION_APIS, unsafeBrowserMutation } from "@/lib/auth/boundaries";
import { isVerifiedUser, safeNext } from "@/lib/auth/policy";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;

export async function updateSession(request: NextRequest) {
  const path = request.nextUrl.pathname;
  if (NON_SESSION_APIS.has(path.replace(/\/$/, ""))) return NextResponse.next({ request });
  let supabaseResponse = NextResponse.next({ request });
  const supabase = createServerClient(supabaseUrl!, supabaseKey!, {
    cookies: {
      getAll() { return request.cookies.getAll(); },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        const previous = supabaseResponse;
        supabaseResponse = NextResponse.next({ request });
        previous.cookies.getAll().forEach(cookie => supabaseResponse.cookies.set(cookie));
        cookiesToSet.forEach(({ name, value, options }) => supabaseResponse.cookies.set(name, value, options));
        Object.entries(headers).forEach(([key, value]) => supabaseResponse.headers.set(key, value));
      },
    },
  });
  // Preserve SDK refresh behavior. Claims alone NEVER grant product access.
  await supabase.auth.getClaims();
  const boundary = authBoundary(path);
  if (!boundary) return supabaseResponse;
  const { data, error } = await supabase.auth.getUser();
  const user = error ? null : data.user;
  let response = supabaseResponse;
  if (boundary === "api" && unsafeBrowserMutation(request.method, request.headers.get("origin"), request.headers.get("host") ?? request.nextUrl.host, request.headers.get("sec-fetch-site"))) {
    response = NextResponse.json({ error: "invalid_origin" }, { status: 403 });
  } else if (!isVerifiedUser(user)) {
    if (boundary === "api") {
      response = NextResponse.json({ error: user ? "email_verification_required" : "authentication_required" }, { status: user ? 403 : 401 });
    } else {
      const url = request.nextUrl.clone();
      url.pathname = user ? "/verify-email" : "/login";
      url.search = "";
      if (!user) url.searchParams.set("next", safeNext(path));
      response = NextResponse.redirect(url);
    }
  }
  if (response !== supabaseResponse) {
    supabaseResponse.cookies.getAll().forEach(cookie => response.cookies.set(cookie));
  }
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
