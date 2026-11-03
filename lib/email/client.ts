import "server-only";

import { createResendApiClient, type ResendApiClient, type ResendClientOptions } from "./core";
import { requireResendConfig } from "./config";
import { createAdminClient } from "@/utils/supabase/admin";
import { waitForEmailProviderSlot } from "./provider-throttle";
import { createResendDomainApiClient, type ResendDomainClient } from "./domain-client";

export function createResendClient(options?: ResendClientOptions): ResendApiClient {
  return createResendApiClient(requireResendConfig(), { ...options, beforeRequest: options?.beforeRequest ?? (() => waitForEmailProviderSlot(createAdminClient())) });
}

export function createResendDomainClient(options?: ResendClientOptions): ResendDomainClient {
  return createResendDomainApiClient(process.env, { ...options, beforeRequest: options?.beforeRequest ?? (() => waitForEmailProviderSlot(createAdminClient())) });
}
