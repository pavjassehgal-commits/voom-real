import { Buffer } from "node:buffer";
import { z } from "zod";

const TWILIO_API_BASE_URL = "https://api.twilio.com";
const TWILIO_API_VERSION = "2010-04-01";
const DEFAULT_TIMEOUT_MS = 15_000;

const twilioConfigSchema = z.object({
  apiKey: z.string().trim().min(1),
  accountSid: z.string().trim().regex(/^AC[0-9a-fA-F]{32}$/),
  messagingServiceSid: z.string().trim().regex(/^MG[0-9a-fA-F]{32}$/),
});

const envShape = {
  apiKey: "SMS_PROVIDER_API_KEY",
  accountSid: "TWILIO_ACCOUNT_SID",
  messagingServiceSid: "TWILIO_MESSAGING_SERVICE_SID",
} as const;

type EnvLike = Record<string, string | undefined>;

export interface TwilioConfig {
  provider: "twilio";
  apiKey: string;
  accountSid: string;
  messagingServiceSid: string;
  apiBaseUrl: string;
  apiVersion: string;
}

export interface TwilioAvailability {
  provider: "twilio";
  configured: boolean;
  missingEnv: string[];
}

export interface TwilioClientOptions {
  fetch?: ProviderFetch;
  timeoutMs?: number;
}

export interface TwilioApiClient {
  provider: "twilio";
  config: TwilioConfig;
  postForm(path: string, form: URLSearchParams | Record<string, string>, init?: Omit<RequestInit, "method" | "body">): Promise<Response>;
}

export type ProviderFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export function getTwilioAvailability(env: EnvLike = process.env): TwilioAvailability {
  const candidate = readTwilioEnv(env);
  const missingEnv = Object.entries(envShape)
    .filter(([key]) => !candidate[key as keyof typeof candidate])
    .map(([, name]) => name);

  return {
    provider: "twilio",
    configured: twilioConfigSchema.safeParse(candidate).success,
    missingEnv,
  };
}

export function readTwilioConfig(env: EnvLike = process.env): TwilioConfig | null {
  const parsed = twilioConfigSchema.safeParse(readTwilioEnv(env));
  if (!parsed.success) return null;

  return {
    provider: "twilio",
    apiKey: parsed.data.apiKey,
    accountSid: parsed.data.accountSid,
    messagingServiceSid: parsed.data.messagingServiceSid,
    apiBaseUrl: TWILIO_API_BASE_URL,
    apiVersion: TWILIO_API_VERSION,
  };
}

export function requireTwilioConfig(env: EnvLike = process.env): TwilioConfig {
  const config = readTwilioConfig(env);
  if (!config) throw new SmsProviderConfigurationError(getTwilioAvailability(env));
  return config;
}

export function createTwilioApiClient(config: TwilioConfig, options: TwilioClientOptions = {}): TwilioApiClient {
  const fetchImpl = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const auth = Buffer.from(`${config.accountSid}:${config.apiKey}`, "utf8").toString("base64");

  return {
    provider: "twilio",
    config,
    async postForm(path, form, init) {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", `Basic ${auth}`);
      headers.set("Content-Type", "application/x-www-form-urlencoded;charset=utf-8");
      headers.set("Accept", "application/json");

      return fetchImpl(new URL(normalizePath(path), `${config.apiBaseUrl}/${config.apiVersion}/Accounts/${config.accountSid}/`), {
        ...init,
        method: "POST",
        headers,
        body: toFormData(form).toString(),
        cache: "no-store",
        signal: init?.signal ?? AbortSignal.timeout(timeoutMs),
      });
    },
  };
}

export class SmsProviderConfigurationError extends Error {
  readonly code = "sms_provider_not_configured";
  readonly availability: TwilioAvailability;

  constructor(availability: TwilioAvailability) {
    super("sms_provider_not_configured");
    this.name = "SmsProviderConfigurationError";
    this.availability = availability;
  }
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path.slice(1) : path;
}

function toFormData(form: URLSearchParams | Record<string, string>) {
  return form instanceof URLSearchParams ? form : new URLSearchParams(form);
}

function readTwilioEnv(env: EnvLike) {
  return {
    apiKey: env.SMS_PROVIDER_API_KEY?.trim(),
    accountSid: env.TWILIO_ACCOUNT_SID?.trim(),
    messagingServiceSid: env.TWILIO_MESSAGING_SERVICE_SID?.trim(),
  };
}
