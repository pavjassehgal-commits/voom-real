/**
 * Byte-level media validation for MARA generated output.
 *
 * Provider response metadata is never trusted: the bytes themselves are
 * sniffed and measured. These tests build REAL container bytes (PNG, JPEG,
 * WebP VP8/VP8L/VP8X, ISO-BMFF MP4 v0 and v1 headers) and verify the
 * inspector reads them per the format specifications — and rejects anything
 * that is not actually that format.
 */
import "./helpers/server-only-shim.mjs";
import assert from "node:assert/strict";
import test from "node:test";

const insp = await import("../lib/media/media-inspect.ts");
const plan = await import("../lib/mara/media-plan.ts");

// ---------------------------------------------------------------------------
// Fixture builders (hand-rolled, spec-compliant container bytes)
// ---------------------------------------------------------------------------

const U32 = (v) => { const b = Buffer.alloc(4); b.writeUInt32BE(v >>> 0); return b; };
const U32LE = (v) => { const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0); return b; };
const U16BE = (v) => { const b = Buffer.alloc(2); b.writeUInt16BE(v); return b; };
const U16LE = (v) => { const b = Buffer.alloc(2); b.writeUInt16LE(v & 0xffff); return b; };

function png(width, height) {
  // 8-byte signature + IHDR chunk (length 13, width, height, depth, color, comp, filter, interlace)
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    U32(13), Buffer.from("IHDR", "ascii"), U32(width), U32(height),
    Buffer.from([8, 2, 0, 0, 0]),
    Buffer.alloc(16),
  ]);
}

function jpeg(width, height) {
  // SOI, APP0 (JFIF: 14-byte payload), SOF0 with the dimensions, EOI.
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    Buffer.from([0xff, 0xe0]), U16BE(16), Buffer.from("JFIF\0", "binary"), Buffer.from([1, 1, 0, 0x48, 0, 0x48, 0, 0, 0]),
    Buffer.from([0xff, 0xc0]), U16BE(17), Buffer.from([8]), U16BE(height), U16BE(width), Buffer.from([3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

function webpVp8(width, height) {
  // RIFF header + "VP8 " chunk. The VP8 key-frame header carries the 14-bit
  // LE width at file offset 26 and the 14-bit LE height at 28.
  const data = Buffer.concat([
    Buffer.from([0x9d, 0x01, 0x2a]), // start code
    U16LE(0),                        // frame tag
    Buffer.from([0]),                // first visible segment
    U16LE(width & 0x3fff), U16LE(height & 0x3fff),
    Buffer.alloc(8),
  ]);
  const riff = Buffer.concat([
    Buffer.from("RIFF", "ascii"), U32LE(4 + 8 + data.length), Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8 ", "ascii"), U32LE(data.length), data,
  ]);
  return riff;
}

function webpVp8x(width, height) {
  // Extended format: 4-byte feature flags, then 3-byte LE (width-1) at file
  // offset 24 and 3-byte LE (height-1) at 27.
  const w = Buffer.alloc(3); w.writeUIntLE(width - 1, 0, 3);
  const h = Buffer.alloc(3); h.writeUIntLE(height - 1, 0, 3);
  const data = Buffer.concat([Buffer.alloc(4), w, h]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"), U32LE(4 + 8 + data.length), Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8X", "ascii"), U32LE(data.length), data,
  ]);
}

function webpVp8l(width, height) {
  // Lossless: signature 0x2F at 20, then a 28-bit canvas:
  // bits 0-13 = width-1, bits 14-27 = height-1 (little-endian byte order).
  const canvas = (width - 1) | ((height - 1) << 14);
  const data = Buffer.concat([Buffer.from([0x2f]), U32LE(canvas), Buffer.alloc(5)]);
  return Buffer.concat([
    Buffer.from("RIFF", "ascii"), U32LE(4 + 8 + data.length), Buffer.from("WEBP", "ascii"),
    Buffer.from("VP8L", "ascii"), U32LE(data.length), data,
  ]);
}

function box(type, payload) {
  return Buffer.concat([U32(8 + payload.length), Buffer.from(type, "ascii"), payload]);
}

/**
 * A structurally valid minimal MP4: ftyp + moov(mvhd + trak(mdia(hdlr,mdhd),
 * tkhd)) + mdat filler. ISO-BMFF offsets per ISO/IEC 14496-12:
 *   mvhd/mdhd v0: version(1) flags(3) creation(4) modification(4) timescale(4) duration(4)
 *   mvhd/mdhd v1: the timestamps are 8 bytes (timescale +20, duration +24)
 *   tkhd: width and height (16.16 fixed point) are the FINAL 8 bytes of the box.
 */
function mp4({ width = 1080, height = 1920, durationSeconds = 8, timescale = 1000, mvhdVersion = 0, handler = "vide" } = {}) {
  const ftyp = box("ftyp", Buffer.concat([Buffer.from("isom", "ascii"), U32(0x200)]));
  const durationUnits = Math.round(durationSeconds * timescale);
  const mvhdPayload = mvhdVersion === 1
    ? Buffer.concat([Buffer.from([1, 0, 0, 0]), U32(0), U32(0), U32(0), U32(0), U32(timescale), U32(0), U32(durationUnits)])
    : Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(durationUnits)]);
  const mvhd = box("mvhd", mvhdPayload);
  const hdlr = box("hdlr", Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), Buffer.from(handler, "ascii")]));
  const mdhdPayload = mvhdVersion === 1
    ? Buffer.concat([Buffer.from([1, 0, 0, 0]), U32(0), U32(0), U32(0), U32(0), U32(timescale), U32(0), U32(durationUnits)])
    : Buffer.concat([Buffer.from([0, 0, 0, 0]), U32(0), U32(0), U32(timescale), U32(durationUnits)]);
  const mdhd = box("mdhd", mdhdPayload);
  const mdia = box("mdia", Buffer.concat([hdlr, mdhd]));
  const tkhdPayload = Buffer.alloc(24);
  U32(1).copy(tkhdPayload, 8); // track id (fields the parser skips)
  U32(width << 16).copy(tkhdPayload, tkhdPayload.length - 8);
  U32(height << 16).copy(tkhdPayload, tkhdPayload.length - 4);
  const trak = box("trak", Buffer.concat([mdia, box("tkhd", tkhdPayload)]));
  const moov = box("moov", Buffer.concat([mvhd, trak]));
  return Buffer.concat([ftyp, moov, Buffer.from("mdat-filler-payload")]);
}

