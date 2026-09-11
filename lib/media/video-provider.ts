import "server-only";
import type { VideoConfig } from "./video-config";
import { parseProviderDiagnostic } from "./diagnostic";
import { MediaError, type GeneratedMedia, type MediaAspectRatio, type MediaDiagnostic, type MediaErrorCode } from "./types";

/**
 * The video generation provider abstraction. Voom's app code only ever talks
 * to this interface — never to a vendor API — so the vendor can be swapped
 * without touching drafts, jobs, storage or the publishing pipeline.
 *
 * V1 provider: Magic Hour (verified against its current official API):
 *   1. POST /v1/files/upload-urls  -> { upload_url, file_path } (for inputs)
 *   2. POST /v1/image-to-video or  -> { id, credits_charged } (async job)
 *      POST /v1/text-to-video
 *   3. GET  /v1/video-projects/{id}-> status draft|queued|rendering|complete|
 *                                     error|canceled + downloads[]
 *
 * Gemini and OpenAI adapters are kept behind the same interface for
 * text-to-video deployments (no image-to-video support there).
 */

export interface ReferenceImage {
  bytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  extension: "jpg" | "png" | "webp";
  /** Original filename hint, used only for the upload request. */
  name: string;
  /** A short-lived private-bucket URL that OpenRouter can fetch server-side. */
  url?: string | null;
}

export interface CreatedVideoJob {
  providerJobId: string;
  /** Provider polling URL persisted so later polls never need to resubmit. */
  pollingUrl?: string;
  /** Provider-native status at submission time. */
  providerStatus?: string;
}

export interface CreateVideoJobInput {
  /** The provider video prompt (visual prompt + motion direction). */
  prompt: string;
  aspectRatio: MediaAspectRatio;
  durationSeconds: number;
  /** Present for image-to-video jobs (user asset or MARA base image). */
  referenceImage?: ReferenceImage | null;
  /** Human label persisted only in Voom records, never shown by the vendor. */
  name: string;
}

export type VideoJobPoll =
  | { kind: "pending"; providerStatus?: string; pollingUrl?: string }
  | { kind: "complete"; media: GeneratedMedia; providerStatus?: string; pollingUrl?: string }
  | { kind: "failed"; code: MediaErrorCode; diagnostic?: MediaDiagnostic | null; providerStatus?: string; pollingUrl?: string };

export interface VideoGenerationProvider {
  readonly name: "magic-hour" | "gemini" | "openai" | "openrouter";
  readonly supportsImageToVideo: boolean;
  readonly supportsTextToVideo: boolean;
  createVideoJob(input: CreateVideoJobInput): Promise<CreatedVideoJob>;
  pollVideoJob(providerJobId: string, pollingUrl?: string | null): Promise<VideoJobPoll>;
}

export function createVideoProvider(config: VideoConfig): VideoGenerationProvider {
  if (config.provider === "magic-hour") return new MagicHourVideoProvider(config);
  if (config.provider === "openrouter") return new OpenRouterVideoProvider(config);
  if (config.provider === "openai") return new OpenAiVideoProviderAdapter(config);
  return new GeminiVideoProviderAdapter(config);
}

// ---------------------------------------------------------------------------
// Magic Hour
// ---------------------------------------------------------------------------

class MagicHourVideoProvider implements VideoGenerationProvider {
  readonly name = "magic-hour" as const;
  readonly supportsImageToVideo = true;
  readonly supportsTextToVideo = true;
  private readonly config: VideoConfig;

  constructor(config: VideoConfig) { this.config = config; }

  async createVideoJob(input: CreateVideoJobInput): Promise<{ providerJobId: string }> {
    if (input.referenceImage) {
      const filePath = await this.uploadReferenceImage(input.referenceImage);
      const body: Record<string, unknown> = {
        name: input.name,
        end_seconds: input.durationSeconds,
        resolution: this.config.resolution,
        style: { prompt: input.prompt },
        assets: { image_file_path: filePath },
      };
      if (this.config.model) body.model = this.config.model;
      const response = await this.json("/v1/image-to-video", body);
      return { providerJobId: this.jobIdFrom(response) };
    }
    const body: Record<string, unknown> = {
      name: input.name,
      end_seconds: input.durationSeconds,
      resolution: this.config.resolution,
      aspect_ratio: input.aspectRatio === "16:9" ? "16:9" : "9:16",
      orientation: input.aspectRatio === "16:9" ? "landscape" : "portrait",
      style: { prompt: input.prompt },
    };
    if (this.config.model) body.model = this.config.model;
    const response = await this.json("/v1/text-to-video", body);
    return { providerJobId: this.jobIdFrom(response) };
  }

