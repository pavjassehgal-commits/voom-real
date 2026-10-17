/**
 * Browser-side controller for one TikTok video upload:
 *
 *   1. ask Voom for an upload session (signed token for one private path);
 *   2. upload the file straight to Supabase Storage with the resumable (TUS)
 *      protocol in 6 MB chunks, reporting progress — the bytes never pass
 *      through a Vercel Function;
 *   3. ask Voom to finalize, which verifies the stored object and links it.
 *
 * Network interruptions are retried automatically by the TUS client; after
 * that, `retry()` resumes the same upload from the offset Supabase recorded.
 * If the session has expired or is refused (401/403/404/409/410), a fresh
 * session is requested once and the upload restarts. `cancel()` aborts and
 * asks Supabase to discard the partial upload. Dependency-injected so the
 * state machine is unit tested without a browser.
 */

import { TIKTOK_VIDEO_MAX_BYTES, tiktokUploadErrorMessage, validateTikTokUploadRequest } from "./video-upload";

export interface TusUploadLike {
  start(): void;
  abort(shouldTerminate?: boolean): Promise<void>;
}

export interface TusOptionsLike {
  endpoint: string;
  chunkSize: number;
  retryDelays: number[];
  uploadDataDuringCreation: boolean;
  removeFingerprintOnSuccess: boolean;
  storeFingerprintForResuming: boolean;
  headers: Record<string, string>;
  metadata: Record<string, string>;
  onProgress: (sent: number, total: number) => void;
  onSuccess: () => void;
  onError: (error: Error & { originalResponse?: { getStatus(): number } | null }) => void;
}

export type TusFactory = (file: Blob, options: TusOptionsLike) => TusUploadLike;

export type UploadPhase = "idle" | "preparing" | "uploading" | "finalizing" | "done" | "failed" | "cancelled";

export interface UploadSnapshot {
  phase: UploadPhase;
  sentBytes: number;
  totalBytes: number;
  error: string | null;
  /** True when retry() can resume the same upload. */
  canRetry: boolean;
}

