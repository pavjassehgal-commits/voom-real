import { Buffer } from "node:buffer";
import { z } from "zod";

const CLICKSEND_API_BASE_URL = "https://rest.clicksend.com";
const CLICKSEND_SMS_SEND_PATH = "/v3/sms/send";
const DEFAULT_TIMEOUT_MS = 15_000;

const clickSendConfigSchema = z.object({
  username: z.string().trim().min(1),
  apiKey: z.string().trim().min(1),
});

const envShape = {
  username: "CLICKSEND_USERNAME",
  apiKey: "CLICKSEND_API_KEY",
} as const;

type EnvLike = Record<string, string | undefined>;

export interface ClickSendConfig {
  provider: "clicksend";
  username: string;
  apiKey: string;
  apiBaseUrl: string;
}

export interface ClickSendAvailability {
  provider: "clicksend";
  configured: boolean;
  missingEnv: string[];
}

export interface ClickSendClientOptions {
  fetch?: ProviderFetch;
  timeoutMs?: number;
}

export interface ClickSendApiClient {
  provider: "clicksend";
  config: ClickSendConfig;
  postJson(path: string, body: unknown, init?: Omit<RequestInit, "method" | "body">): Promise<Response>;
}

export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function getClickSendAvailability(env: EnvLike = process.env): ClickSendAvailability {
  const candidate = readClickSendEnv(env);
  const missingEnv = Object.entries(envShape)
    .filter(([key]) => !candidate[key as keyof typeof candidate])
    .map(([, name]) => name);

  return {
    provider: "clicksend",
    configured: clickSendConfigSchema.safeParse(candidate).success,
    missingEnv,
  };
}

export function readClickSendConfig(env: EnvLike = process.env): ClickSendConfig | null {
  const parsed = clickSendConfigSchema.safeParse(readClickSendEnv(env));
  if (!parsed.success) return null;

  return {
    provider: "clicksend",
    username: parsed.data.username,
    apiKey: parsed.data.apiKey,
    apiBaseUrl: CLICKSEND_API_BASE_URL,
  };
}

export function requireClickSendConfig(env: EnvLike = process.env): ClickSendConfig {
  const config = readClickSendConfig(env);
  if (!config) throw new SmsProviderConfigurationError(getClickSendAvailability(env));
  return config;
}

export function createClickSendApiClient(config: ClickSendConfig, options: ClickSendClientOptions = {}): ClickSendApiClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // ClickSend v3 uses HTTP Basic auth with the account username as the user
  // and the API key as the password.
  const auth = Buffer.from(`${config.username}:${config.apiKey}`, "utf8").toString("base64");

  return {
    provider: "clicksend",
    config,
    async postJson(path, body, init) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Basic ${auth}`);
      headers.set("Content-Type", "application/json");
      headers.set("Accept", "application/json");

      return fetchImpl(new URL(normalizePath(path), config.apiBaseUrl), {
        ...init,
        method: "POST",
        headers,
        body: JSON.stringify(body),
        cache: "no-store",
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    },
  };
}

export class SmsProviderConfigurationError extends Error {
  readonly code = "sms_provider_not_configured";
  readonly availability: ClickSendAvailability;

  constructor(availability: ClickSendAvailability) {
    super("sms_provider_not_configured");
    this.name = "SmsProviderConfigurationError";
    this.availability = availability;
  }
}

export function clickSendSmsSendPath() {
  return CLICKSEND_SMS_SEND_PATH;
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function readClickSendEnv(env: EnvLike) {
  return {
    username: env.CLICKSEND_USERNAME?.trim(),
    apiKey: env.CLICKSEND_API_KEY?.trim(),
  };
}
