import "server-only";
import { createResendApiClient, type ResendApiClient, type ResendClientOptions } from "./core";

export type ResendDomainClient = Pick<ResendApiClient, "request">;

/** Never fall back to the sending key. Resend currently needs Full access for
 * domain reads/setup; staging MUST use an isolated provider account/team.
 * This application capability cannot send, rotate keys or delete domains. */
export function createResendDomainApiClient(
  env: Record<string, string | undefined> = process.env,
  options: ResendClientOptions = {},
): ResendDomainClient {
  const key = env.EMAIL_DOMAIN_API_KEY?.trim();
  if (!key || key === env.EMAIL_PROVIDER_API_KEY?.trim()) throw new Error("email_domain_credentials_required");
  const client = createResendApiClient({
    provider: "resend", apiKey: key, fromAddress: "", fromName: "",
    webhookSecret: "", apiBaseUrl: "https://api.resend.com",
  }, options);
  return {
    async request(method, path, body) {
      // No arbitrary paths, query injection, auth/header overrides or redirects.
      const readable = /^\/?domains(?:\/[a-zA-Z0-9-]{8,100}|\?limit=100(?:&after=[a-zA-Z0-9%-]+)?)?$/.test(path);
      const writable = path === "domains" || /^domains\/[a-zA-Z0-9-]{8,100}\/verify$/.test(path);
      if (method === "GET" ? !readable || body !== undefined : method !== "POST" || !writable || env.EMAIL_DOMAIN_SETUP_ENABLED !== "true") {
        throw new Error("email_domain_operation_denied");
      }
      return client.request(method, path, body, { redirect: "error" });
    },
  };
}