  async pollVideoJob(providerJobId: string): Promise<VideoJobPoll> {
    const body = await this.json(`/v1/video-projects/${encodeURIComponent(providerJobId)}`);
    const status = typeof body.status === "string" ? body.status : "";
    if (status === "error") return { kind: "failed", code: "rejected" };
    if (status === "canceled") return { kind: "failed", code: "unavailable" };
    if (status !== "complete") return { kind: "pending" };
    const download = Array.isArray(body.downloads) ? (body.downloads as Array<Record<string, unknown>>)[0] : null;
    const url = download && typeof download.url === "string" ? download.url : null;
    if (!url) return { kind: "failed", code: "malformed_response" };
    const media = await downloadMedia(url, {}, "video/mp4");
    return { kind: "complete", media };
  }

  private async uploadReferenceImage(image: ReferenceImage): Promise<string> {
    const body = await this.json("/v1/files/upload-urls", {
      items: [{ extension: image.extension, type: "image" }],
    });
    const item = Array.isArray(body.items) ? (body.items as Array<Record<string, unknown>>)[0] : null;
    const uploadUrl = item && typeof item.upload_url === "string" ? item.upload_url : null;
    const filePath = item && typeof item.file_path === "string" ? item.file_path : null;
    if (!uploadUrl || !filePath) throw new MediaError("malformed_response");
    let response: Response;
    try {
      response = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": image.mimeType },
        body: new Blob([image.bytes as Uint8Array<ArrayBuffer>]),
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("unavailable");
    }
    if (!response.ok) throw new MediaError(response.status === 429 ? "rate_limited" : "unavailable");
    return filePath;
  }

  private jobIdFrom(body: Record<string, unknown>): string {
    if (typeof body.id === "string" && body.id.length > 0) return body.id;
    throw new MediaError("malformed_response");
  }

  private async json(path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("unavailable");
    }
    if (response.status === 429) throw new MediaError("rate_limited");
    if (response.status === 401 || response.status === 403) throw new MediaError("rejected");
    // 402 from the video provider means the account is out of credits —
    // classified separately so the safe user message can say so truthfully.
    if (response.status === 402) throw new MediaError("insufficient_credits");
    if (!response.ok) throw new MediaError(response.status >= 500 ? "unavailable" : "rejected");
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MediaError("malformed_response");
    }
  }
}

// ---------------------------------------------------------------------------
// OpenRouter Seedance (async text-to-video and first-frame-to-video)
// ---------------------------------------------------------------------------

interface OpenRouterVideoModel {
  id?: unknown;
  supported_durations?: unknown;
  supported_resolutions?: unknown;
  supported_aspect_ratios?: unknown;
  supported_frame_images?: unknown;
}

class OpenRouterVideoProvider implements VideoGenerationProvider {
  readonly name = "openrouter" as const;
  readonly supportsImageToVideo = true;
  readonly supportsTextToVideo = true;
  private readonly config: VideoConfig;

  constructor(config: VideoConfig) { this.config = config; }

