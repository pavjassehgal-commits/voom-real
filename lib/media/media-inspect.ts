/**
 * Server-side inspection of GENERATED media bytes.
 *
 * Provider response metadata (declared mime, size, duration) is never trusted.
 * Before generated output becomes a draft asset, its bytes are sniffed and
 * measured here:
 *
 *   - image: signature + real width/height (PNG IHDR, JPEG SOFn, WebP VP8*)
 *   - video: ISO-BMFF structure + real track width/height and duration
 *     (moov/mvhd + the first video trak's tkhd/mdhd), so an MP4 that is
 *     actually a text file or has a 2:3 aspect cannot be attached to a 9:16
 *     draft.
 *
 * The module is pure and dependency-free so it can be unit tested with
 * hand-built byte fixtures.
 */

export interface ImageInspection {
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  width: number;
  height: number;
}

export interface VideoInspection {
  mimeType: "video/mp4";
  width: number;
  height: number;
  durationSeconds: number;
}

// ---------------------------------------------------------------------------
// Images
// ---------------------------------------------------------------------------

export function inspectImageBytes(bytes: Uint8Array): ImageInspection | null {
  const png = inspectPng(bytes);
  if (png) return png;
  const jpeg = inspectJpeg(bytes);
  if (jpeg) return jpeg;
  const webp = inspectWebp(bytes);
  if (webp) return webp;
  return null;
}

function inspectPng(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 24) return null;
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (!signature.every((value, index) => bytes[index] === value)) return null;
  if (ascii(bytes, 12, 16) !== "IHDR") return null;
  const width = readUint32Be(bytes, 16);
  const height = readUint32Be(bytes, 20);
  if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
  return { mimeType: "image/png", width, height };
}

function inspectJpeg(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    // SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      const height = readUint16Be(bytes, offset + 5);
      const width = readUint16Be(bytes, offset + 7);
      if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
      return { mimeType: "image/jpeg", width, height };
    }
    const length = readUint16Be(bytes, offset + 2);
    if (length < 2) return null;
    offset += 2 + length;
  }
  return null;
}

function inspectWebp(bytes: Uint8Array): ImageInspection | null {
  if (bytes.length < 30) return null;
  if (ascii(bytes, 0, 4) !== "RIFF" || ascii(bytes, 8, 12) !== "WEBP") return null;
  const format = ascii(bytes, 12, 16);
  if (format === "VP8 ") {
    const width = readUint16Le(bytes, 26) & 0x3fff;
    const height = readUint16Le(bytes, 28) & 0x3fff;
    if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
    return { mimeType: "image/webp", width, height };
  }
  if (format === "VP8L") {
    const b0 = bytes[21];
    const b1 = bytes[22];
    const b2 = bytes[23];
    const b3 = bytes[24];
    const width = 1 + (((b1 & 0x3f) << 8) | b0);
    const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | (b1 >> 6));
    if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
    return { mimeType: "image/webp", width, height };
  }
  if (format === "VP8X") {
    const width = 1 + readUint24Le(bytes, 24);
    const height = 1 + readUint24Le(bytes, 27);
    if (!isSaneDimension(width) || !isSaneDimension(height)) return null;
    return { mimeType: "image/webp", width, height };
  }
  return null;
}

function isSaneDimension(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 16 && value <= 16384;
}

// ---------------------------------------------------------------------------
// Video (ISO-BMFF / MP4)
// ---------------------------------------------------------------------------

/**
 * Parses a structurally valid MP4: signature (already enforced by the
 * caller via detectReelAsset), moov/mvhd for duration, and the first video
 * trak (hdlr type "vide") for track width/height. Returns null when the
 * container is not parseable — callers treat that as an invalid output.
 */
export function inspectVideoBytes(bytes: Uint8Array): VideoInspection | null {
  if (bytes.length < 32) return null;
  if (ascii(bytes, 4, 8) !== "ftyp") return null;

  let containerDuration: number | null = null;
  let track: { width: number; height: number; duration: number | null } | null = null;

  const moov = findBox(bytes, 0, bytes.length, "moov");
  if (!moov) return null;

  const mvhd = findBox(bytes, moov.start, moov.end, "mvhd");
  if (mvhd) {
    // mvhd v0: version(1) flags(3) creation(4) modification(4) timescale(4) duration(4).
    // mvhd v1: the two timestamps are 8 bytes, so timescale shifts to +20 and
    // duration to +24 (8 bytes).
    const timescale = mvhd.version === 1 ? readUint32Be(bytes, mvhd.payloadStart + 20) : readUint32Be(bytes, mvhd.payloadStart + 12);
    const duration = mvhd.version === 1 ? readUint64Be(bytes, mvhd.payloadStart + 24) : readUint32Be(bytes, mvhd.payloadStart + 16);
    if (timescale > 0) containerDuration = duration / timescale;
  }

  let trakOffset = moov.start;
  while (trakOffset < moov.end) {
    const trak = readBoxHeader(bytes, trakOffset, moov.end);
    if (!trak) break;
    if (trak.type === "trak") {
      const mdia = findBox(bytes, trak.start, trak.end, "mdia");
      if (mdia) {
        const hdlr = findBox(bytes, mdia.start, mdia.end, "hdlr");
        // hdlr payload: version(1) flags(3) predefined(4) handler_type(4).
        const handlerType = hdlr ? ascii(bytes, hdlr.start + 8, hdlr.start + 12) : "";
        if (handlerType === "vide") {
          const tkhd = findBox(bytes, trak.start, trak.end, "tkhd");
          const mdhd = findBox(bytes, mdia.start, mdia.end, "mdhd");
          // tkhd keeps width/height (16.16 fixed point) as the second-to-last
          // 8 bytes of the box: the final 8 bytes are reserved.
          if (tkhd && tkhd.end - tkhd.start >= 20) {
            // tkhd keeps width/height (16.16 fixed point) as the FINAL 8 bytes
            // of the box (both v0 and v1): width at end-8, height at end-4.
            const width = Math.floor(readUint32Be(bytes, tkhd.end - 8) / 0x10000);
            const height = Math.floor(readUint32Be(bytes, tkhd.end - 4) / 0x10000);
            let duration: number | null = null;
            if (mdhd) {
              // mdhd v0: version(1) flags(3) creation(4) modification(4)
              // timescale(4) duration(4); v1 timestamps are 8 bytes each.
              const timescale = mdhd.version === 1 ? readUint32Be(bytes, mdhd.payloadStart + 20) : readUint32Be(bytes, mdhd.payloadStart + 12);
              const raw = mdhd.version === 1 ? readUint64Be(bytes, mdhd.payloadStart + 24) : readUint32Be(bytes, mdhd.payloadStart + 16);
              if (timescale > 0) duration = raw / timescale;
            }
            if (isSaneDimension(width) && isSaneDimension(height)) {
              track = { width, height, duration };
              break;
            }
          }
        }
      }
    }
    trakOffset = trak.end;
  }

  if (!track) return null;
  const durationSeconds = track.duration ?? containerDuration;
  if (durationSeconds === null || !Number.isFinite(durationSeconds) || durationSeconds <= 0) return null;
  return { mimeType: "video/mp4", width: track.width, height: track.height, durationSeconds };
}