interface UploadSession {
  endpoint: string;
  bucket: string;
  path: string;
  token: string;
  chunkSize: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const TIKTOK_UPLOAD_RETRY_DELAYS = [0, 3000, 5000, 10000, 20000];
const SESSION_REFUSED = new Set([401, 403, 404, 409, 410]);

export interface TikTokUploadOptions<TDraft> {
  draftId: string;
  file: File;
  publishableKey: string;
  fetch: FetchLike;
  createTus: TusFactory;
  onChange: (snapshot: UploadSnapshot) => void;
  onDone: (result: { draft: TDraft; message: string }) => void;
}

export interface TikTokUploadController {
  start(): Promise<void>;
  retry(): Promise<void>;
  cancel(): Promise<void>;
  snapshot(): UploadSnapshot;
}

export function createTikTokUploadController<TDraft>(options: TikTokUploadOptions<TDraft>): TikTokUploadController {
  const { file } = options;
  let state: UploadSnapshot = { phase: "idle", sentBytes: 0, totalBytes: file.size, error: null, canRetry: false };
  let session: UploadSession | null = null;
  let upload: TusUploadLike | null = null;
  let sessionRestarts = 0;
  let busy = false;

  const set = (patch: Partial<UploadSnapshot>) => {
    state = { ...state, ...patch };
    options.onChange(state);
  };
  const fail = (message: string, canRetry: boolean) => {
    busy = false;
    set({ phase: "failed", error: message, canRetry });
  };

  async function newSession(): Promise<UploadSession | null> {
    const response = await options.fetch(`/api/social-drafts/${options.draftId}/asset/upload-session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: file.name, fileSize: file.size, contentType: file.type || undefined }),
    });
    const body = await response.json().catch(() => ({})) as { upload?: UploadSession; error?: string };
    if (!response.ok || !body.upload) {
      fail(typeof body.error === "string" ? body.error : tiktokUploadErrorMessage("storage_failure"), response.status >= 500);
      return null;
    }
    return body.upload;
  }

  function beginTransfer(current: UploadSession) {
    set({ phase: "uploading", error: null, canRetry: false });
    upload = options.createTus(file, {
      endpoint: current.endpoint,
      chunkSize: current.chunkSize,
      retryDelays: TIKTOK_UPLOAD_RETRY_DELAYS,
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      // A session token only lives 2 hours, so resuming across page reloads is
      // not offered; in-page interruptions resume through retry().
      storeFingerprintForResuming: false,
      headers: { apikey: options.publishableKey, "x-signature": current.token, "x-upsert": "false" },
      metadata: { bucketName: current.bucket, objectName: current.path, contentType: "video/mp4", cacheControl: "3600" },
      onProgress: (sent, total) => {
        if (state.phase === "uploading") set({ sentBytes: sent, totalBytes: total });
      },
      onSuccess: () => { void finalize(current); },
      onError: (error) => {
        if (state.phase === "cancelled") return;
        const status = error.originalResponse?.getStatus?.() ?? 0;
        if (SESSION_REFUSED.has(status) && sessionRestarts < 1) {
          sessionRestarts += 1;
          void restartWithNewSession();
          return;
        }
        fail(status === 413 ? tiktokUploadErrorMessage("too_large") : "The upload was interrupted. Check your connection and retry.", status !== 413);
      },
    });
    upload.start();
  }

  async function restartWithNewSession() {
    set({ phase: "preparing", sentBytes: 0, error: null, canRetry: false });
    session = await newSession();
    if (session && state.phase !== "cancelled") beginTransfer(session);
  }

  async function finalize(current: UploadSession) {
    if (state.phase === "cancelled") return;
    set({ phase: "finalizing", sentBytes: file.size });
    const response = await options.fetch(`/api/social-drafts/${options.draftId}/asset/finalize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: current.path, fileName: file.name }),
    }).catch(() => null);
    if (!response) return fail("Voom couldn't confirm the upload. Retry to check it again.", true);
    const body = await response.json().catch(() => ({})) as { draft?: TDraft; message?: string; error?: string };
    if (!response.ok || !body.draft) {
      // A server error leaves the stored upload in place, so retry() can finalize again.
      return fail(typeof body.error === "string" ? body.error : tiktokUploadErrorMessage("storage_failure"), response.status >= 500);
    }
    busy = false;
    set({ phase: "done", error: null, canRetry: false });
    options.onDone({ draft: body.draft, message: body.message ?? "Video attached. Nothing was published." });
  }

  return {
    async start() {
      if (busy) return; // duplicate submissions are ignored
      const declared = validateTikTokUploadRequest({ fileName: file.name, fileSize: file.size, contentType: file.type || undefined });
      if (!declared.ok) {
        set({ phase: "failed", error: tiktokUploadErrorMessage(declared.code), canRetry: false });
        return;
      }
      if (file.size > TIKTOK_VIDEO_MAX_BYTES) return;
      busy = true;
      set({ phase: "preparing", sentBytes: 0, error: null, canRetry: false });
      session = await newSession();
      if (session && state.phase !== "cancelled") beginTransfer(session);
    },
    async retry() {
      if (state.phase !== "failed" || !state.canRetry) return;
      busy = true;
      if (session && state.sentBytes >= file.size) return finalize(session);
      if (session && upload) {
        set({ phase: "uploading", error: null, canRetry: false });
        upload.start(); // resumes from the offset Supabase recorded
        return;
      }
      await restartWithNewSession();
    },
    async cancel() {
      if (state.phase === "done" || state.phase === "cancelled") return;
      const active = upload;
      busy = false;
      set({ phase: "cancelled", error: null, canRetry: false });
      // Terminating asks Supabase to discard the partial upload; anything
      // left behind is removed by the stale-upload cleanup.
      if (active) await active.abort(true).catch(() => undefined);
    },
    snapshot: () => state,
  };
}