  /**
   * OpenRouter's video endpoint is billable and asynchronous. The model list
   * call is deliberately made before POST /videos so unsupported duration,
   * resolution, aspect-ratio, or first-frame combinations fail without
   * spending credits.
   */
  async createVideoJob(input: CreateVideoJobInput): Promise<CreatedVideoJob> {
    const capabilities = await this.findModelCapabilities();
    const model = this.config.model;
    if (!model) throw new MediaError("not_configured");

    const duration = this.config.durationSeconds ?? input.durationSeconds;
    requireSupported(capabilities, "supported_durations", duration, `Model ${model} does not support a ${duration}-second video.`);
    requireSupported(capabilities, "supported_resolutions", this.config.resolution, `Model ${model} does not support ${this.config.resolution} output.`);
    requireSupported(capabilities, "supported_aspect_ratios", input.aspectRatio, `Model ${model} does not support ${input.aspectRatio} output.`);

    const body: Record<string, unknown> = {
      model,
      prompt: input.prompt,
      duration,
      resolution: this.config.resolution,
      aspect_ratio: input.aspectRatio,
      // Voom has no safe audio attachment/mixing workflow in V1.
      generate_audio: false,
    };

    if (input.referenceImage) {
      const frameSupport = capabilities.supported_frame_images;
      if (!Array.isArray(frameSupport) || !frameSupport.some((value) => value === "first_frame")) {
        throw capabilityError(`Model ${model} does not support first-frame image-to-video input.`);
      }
      if (!input.referenceImage.url) {
        // OpenRouter fetches an HTTPS image URL. The bytes remain server-side;
        // Voom's ports create a short-lived signed URL for this request.
        throw new MediaError("unsupported_input", capabilityDiagnostic("Voom could not create a safe reference-image URL."));
      }
      body.frame_images = [{
        type: "image_url",
        image_url: { url: input.referenceImage.url },
        frame_type: "first_frame",
      }];
    }

    const response = await this.json(`${this.config.baseUrl}/videos`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    const providerJobId = stringAt(response, "id");
    const rawPollingUrl = stringAt(response, "polling_url");
    return {
      providerJobId,
      pollingUrl: resolveProviderUrl(rawPollingUrl, this.config.baseUrl),
      providerStatus: typeof response.status === "string" ? response.status : "pending",
    };
  }

  async pollVideoJob(providerJobId: string, pollingUrl?: string | null): Promise<VideoJobPoll> {
    // Reuse the URL persisted from submission. Falling back to the canonical
    // endpoint supports older rows created before polling_url was added.
    const url = pollingUrl
      ? resolveProviderUrl(pollingUrl, this.config.baseUrl)
      : `${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}`;
    const body = await this.json(url, { method: "GET", headers: this.headers(false) });
    const status = typeof body.status === "string" ? body.status : "";
    const returnedPollingUrl = typeof body.polling_url === "string"
      ? resolveProviderUrl(body.polling_url, this.config.baseUrl)
      : pollingUrl ?? undefined;

    if (status === "completed") {
      // The content endpoint is authenticated even though the response also
      // contains an unsigned_urls array. This keeps the download server-side
      // and deterministic, and always selects the first MP4 output.
      const media = await this.downloadVideo(`${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}/content?index=0`);
      return { kind: "complete", media, providerStatus: status, pollingUrl: returnedPollingUrl };
    }
    if (status === "failed" || status === "cancelled" || status === "expired") {
      const diagnostic = await diagnosticFromProviderJob(body, status);
      return {
        kind: "failed",
        code: status === "expired" ? "provider_timeout" : status === "cancelled" ? "unavailable" : "rejected",
        diagnostic,
        providerStatus: status,
        pollingUrl: returnedPollingUrl,
      };
    }
    if (status === "pending" || status === "in_progress") {
      return { kind: "pending", providerStatus: status, pollingUrl: returnedPollingUrl };
    }
    return {
      kind: "failed",
      code: "malformed_response",
      diagnostic: await diagnosticFromProviderJob(body, status || "unknown"),
      providerStatus: status || undefined,
      pollingUrl: returnedPollingUrl,
    };
  }

  private headers(contentType: boolean): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config.apiKey}`,
      Accept: "application/json",
      ...(contentType ? { "Content-Type": "application/json" } : {}),
    };
  }

  private async findModelCapabilities(): Promise<OpenRouterVideoModel> {
    const body = await this.json(`${this.config.baseUrl}/videos/models`, {
      method: "GET",
      headers: this.headers(false),
    });
    const data = body.data;
    if (!Array.isArray(data)) throw new MediaError("malformed_response");
    const found = data.find((value): value is OpenRouterVideoModel => {
      return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>).id === this.config.model);
    });
    if (!found) throw capabilityError(`OpenRouter video model ${this.config.model ?? ""} is not available.`);
    return found;
  }

  private async json(url: string, init: RequestInit): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(url, { ...init, cache: "no-store", signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new MediaError("unavailable");
    }
    if (!response.ok) {
      const diagnostic = await parseProviderDiagnostic(response);
      const code: MediaErrorCode = response.status === 429
        ? "rate_limited"
        : response.status === 402
          ? "insufficient_credits"
          : response.status >= 500
            ? "unavailable"
            : response.status === 401 || response.status === 403
              ? "rejected"
              : "rejected";
      throw new MediaError(code, diagnostic, { retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")) });
    }
    try {
      return await response.json() as Record<string, unknown>;
    } catch {
      throw new MediaError("malformed_response");
    }
  }

  private async downloadVideo(url: string): Promise<GeneratedMedia> {
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { Authorization: `Bearer ${this.config.apiKey}`, Accept: "video/mp4" },
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("unavailable");
    }
    if (!response.ok) {
      const diagnostic = await parseProviderDiagnostic(response);
      throw new MediaError(
        response.status === 429
          ? "rate_limited"
          : response.status === 402
            ? "insufficient_credits"
            : response.status >= 500
              ? "unavailable"
              : "rejected",
        diagnostic,
        { retryAfterMs: retryAfterMilliseconds(response.headers.get("retry-after")) },
      );
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!bytes.length || bytes.length > GENERATED_VIDEO_MAX_BYTES) throw new MediaError("invalid_output");
    // The state machine re-sniffs these bytes and rejects anything that is not
    // a real MP4 before private storage. Do not trust content-type metadata.
    return { kind: "complete", bytes, mimeType: "video/mp4" };
  }
}

// ---------------------------------------------------------------------------
// Gemini / OpenAI adapters (text-to-video only; reference images unsupported)
// ---------------------------------------------------------------------------

class GeminiVideoProviderAdapter implements VideoGenerationProvider {
  readonly name = "gemini" as const;
  readonly supportsImageToVideo = false;
  readonly supportsTextToVideo = true;
  private readonly config: VideoConfig;

  constructor(config: VideoConfig) { this.config = config; }

  async createVideoJob(input: CreateVideoJobInput): Promise<{ providerJobId: string }> {
    if (input.referenceImage) throw new MediaError("unsupported_input");
    const body = await this.json(`${this.config.baseUrl}/models/${encodeURIComponent(this.config.model ?? "")}:predictLongRunning`, {
      instances: [{ prompt: input.prompt }],
      parameters: { aspectRatio: input.aspectRatio, durationSeconds: input.durationSeconds, sampleCount: 1 },
    });
    if (typeof body.name !== "string" || !body.name) throw new MediaError("malformed_response");
    return { providerJobId: body.name };
  }

  async pollVideoJob(providerJobId: string): Promise<VideoJobPoll> {
    const body = await this.json(`${this.config.baseUrl}/${providerJobId.replace(/^\//, "")}`);
    if (body.done !== true) return { kind: "pending" };
    const uri = findString(body, ["response", "generateVideoResponse", "generatedSamples", "0", "video", "uri"]);
    if (!uri) return { kind: "failed", code: "malformed_response" };
    const media = await downloadMedia(uri, { "x-goog-api-key": this.config.apiKey }, "video/mp4");
    return { kind: "complete", media };
  }

  private async json(path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { "x-goog-api-key": this.config.apiKey, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        body: body === undefined ? undefined : JSON.stringify(body),
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("unavailable");
    }
    if (response.status === 429) throw new MediaError("rate_limited");
    if (!response.ok) throw new MediaError(response.status >= 500 ? "unavailable" : "rejected");
    try {
      return (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MediaError("malformed_response");
    }
  }
}

class OpenAiVideoProviderAdapter implements VideoGenerationProvider {
  readonly name = "openai" as const;
  readonly supportsImageToVideo = false;
  readonly supportsTextToVideo = true;
  private readonly config: VideoConfig;

  constructor(config: VideoConfig) { this.config = config; }

  async createVideoJob(input: CreateVideoJobInput): Promise<{ providerJobId: string }> {
    if (input.referenceImage) throw new MediaError("unsupported_input");
    const size = input.aspectRatio === "16:9" ? "1280x720" : "720x1280";
    const form = new FormData();
    form.set("model", this.config.model ?? "");
    form.set("prompt", input.prompt);
    form.set("size", size);
    form.set("seconds", String(input.durationSeconds));
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/videos`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.apiKey}` },
        body: form,
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new MediaError("unavailable");
    }
    if (response.status === 429) throw new MediaError("rate_limited");
    if (!response.ok) throw new MediaError(response.status >= 500 ? "unavailable" : "rejected");
    try {
      const body = (await response.json()) as Record<string, unknown>;
      if (typeof body.id !== "string" || !body.id) throw new MediaError("malformed_response");
      return { providerJobId: body.id };
    } catch {
      throw new MediaError("malformed_response");
    }
  }

