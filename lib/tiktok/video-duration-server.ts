import "server-only";

import { inspectTikTokVideoDurationFromRanges } from "./video-duration.ts";

/**
 * Inspects a private signed object using strict HTTP byte ranges. The response
 * body is streamed behind an exact-size cap so a storage server that ignores
 * Range cannot make the function buffer the full video.
 */
export async function inspectTikTokVideoDurationFromUrl(
  url: string,
  byteSize: number,
  fetchRange: (input: string, init?: RequestInit) => Promise<Response> = fetch,
): Promise<number | null> {
  return inspectTikTokVideoDurationFromRanges(byteSize, async (start, end) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start || end >= byteSize) return null;
    const expectedLength = end - start + 1;
    const response = await fetchRange(url, { headers: { Range: `bytes=${start}-${end}` } });
    const wholeSmallObject = response.status === 200 && start === 0 && expectedLength === byteSize;
    if (response.status !== 206 && !wholeSmallObject) {
      await response.body?.cancel();
      return null;
    }
    if (response.status === 206) {
      const contentRange = response.headers.get("content-range");
      if (contentRange !== `bytes ${start}-${end}/${byteSize}`) {
        await response.body?.cancel();
        return null;
      }
    }
    return readExactly(response.body, expectedLength);
  });
}

async function readExactly(body: ReadableStream<Uint8Array> | null, expectedLength: number): Promise<Uint8Array | null> {
  if (!body) return null;
  const reader = body.getReader();
  const output = new Uint8Array(expectedLength);
  let offset = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || offset + value.length > expectedLength) {
        await reader.cancel();
        return null;
      }
      output.set(value, offset);
      offset += value.length;
    }
    return offset === expectedLength ? output : null;
  } catch {
    await reader.cancel().catch(() => undefined);
    return null;
  } finally {
    reader.releaseLock();
  }
}
