import "server-only";
import type { MediaConfig } from "./config";
import { parseProviderDiagnostic } from "./diagnostic";
import { MediaError, type GeneratedMedia, type MediaAspectRatio, type MediaProvider } from "./types";

export function createMediaProvider(config: MediaConfig): MediaProvider {
  if (config.provider === "gemini") return new GeminiMediaProvider(config);
  if (config.provider === "openrouter") return new OpenRouterMediaProvider(config);
  return new OpenAiMediaProvider(config);
}

class GeminiMediaProvider implements MediaProvider {
  private readonly config: MediaConfig;
  constructor(config: MediaConfig) { this.config = config; }

  /**
   * Gemini Interactions image generation.
   *
   * `response_format.mime_type` must be `image/jpeg`: it is the only image
   * format the endpoint accepts, so a PNG request is a hard HTTP 400 and no
   * visual is ever produced. The bytes therefore arrive as JPEG, and JPEG is
   * also the fallback declaration when a response omits its own mime_type, so
   * nothing downstream mislabels them. Voom still sniffs the real container from
   * the bytes before any of it is stored.
   */
  async generateImage(input: { prompt: string; aspectRatio: MediaAspectRatio }) {
    const body = await jsonRequest(`${this.config.baseUrl}/interactions`, {
      method: "POST",
      headers: { "x-goog-api-key": this.config.apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.config.imageModel, input: [{ type: "text", text: input.prompt }], response_format: { type: "image", mime_type: "image/jpeg", aspect_ratio: input.aspectRatio } }),
    });
    const image = findGeminiOutputImage(body);
    return decodeMedia(image.data, image.mimeType ?? "image/jpeg");
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
  private readonly config: MediaConfig;
  constructor(config: MediaConfig) { this.config = config; }

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

/**
 * OpenRouter Unified Image API (Seedream 4.5 and other image models).
 *
 * Image-only: video generation stays on Magic Hour / VIDEO_* configuration.
 * Auth is OPENROUTER_API_KEY via Bearer. Response bytes come from
 * data[0].b64_json; media_type is respected when present, but Voom always
 * re-derives MIME/extension from byte inspection before storage.
 *
 * No silent retries — a single request per call so paid generations cannot
 * double-bill from provider-level retry loops.
 */
class OpenRouterMediaProvider implements MediaProvider {
  private readonly config: MediaConfig;
  constructor(config: MediaConfig) { this.config = config; }

  async generateImage(input: { prompt: string; aspectRatio: MediaAspectRatio }) {
    const body = await jsonRequest(`${this.config.baseUrl}/images`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: this.config.imageModel,
        prompt: input.prompt,
        n: 1,
        // Seedream 4.5 requires at least 3,686,400 output pixels; the old 1K
        // tier (a 1024-pixel square, 1,048,576 pixels) is rejected with HTTP
        // 400. The 2K tier clears the floor for every supported aspect ratio;
        // the ratio itself is carried by aspect_ratio, so no pixel size is
        // hardcoded.
        resolution: "2K",
        aspect_ratio: input.aspectRatio,
      }),
    });
    const image = findOpenRouterOutputImage(body);
    return decodeMedia(image.data, image.mimeType);
  }

  async generateVideo(): Promise<GeneratedMedia> {
    throw new MediaError("unsupported_input");
  }

  async pollVideo(): Promise<GeneratedMedia> {
    throw new MediaError("unsupported_input");
  }
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

function findOpenRouterOutputImage(body: Record<string, unknown>) {
  const dataArr = body.data;
  if (!Array.isArray(dataArr) || dataArr.length < 1) throw new MediaError("malformed_response");
  const first = dataArr[0];
  if (!first || typeof first !== "object" || Array.isArray(first)) throw new MediaError("malformed_response");
  const record = first as Record<string, unknown>;
  const data = typeof record.b64_json === "string" ? record.b64_json : null;
  if (!data) throw new MediaError("malformed_response");
  const declared = typeof record.media_type === "string" ? record.media_type.trim().toLowerCase() : null;
  const mimeType =
    declared === "image/jpeg" || declared === "image/png" || declared === "image/webp"
      ? declared as GeneratedMedia["mimeType"]
      : "image/png" as GeneratedMedia["mimeType"];
  return { data, mimeType };
}

function stringAt(body: Record<string, unknown>, key: string) { const value = body[key]; if (typeof value !== "string" || !value) throw new MediaError("malformed_response"); return value; }
function findString(value: unknown, path: string[]): string | null { let current = value; for (const key of path) { if (!current || typeof current !== "object") return null; current = (current as Record<string, unknown>)[key]; } return typeof current === "string" ? current : null; }
