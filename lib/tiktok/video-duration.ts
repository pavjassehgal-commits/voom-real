import { inspectVideoBytes } from "../media/media-inspect";

/** Browser metadata is advisory only; the stored bytes are authoritative. */
export const TIKTOK_DURATION_MATCH_TOLERANCE_SECONDS = 0.5;
/** Metadata reads are bounded independently of the stored video's size. */
export const TIKTOK_MAX_METADATA_BOX_BYTES = 4 * 1024 * 1024;
const TIKTOK_MAX_TOP_LEVEL_BOXES = 128;
const TIKTOK_MAX_FTYP_BYTES = 64 * 1024;

export type TikTokVideoRangeReader = (start: number, end: number) => Promise<Uint8Array | null>;

export type TikTokDurationValidation =
  | { ok: true; durationSeconds: number }
  | { ok: false; code: "video_duration_unavailable" | "video_duration_mismatch" | "video_too_long" };

export function inspectTikTokVideoDuration(bytes: Uint8Array): number | null {
  const inspected = inspectVideoBytes(bytes);
  return inspected && Number.isFinite(inspected.durationSeconds) && inspected.durationSeconds > 0
    ? inspected.durationSeconds
    : null;
}

interface TopLevelBox {
  type: string;
  size: number;
}

/**
 * Reads only the MP4 file type and movie-metadata boxes. A potentially huge
 * `mdat` payload is skipped using its box length, so TikTok validation never
 * needs to hold the stored video in function memory. Malformed, fragmented or
 * unusually large metadata fails closed.
 */
export async function inspectTikTokVideoDurationFromRanges(
  byteSize: number,
  readRange: TikTokVideoRangeReader,
): Promise<number | null> {
  if (!Number.isSafeInteger(byteSize) || byteSize < 32) return null;

  let offset = 0;
  let ftyp: { offset: number; size: number } | null = null;
  let moov: { offset: number; size: number } | null = null;

  for (let count = 0; count < TIKTOK_MAX_TOP_LEVEL_BOXES && offset + 8 <= byteSize; count += 1) {
    const headerEnd = Math.min(byteSize - 1, offset + 15);
    const header = await readRange(offset, headerEnd);
    if (!header || header.length !== headerEnd - offset + 1) return null;
    const box = readTopLevelBox(header, byteSize - offset);
    if (!box || offset + box.size > byteSize) return null;

    if (offset === 0 && box.type !== "ftyp") return null;
    if (box.type === "ftyp") {
      if (ftyp || box.size > TIKTOK_MAX_FTYP_BYTES) return null;
      ftyp = { offset, size: box.size };
    } else if (box.type === "moov") {
      if (box.size > TIKTOK_MAX_METADATA_BOX_BYTES) return null;
      moov = { offset, size: box.size };
      break;
    }
    offset += box.size;
  }

  if (!ftyp || !moov) return null;
  const [ftypBytes, moovBytes] = await Promise.all([
    readRange(ftyp.offset, ftyp.offset + ftyp.size - 1),
    readRange(moov.offset, moov.offset + moov.size - 1),
  ]);
  if (!ftypBytes || ftypBytes.length !== ftyp.size || !moovBytes || moovBytes.length !== moov.size) return null;

  const metadata = new Uint8Array(ftypBytes.length + moovBytes.length);
  metadata.set(ftypBytes, 0);
  metadata.set(moovBytes, ftypBytes.length);
  return inspectTikTokVideoDuration(metadata);
}

function readTopLevelBox(header: Uint8Array, remainingBytes: number): TopLevelBox | null {
  if (header.length < 8) return null;
  const type = String.fromCharCode(header[4], header[5], header[6], header[7]);
  if (!/^[\x20-\x7e]{4}$/.test(type)) return null;
  const shortSize = readUint32(header, 0);
  let size: number;
  if (shortSize === 0) {
    size = remainingBytes;
  } else if (shortSize === 1) {
    if (header.length < 16) return null;
    const high = readUint32(header, 8);
    const low = readUint32(header, 12);
    size = high * 0x100000000 + low;
  } else {
    size = shortSize;
  }
  const minimum = shortSize === 1 ? 16 : 8;
  return Number.isSafeInteger(size) && size >= minimum ? { type, size } : null;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

export function validateTikTokVideoDuration(input: {
  trustedDurationSeconds: number | null;
  reportedDurationSeconds?: number | null;
  maxDurationSeconds: number | null;
}): TikTokDurationValidation {
  const trusted = input.trustedDurationSeconds;
  const maximum = input.maxDurationSeconds;
  if (typeof trusted !== "number" || !Number.isFinite(trusted) || trusted <= 0
      || typeof maximum !== "number" || !Number.isFinite(maximum) || maximum <= 0) {
    return { ok: false, code: "video_duration_unavailable" };
  }
  if (input.reportedDurationSeconds !== undefined) {
    const reported = input.reportedDurationSeconds;
    if (typeof reported !== "number" || !Number.isFinite(reported) || reported <= 0
        || Math.abs(reported - trusted) > TIKTOK_DURATION_MATCH_TOLERANCE_SECONDS) {
      return { ok: false, code: "video_duration_mismatch" };
    }
  }
  if (trusted > maximum) return { ok: false, code: "video_too_long" };
  return { ok: true, durationSeconds: trusted };
}
