import { z } from "zod";

const RESEND_API_BASE_URL = "https://api.resend.com";
const DEFAULT_TIMEOUT_MS = 15_000;

const resendSendSchema = z.object({
  apiKey: z.string().trim().min(1),
  fromAddress: z.string().trim().email(),
  fromName: z.string().trim().min(1).max(120),
});

const resendWebhookSchema = z.object({
  webhookSecret: z.string().trim().min(1),
});

const resendConfigSchema = resendSendSchema.extend({
  webhookSecret: z.string().trim().min(1),
});

const envShape = {
  apiKey: "EMAIL_PROVIDER_API_KEY",
  fromAddress: "EMAIL_FROM_ADDRESS",
  fromName: "EMAIL_FROM_NAME",
  webhookSecret: "EMAIL_WEBHOOK_SECRET",
} as const;

type EnvLike = Record<string, string | undefined>;

export interface ResendConfig {
  provider: "resend";
  apiKey: string;
  fromAddress: string;
  fromName: string;
  webhookSecret: string;
  apiBaseUrl: string;
}

export interface ResendAvailability {
  provider: "resend";
  configured: boolean;
  sendConfigured: boolean;
  webhookConfigured: boolean;
  missingEnv: string[];
}

export interface ResendClientOptions {
  fetch?: ProviderFetch;
  timeoutMs?: number;
}

export interface ResendApiClient {
  provider: "resend";
  config: ResendConfig;
  post(path: string, body: unknown, init?: Omit<RequestInit, "method" | "body">): Promise<Response>;
}

export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function getResendAvailability(env: EnvLike = process.env): ResendAvailability {
  const candidate = readResendEnv(env);
  const sendConfigured = resendSendSchema.safeParse(candidate).success;
  const webhookConfigured = resendWebhookSchema.safeParse(candidate).success;
  const missingEnv = Object.entries(envShape)
    .filter(([key]) => !candidate[key as keyof typeof candidate])
    .map(([, name]) => name);

  return {
    provider: "resend",
    configured: sendConfigured && webhookConfigured,
    sendConfigured,
    webhookConfigured,
    missingEnv,
  };
}

export function readResendConfig(env: EnvLike = process.env): ResendConfig | null {
  const parsed = resendConfigSchema.safeParse(readResendEnv(env));
  if (!parsed.success) return null;

  return {
    provider: "resend",
    apiKey: parsed.data.apiKey,
    fromAddress: parsed.data.fromAddress,
    fromName: parsed.data.fromName,
    webhookSecret: parsed.data.webhookSecret,
    apiBaseUrl: RESEND_API_BASE_URL,
  };
}

export function requireResendConfig(env: EnvLike = process.env): ResendConfig {
  const config = readResendConfig(env);
  if (!config) throw new EmailProviderConfigurationError(getResendAvailability(env));
  return config;
}

export function createResendApiClient(config: ResendConfig, options: ResendClientOptions = {}): ResendApiClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    provider: "resend",
    config,
    async post(path, body, init) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Bearer ${config.apiKey}`);
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

export class EmailProviderConfigurationError extends Error {
  readonly code = "email_provider_not_configured";
  readonly availability: ResendAvailability;

  constructor(availability: ResendAvailability) {
    super("email_provider_not_configured");
    this.name = "EmailProviderConfigurationError";
    this.availability = availability;
  }
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

function readResendEnv(env: EnvLike) {
  return {
    apiKey: env.EMAIL_PROVIDER_API_KEY?.trim(),
    fromAddress: env.EMAIL_FROM_ADDRESS?.trim(),
    fromName: env.EMAIL_FROM_NAME?.trim(),
    webhookSecret: env.EMAIL_WEBHOOK_SECRET?.trim(),
  };
}