interface BoxSpan {
  /** Payload start (right after the 8-byte box header). */
  start: number;
  /** End of the box (payload end). */
  end: number;
  type: string;
  /** Full-box version byte, or -1 for boxes without a version field. */
  version: number;
  /** Same as `start`; named for readability at mvhd/mdhd read sites. */
  payloadStart: number;
}

function readBoxHeader(bytes: Uint8Array, offset: number, limit: number): BoxSpan | null {
  if (offset + 8 > limit) return null;
  const size = readUint32Be(bytes, offset);
  const type = ascii(bytes, offset + 4, offset + 8);
  if (!isPrintableType(type)) return null;
  if (size === 1) return null; // 64-bit box sizes are not expected here.
  const end = size === 0 ? limit : offset + size; // 0: box runs to the end of its container
  if (size < 8 || end > limit || end <= offset) return null;
  const start = offset + 8;
  const version = start + 1 < end ? bytes[start] : -1;
  return { start, end, type, version, payloadStart: start };
}

/** Finds a direct child box; the span's start points at the first child's header. */
function findBox(bytes: Uint8Array, start: number, end: number, type: string): BoxSpan | null {
  let offset = start;
  while (offset < end) {
    const header = readBoxHeader(bytes, offset, end);
    if (!header) return null;
    if (header.type === type) return header;
    offset = header.end; // containers and other children are skipped, never descended into
  }
  return null;
}

function isPrintableType(type: string): boolean {
  if (type.length !== 4) return false;
  for (let i = 0; i < 4; i++) {
    const code = type.charCodeAt(i);
    if (code < 0x20 || code > 0x7e) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Aspect + duration checks (deterministic, format-banded)
// ---------------------------------------------------------------------------

export interface AspectBand {
  /** Minimum acceptable width/height ratio. */
  min: number;
  /** Maximum acceptable width/height ratio. */
  max: number;
}

/**
 * Acceptable width:height ratio bands per target format. The bands accept the
 * exact ratio plus the crop-safe equivalents the providers can emit (e.g. a
 * 2:3 image standing in for a 4:5 post), while still rejecting a landscape
 * frame on a vertical draft.
 */
export const ASPECT_BANDS: Record<string, AspectBand> = {
  "1:1": { min: 0.85, max: 1.18 },
  "4:5": { min: 0.58, max: 0.9 },
  "9:16": { min: 0.48, max: 0.72 },
  "16:9": { min: 1.38, max: 1.78 },
};

export function aspectMatches(width: number, height: number, target: string): boolean {
  const band = ASPECT_BANDS[target];
  if (!band || width <= 0 || height <= 0) return false;
  const ratio = width / height;
  return ratio >= band.min && ratio <= band.max;
}

export function durationMatches(durationSeconds: number, minSeconds: number, maxSeconds: number): boolean {
  return Number.isFinite(durationSeconds) && durationSeconds >= minSeconds && durationSeconds <= maxSeconds;
}

// ---------------------------------------------------------------------------
// Binary readers (multiplication, not bit shifts — keeps 32-bit reads safe)
// ---------------------------------------------------------------------------

function readUint32Be(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3];
}

function readUint64Be(bytes: Uint8Array, offset: number): number {
  const high = readUint32Be(bytes, offset);
  const low = readUint32Be(bytes, offset + 4);
  return high * 0x100000000 + low;
}

function readUint16Be(bytes: Uint8Array, offset: number): number {
  return bytes[offset] * 0x100 + bytes[offset + 1];
}

function readUint16Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100;
}

function readUint24Le(bytes: Uint8Array, offset: number): number {
  return bytes[offset] + bytes[offset + 1] * 0x100 + bytes[offset + 2] * 0x10000;
}

function ascii(bytes: Uint8Array, start: number, end: number): string {
  let out = "";
  for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i] ?? 0);
  return out;
}