  async pollVideoJob(providerJobId: string): Promise<VideoJobPoll> {
    const headers = { Authorization: `Bearer ${this.config.apiKey}`, "Content-Type": "application/json" };
    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}`, { headers, cache: "no-store", signal: AbortSignal.timeout(120_000) });
    } catch {
      throw new MediaError("unavailable");
    }
    if (!response.ok) throw new MediaError(response.status >= 500 ? "unavailable" : "rejected");
    let body: Record<string, unknown>;
    try {
      body = (await response.json()) as Record<string, unknown>;
    } catch {
      throw new MediaError("malformed_response");
    }
    const status = typeof body.status === "string" ? body.status : "";
    if (status === "failed") return { kind: "failed", code: "rejected" };
    if (status !== "completed") return { kind: "pending" };
    const media = await downloadMedia(`${this.config.baseUrl}/videos/${encodeURIComponent(providerJobId)}/content`, headers, "video/mp4");
    return { kind: "complete", media };
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export const GENERATED_VIDEO_MAX_BYTES = 500 * 1024 * 1024;

function requireSupported(
  model: OpenRouterVideoModel,
  key: "supported_durations" | "supported_resolutions" | "supported_aspect_ratios",
  expected: string | number,
  message: string,
) {
  const values = model[key];
  // A missing field is treated as an incomplete catalog response and left to
  // OpenRouter; a present list is authoritative and must contain the value.
  if (values !== undefined && (!Array.isArray(values) || !values.some((value) => value === expected))) {
    throw capabilityError(message);
  }
}

function capabilityError(message: string): MediaError {
  return new MediaError("rejected", capabilityDiagnostic(message));
}

function stringAt(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== "string" || !value) throw new MediaError("malformed_response");
  return value;
}

function capabilityDiagnostic(message: string): MediaDiagnostic {
  return {
    http_status: 400,
    content_type: "application/json",
    provider_code: "400",
    provider_status: "INVALID_REQUEST",
    provider_message: message.slice(0, 240),
    provider_details: null,
    body_excerpt: null,
  };
}

async function diagnosticFromProviderJob(body: Record<string, unknown>, status: string): Promise<MediaDiagnostic> {
  const diagnostic = await parseProviderDiagnostic(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  }));
  diagnostic.provider_status = status;
  return diagnostic;
}

function resolveProviderUrl(value: string, baseUrl: string): string {
  try {
    return new URL(value, `${baseUrl}/`).toString();
  } catch {
    throw new MediaError("malformed_response");
  }
}

function retryAfterMilliseconds(value: string | null): number | null {
  if (!value) return null;
  const seconds = Number(value.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  return Math.max(0, timestamp - Date.now());
}

export async function downloadMedia(url: string, headers: Record<string, string> = {}, fallbackMime: GeneratedMedia["mimeType"]): Promise<GeneratedMedia> {
  let response: Response;
  try {
    response = await fetch(url, { headers, cache: "no-store", signal: AbortSignal.timeout(120_000) });
  } catch {
    throw new MediaError("unavailable");
  }
  if (!response.ok) throw new MediaError(response.status === 429 ? "rate_limited" : "unavailable");
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (!buffer.length || buffer.length > GENERATED_VIDEO_MAX_BYTES) throw new MediaError("invalid_output");
  const mime = response.headers.get("content-type")?.split(";")[0] as GeneratedMedia["mimeType"] | null;
  return { kind: "complete", bytes: buffer, mimeType: mime === "video/mp4" || mime === "image/jpeg" || mime === "image/png" || mime === "image/webp" ? mime : fallbackMime };
}

function findString(value: unknown, path: string[]): string | null {
  let current: unknown = value;
  for (const key of path) {
    if (!current || typeof current !== "object") return null;
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === "string" ? current : null;
}