// ---------------------------------------------------------------------------
// Images: signature + real dimensions
// ---------------------------------------------------------------------------

test("PNG: reads the real width and height from IHDR", () => {
  assert.deepEqual(insp.inspectImageBytes(new Uint8Array(png(100, 120))), { mimeType: "image/png", width: 100, height: 120 });
});

test("JPEG: reads the real dimensions from the SOF0 marker", () => {
  assert.deepEqual(insp.inspectImageBytes(new Uint8Array(jpeg(1080, 1350))), { mimeType: "image/jpeg", width: 1080, height: 1350 });
});

test("WebP: reads 14-bit LE dimensions for VP8, VP8X and VP8L", () => {
  assert.deepEqual(insp.inspectImageBytes(new Uint8Array(webpVp8(1080, 1920))), { mimeType: "image/webp", width: 1080, height: 1920 });
  assert.deepEqual(insp.inspectImageBytes(new Uint8Array(webpVp8x(720, 1280))), { mimeType: "image/webp", width: 720, height: 1280 });
  assert.deepEqual(insp.inspectImageBytes(new Uint8Array(webpVp8l(100, 180))), { mimeType: "image/webp", width: 100, height: 180 });
});

test("image bytes that are not a supported image are rejected", () => {
  assert.equal(insp.inspectImageBytes(new Uint8Array(Buffer.from("RIFF....WEBPVP8 "))), null);
  assert.equal(insp.inspectImageBytes(new Uint8Array(png(100, 120).subarray(0, 20))), null, "truncated PNG");
  assert.equal(insp.inspectImageBytes(new Uint8Array(jpeg(10, 20000))), null, "out-of-range dimensions");
  assert.equal(insp.inspectImageBytes(new Uint8Array(png(5, 100))), null, "below sane minimum");
  assert.equal(insp.inspectImageBytes(new Uint8Array(Buffer.from("plain text, not an image at all"))), null);
});

// ---------------------------------------------------------------------------
// Video: ISO-BMFF structure, real track dimensions and duration
// ---------------------------------------------------------------------------

test("MP4 v0: reads the real track size and container duration", () => {
  assert.deepEqual(insp.inspectVideoBytes(new Uint8Array(mp4())), {
    mimeType: "video/mp4", width: 1080, height: 1920, durationSeconds: 8,
  });
});

test("MP4 v1 (64-bit timestamps): reads the real size and duration", () => {
  assert.deepEqual(insp.inspectVideoBytes(new Uint8Array(mp4({ mvhdVersion: 1, durationSeconds: 12, timescale: 10000 }))), {
    mimeType: "video/mp4", width: 1080, height: 1920, durationSeconds: 12,
  });
});

test("MP4: a non-9:16 frame keeps its real dimensions (the band check rejects it later)", () => {
  const inspection = insp.inspectVideoBytes(new Uint8Array(mp4({ width: 1920, height: 1080 })));
  assert.equal(inspection.width, 1920);
  assert.equal(inspection.height, 1080);
  assert.equal(insp.aspectMatches(inspection.width, inspection.height, "9:16"), false);
});

