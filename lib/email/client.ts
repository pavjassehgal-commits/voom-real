import "server-only";

import { createResendApiClient, type ResendApiClient, type ResendClientOptions } from "./core";
import { requireResendConfig } from "./config";
import { createAdminClient } from "@/utils/supabase/admin";
import { waitForEmailProviderSlot } from "./provider-throttle";

export function createResendClient(options?: ResendClientOptions): ResendApiClient {
  return createResendApiClient(requireResendConfig(), { ...options, beforeRequest: options?.beforeRequest ?? (() => waitForEmailProviderSlot(createAdminClient())) });
}
