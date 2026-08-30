import "server-only";

import { createClickSendApiClient, type ClickSendApiClient, type ClickSendClientOptions } from "./core";
import { requireClickSendConfig } from "./config";

export function createClickSendClient(options?: ClickSendClientOptions): ClickSendApiClient {
  return createClickSendApiClient(requireClickSendConfig(), options);
}
