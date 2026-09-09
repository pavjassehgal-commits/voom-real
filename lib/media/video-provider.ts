import "server-only";
import type { VideoConfig } from "./video-config";
import { MediaError, type GeneratedMedia, type MediaAspectRatio, type MediaErrorCode } from "./types";

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
  | { kind: "pending" }
  | { kind: "complete"; media: GeneratedMedia }
  | { kind: "failed"; code: MediaErrorCode };

export interface VideoGenerationProvider {
  readonly name: "magic-hour" | "gemini" | "openai";
  readonly supportsImageToVideo: boolean;
  createVideoJob(input: CreateVideoJobInput): Promise<{ providerJobId: string }>;
  pollVideoJob(providerJobId: string): Promise<VideoJobPoll>;
}

export function createVideoProvider(config: VideoConfig): VideoGenerationProvider {
  if (config.provider === "magic-hour") return new MagicHourVideoProvider(config);
  if (config.provider === "openai") return new OpenAiVideoProviderAdapter(config);
  return new GeminiVideoProviderAdapter(config);
}

// ---------------------------------------------------------------------------
// Magic Hour
// ---------------------------------------------------------------------------

class MagicHourVideoProvider implements VideoGenerationProvider {
  readonly name = "magic-hour" as const;
  readonly supportsImageToVideo = true;
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
// Gemini / OpenAI adapters (text-to-video only; reference images unsupported)
// ---------------------------------------------------------------------------

class GeminiVideoProviderAdapter implements VideoGenerationProvider {
  readonly name = "gemini" as const;
  readonly supportsImageToVideo = false;
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
