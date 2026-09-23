import "server-only";
import { cookies } from "next/headers";
import { RECOVERY_COOKIE } from "./recovery";

/** Expire local credentials even when Supabase's revocation endpoint is unavailable. */
export async function clearLocalAuthCookies() {
  const store = await cookies();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  if (url) {
    const prefix = `sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
    for (const cookie of store.getAll()) {
      if (cookie.name === prefix || cookie.name.startsWith(`${prefix}.`) || cookie.name.startsWith(`${prefix}-`)) store.delete(cookie.name);
    }
  }
  store.delete(RECOVERY_COOKIE);
}