test("MP4 containers that are not structurally valid are rejected", () => {
  const valid = mp4();
  assert.equal(insp.inspectVideoBytes(new Uint8Array(valid.subarray(0, 16))), null, "no moov");
  assert.equal(insp.inspectVideoBytes(new Uint8Array(mp4({ handler: "soun" }))), null, "audio-only track");
  assert.equal(insp.inspectVideoBytes(new Uint8Array(Buffer.from("definitely not an mp4 file, just text"))), null);
  assert.equal(insp.inspectVideoBytes(new Uint8Array(Buffer.alloc(20))), null, "too small");
});

// ---------------------------------------------------------------------------
// Deterministic aspect + duration bands
// ---------------------------------------------------------------------------

test("aspect bands accept the target ratio and crop-safe equivalents, reject landscape", () => {
  assert.equal(insp.aspectMatches(1080, 1080, "1:1"), true);
  assert.equal(insp.aspectMatches(1080, 1350, "4:5"), true);
  assert.equal(insp.aspectMatches(1080, 1920, "9:16"), true);
  assert.equal(insp.aspectMatches(1920, 1080, "9:16"), false, "landscape on a vertical draft");
  assert.equal(insp.aspectMatches(1080, 1080, "9:16"), false, "square on a vertical draft");
  assert.equal(insp.aspectMatches(0, 1080, "9:16"), false, "zero width");
  assert.equal(insp.aspectMatches(1080, 1920, "nope"), false, "unknown target");
});

test("duration checks are inclusive of their bounds", () => {
  assert.equal(insp.durationMatches(4, 4, 15), true);
  assert.equal(insp.durationMatches(15, 4, 15), true);
  assert.equal(insp.durationMatches(15.01, 4, 15), false);
  assert.equal(insp.durationMatches(3.99, 4, 15), false);
  assert.equal(insp.durationMatches(Number.NaN, 4, 15), false);
});

// ---------------------------------------------------------------------------
// MARA's structured plan: the provider prompt is kept separate from user copy
// ---------------------------------------------------------------------------

test("the reel plan schema bounds duration to 4-15s and requires overlay copy", () => {
  const ok = {
    concept: "Summer fitting tip",
    visualObjective: "Show the fit in one clean vertical frame.",
    visualPrompt: "A bright boutique rack with a summer dress on a mannequin, soft morning light, 9:16 vertical, no text.",
    motionDirection: "Slow push-in toward the dress, gentle parallax.",
    overlayCopy: { hook: "Fit check before the heatwave", message: "One dress, three ways to style it", value: "Real looks for real weekends", cta: "Save this reel" },
    cta: "Save this reel",
    durationSeconds: 8,
  };
  assert.doesNotThrow(() => plan.reelVideoPlanSchema.parse(ok));
  assert.throws(() => plan.reelVideoPlanSchema.parse({ ...ok, durationSeconds: 16 }), "reel over 15s");
  assert.throws(() => plan.reelVideoPlanSchema.parse({ ...ok, durationSeconds: 3 }), "reel under 4s");
  assert.throws(() => plan.reelVideoPlanSchema.parse({ ...ok, extra: "x" }), "unknown keys");
});

test("the deterministic post overlay renders a valid PNG and never mutates copy-less images", async () => {
  const sharp = (await import("sharp")).default;
  const overlay = await import("../lib/media/image-overlay.ts");
  const base = await sharp({ create: { width: 1080, height: 1350, channels: 3, background: { r: 200, g: 120, b: 60 } } }).png().toBuffer();
  const out = await overlay.applyPostOverlay({ bytes: new Uint8Array(base), mimeType: "image/png" }, { brandName: "Test Co", cta: "Book a fitting" });
  assert.equal(out.mimeType, "image/png");
  assert.deepEqual(insp.inspectImageBytes(out.bytes), { mimeType: "image/png", width: 1080, height: 1350 }, "the overlay keeps the canvas size");
  assert.equal(overlay.hasOverlayCopy({ brandName: "  ", cta: "" }), false);
  const unchanged = await overlay.applyPostOverlay({ bytes: new Uint8Array(base), mimeType: "image/png" }, { brandName: "", cta: "" });
  assert.equal(unchanged.mimeType, "image/png");
  assert.deepEqual(insp.inspectImageBytes(unchanged.bytes), { mimeType: "image/png", width: 1080, height: 1350 });
});

test("the story plan schema bounds duration to 3-15s and has no overlay copy", () => {
  const ok = {
    concept: "Story teaser",
    visualObjective: "Full-frame visual for the story.",
    visualPrompt: "Clean 9:16 frame with margin at the top and bottom, no text.",
    motionDirection: "Soft light change.",
    durationSeconds: 7,
  };
  assert.doesNotThrow(() => plan.storyVideoPlanSchema.parse(ok));
  assert.throws(() => plan.storyVideoPlanSchema.parse({ ...ok, durationSeconds: 2 }), "story under 3s");
  assert.throws(() => plan.storyVideoPlanSchema.parse({ ...ok, durationSeconds: 16 }), "story over 15s");
  assert.throws(() => plan.storyVideoPlanSchema.parse({ ...ok, overlayCopy: { hook: "x" } }), "stories carry no overlay copy");
});
