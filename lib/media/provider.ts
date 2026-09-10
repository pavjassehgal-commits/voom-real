import "server-only";
import type { MediaConfig } from "./config";
import { MediaError, type GeneratedMedia, type MediaAspectRatio, type MediaProvider } from "./types";

export function createMediaProvider(config: MediaConfig): MediaProvider {
  return config.provider === "gemini" ? new GeminiMediaProvider(config) : new OpenAiMediaProvider(config);
}

class GeminiMediaProvider implements MediaProvider {
  constructor(private readonly config: MediaConfig) {}

  async generateImage(input: { prompt: string; aspectRatio: MediaAspectRatio }) {
    const body = await jsonRequest(`${this.config.baseUrl}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.imageModel, input: [{ type: "text", text: input.prompt }], response_format: { type: "image", mime_type: "image/png", aspect_ratio: input.aspectRatio } }),
    });
    const image = findGeminiOutputImage(body);
    return decodeMedia(image.data, image.mimeType ?? "image/png");
  }

  async generateVideo(input: { prompt: string; aspectRatio: MediaAspectRatio; durationSeconds: number }) {
    const body = await jsonRequest(`${this.config.baseUrl}/models/${encodeURIComponent(this.config.videoModel)}:predictLongRunning`, {
      method: "POST",
      headers: { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ instances: [{ prompt: input.prompt }], parameters: { aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, sampleCount: 1 } }),
    });
    const name = stringAt(body, "name");
    return { kind: "pending" as const, providerJobId: name };
  }

  async pollVideo(providerJobId: string) {
    const body = await jsonRequest(`${this.config.baseUrl}/${providerJobId.replace(/^\//, "")}`, { headers: { "x-goog-api-key": this.config.apiKey } });
    if (body.done !== true) return { kind: "pending" as const, providerJobId };
    const uri = findString(body, ["response", "generateVideoResponse", "generatedSamples", "0", "video", "uri"]);
    if (!uri) throw new MediaError("malformed_response");
    return downloadMedia(uri, { "x-goog-api-key": this.config.apiKey }, "video/mp4");
  }
}

class OpenAiMediaProvider implements MediaProvider {
  constructor(private readonly config: MediaConfig) {}

  async generateImage(input: { prompt: string; aspectRatio: MediaAspectRatio }) {
    const size = input.aspectRatio === "1:1" ? "1024x1024" : input.aspectRatio === "16:9" ? "1536x1024" : "1024x1536";
    const body = await jsonRequest(`${this.config.baseUrl}/images/generations`, {
      method: "POST", headers: this.headers(), body: JSON.stringify({ model: this.config.imageModel, prompt: input.prompt, size, response_format: "b64_json" }),
    });
    const data = findString(body, ["data", "0", "b64_json"]);
    if (!data) throw new MediaError("malformed_response");
    return decodeMedia(data, "image/png");
  }

  async generateVideo(input: { prompt: string; aspectRatio: MediaAspectRatio; durationSeconds: number }) {
    const size = input.aspectRatio === "16:9" ? "1280x720" : "720x1280";
    const form = new FormData(); form.set("model", this.config.videoModel); form.set("prompt", input.prompt); form.set("size", size); form.set("seconds", String(input.durationSeconds));
    const body = await jsonRequest(`${this.config.baseUrl}/videos`, { method: "POST", headers: { Authorization: `Bearer ${this.config.apiKey}` }, body: form });
    return { kind: "pending" as const, providerJobId: stringAt(body, "id") };
  }

  async pollVideo(providerJobId: string) {
    const body = await jsonRequest(`${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}`, { headers: this.headers() });
    const status = stringAt(body, "status");
    if (status === "failed") throw new MediaError("rejected");
    if (status !== "completed") return { kind: "pending" as const, providerJobId };
    return downloadMedia(`${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}/content`, this.headers(), "video/mp4");
  }

  private headers() { return { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" }; }
}

async function jsonRequest(url: string, init: RequestInit) {
  let response: Response;
  try { response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(120_000) }); }
  catch { throw new MediaError("unavailable"); }
  if (!response.ok) {
    const diagnostic = await parseProviderDiagnostic(response);
    throw new MediaError(response.status === 429 ? "rate_limited" : response.status >= 500 ? "unavailable" : "rejected", diagnostic);
  }
  try { return await response.json() as Record<string, unknown>; }
  catch { throw new MediaError("malformed_response"); }
}

const DIAGNOSTIC_MESSAGE_MAX = 500;
const SECRET_RE = /(api[-_ ]?key|authorization|bearer|cookie|signed[_ -]?url|https?:\/\/[^ ]+)/gi;

async function parseProviderDiagnostic(response: Response) {
  let value: unknown = null;
  try { value = JSON.parse((await response.text()).slice(0, 16_000)); } catch { /* non-JSON is intentionally not retained */ }
  const root = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const error = root.error && typeof root.error === "object" ? root.error as Record<string, unknown> : root;
  const clean = (candidate: unknown) => typeof candidate === "string" ? candidate.replace(SECRET_RE, "[redacted]").replace(/[\\r\\n]+/g, " ").trim().slice(0, DIAGNOSTIC_MESSAGE_MAX) || null : null;
  const code = typeof error.code === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : null;
  const status = typeof error.status === "string" && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.status) ? error.status : null;
  return { http_status: response.status, provider_code: code, provider_status: status, provider_message: clean(error.message) };
}

async function downloadMedia(url: string, headers: Record<string, string>, fallbackMime: GeneratedMedia["mimeType"]): Promise<GeneratedMedia> {
  let response: Response;
  try { response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(120_000) }); }
  catch { throw new MediaError("unavailable"); }
  if (!response.ok) throw new MediaError(response.status === 429 ? "rate_limited" : "unavailable");
  const mime = response.headers.get("content-type")?.split(";")[0] as GeneratedMedia["mimeType"] | null;
  return { kind: "complete", bytes: new Uint8Array(await response.arrayBuffer()), mimeType: mime ?? fallbackMime };
}

function decodeMedia(data: string, mimeType: GeneratedMedia["mimeType"]): GeneratedMedia {
  try { return { kind: "complete", bytes: new Uint8Array(Buffer.from(data, "base64")), mimeType }; }
  catch { throw new MediaError("malformed_response"); }
}

function findGeminiOutputImage(body: Record<string, unknown>) {
  const direct = body.output_image;
  if (direct && typeof direct === "object" && !Array.isArray(direct)) {
    const record = direct as Record<string, unknown>;
    const data = typeof record.data === "string" ? record.data : null;
    if (data) return { data, mimeType: typeof record.mime_type === "string" ? record.mime_type as GeneratedMedia["mimeType"] : null };
  }
  throw new MediaError("malformed_response");
}

function stringAt(body: Record<string, unknown>, key: string) { const value = body[key]; if (typeof value !== "string" || !value) throw new MediaError("malformed_response"); return value; }
function findString(value: unknown, path: string[]): string | null { let current = value; for (const key of path) { if (!current || typeof current !== "object") return null; current = (current as Record<string, unknown>)[key]; } return typeof current === "string" ? current : null; }
