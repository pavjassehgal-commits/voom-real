// Deterministic resizes only: never redraw, recolor or replace the official mark.
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import sharp from "sharp";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("public/brand/voom-app-icon-e73c1c43.png", root));
if (createHash("sha256").update(source).digest("hex") !== "e73c1c43f3eaf724e2b9016b35693874908dd7087f1fac99bf808188ac0c20be") {
  throw new Error("Official source icon changed: confirm TikTok's approved artwork before regenerating.");
}
const png = size => sharp(source).resize(size, size).png().toBuffer();
await writeFile(new URL("app/icon.png", root), await png(64));
await writeFile(new URL("app/apple-icon.png", root), await png(180));
const sizes = [16, 32, 48, 64];
// Turbopack's ICO decoder requires RGBA PNG frames, even for opaque artwork.
const frames = await Promise.all(sizes.map(size => sharp(source).resize(size, size).ensureAlpha().png().toBuffer()));
const header = Buffer.alloc(6 + sizes.length * 16);
header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
let offset = header.length;
for (let i = 0; i < frames.length; i++) {
  const entry = 6 + i * 16;
  header[entry] = sizes[i]; header[entry + 1] = sizes[i];
  header.writeUInt16LE(1, entry + 4); header.writeUInt16LE(32, entry + 6);
  header.writeUInt32LE(frames[i].length, entry + 8); header.writeUInt32LE(offset, entry + 12);
  offset += frames[i].length;
}
await writeFile(new URL("app/favicon.ico", root), Buffer.concat([header, ...frames]));
