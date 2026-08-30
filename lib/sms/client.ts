import "server-only";

import { createTwilioApiClient, type TwilioApiClient, type TwilioClientOptions } from "./core";
import { requireTwilioConfig } from "./config";

export function createTwilioClient(options?: TwilioClientOptions): TwilioApiClient {
  return createTwilioApiClient(requireTwilioConfig(), options);
}
