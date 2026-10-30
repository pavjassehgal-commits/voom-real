import { inspectVideoBytes, type VideoInspection } from "../media/media-inspect.ts";
import { detectPostAsset } from "../post/asset.ts";
import { YOUTUBE_DIRECT_UPLOAD_MAX_BYTES } from "./upload-rules.ts";

/** Bounded MP4 inspection: skip mdat via offsets, read moov, reuse our parser.
 * This validates container structure/track metadata, not every decoded frame.
 */
export async function inspectYouTubeUpload(
  size: number, name: string, read: (start: number, end: number) => Promise<Uint8Array>,
): Promise<VideoInspection> {
  if (!Number.isSafeInteger(size) || size < 32 || size > YOUTUBE_DIRECT_UPLOAD_MAX_BYTES) throw Error("invalid_video");
  let offset = 0, ftyp: Uint8Array | null = null, moov: Uint8Array | null = null, mdat = false;
  for (let boxes = 0; offset < size; boxes++) {
    if (boxes >= 256 || size-offset < 8) throw Error("invalid_video");
    const head = await read(offset, Math.min(offset+15,size-1));
    if (head.length < 8) throw Error("invalid_video");
    const v = new DataView(head.buffer,head.byteOffset,head.byteLength);
    const small = v.getUint32(0), type = String.fromCharCode(...head.slice(4,8));
    const length = small === 1 ? (head.length < 16 ? NaN : Number(v.getBigUint64(8))) : small === 0 ? size-offset : small;
    const header = small === 1 ? 16 : 8;
    if (!Number.isSafeInteger(length) || length < header || offset+length>size || !/^[\x20-\x7e]{4}$/.test(type)) throw Error("invalid_video");
    if (offset===0 && type!=="ftyp") throw Error("invalid_video");
    if (type==="ftyp") {
      if (ftyp || length>4096) throw Error("invalid_video");
      ftyp = await read(offset,offset+length-1);
      if (detectPostAsset(ftyp,name)?.mimeType!=="video/mp4") throw Error("invalid_video");
    } else if (type==="moov") {
      // Bound validation memory/egress even for hostile metadata boxes.
      if (moov || length>8*1024*1024) throw Error("video_metadata_too_large");
      moov = await read(offset,offset+length-1);
    } else if (type==="mdat" && length>header) mdat = true;
    offset += length;
  }
  if (!ftyp || !moov || !mdat) throw Error("invalid_video");
  const metadata = new Uint8Array(ftyp.length+moov.length);metadata.set(ftyp);metadata.set(moov,ftyp.length);
  const info = inspectVideoBytes(metadata);
  if (!info || info.durationSeconds>12*60*60) throw Error("invalid_video");
  return info;
}

export async function readPrivateVideoRange(url: string, start: number, end: number): Promise<Uint8Array> {
  const response = await fetch(url,{headers:{Range:`bytes=${start}-${end}`},signal:AbortSignal.timeout(15_000),cache:"no-store",redirect:"error"});
  if (response.status!==206 || !response.body || !response.headers.get("content-range")?.startsWith(`bytes ${start}-${end}/`)) {
    await response.body?.cancel();throw Error("video_validation_unavailable");
  }
  const reader = response.body.getReader(), chunks: Uint8Array[]=[];let length=0;
  try {
    while (true) {
      const {done,value}=await reader.read();if(done)break;
      length+=value.length;if(length>end-start+1)throw Error("video_validation_unavailable");chunks.push(value);
    }
    if(length!==end-start+1)throw Error("video_validation_unavailable");
    const out=new Uint8Array(length);let offset=0;for(const chunk of chunks){out.set(chunk,offset);offset+=chunk.length;}return out;
  } finally { await reader.cancel().catch(()=>undefined); }
}
