import "server-only";

import { createResendApiClient, type ResendApiClient, type ResendClientOptions } from "./core";
import { requireResendConfig } from "./config";

export function createResendClient(options?: ResendClientOptions): ResendApiClient {
  return createResendApiClient(requireResendConfig(), options);
}
