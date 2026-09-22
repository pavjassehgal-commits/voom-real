import "server-only";
import { cache } from "react";
import { createClient } from "@/utils/supabase/server";

/** Network-validated identity; never authorize with client metadata or JWT-only claims. */
export const getAuthUser = cache(async () => {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getUser();
  return error ? null : data.user;
});
