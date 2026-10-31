import { YOUTUBE_TUS_CHUNK_BYTES } from "./upload-rules.ts";

export interface BrowserUpload {
  id:string;name:string;size:number;fingerprint:string;status:string;expiresAt:string;
}
export class BrowserUploadError extends Error { code?:string;constructor(message:string,code?:string){super(message);this.code=code;} }
export async function uploadRequest(draft:string,body:Record<string,unknown>) {
  const response=await fetch(`/api/posts/${draft}/video-upload`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
  const data=await response.json();
  if(!response.ok)throw new BrowserUploadError(data.error??"Upload could not be confirmed. Check its status before retrying.",data.code);
  return data;
}
export async function uploadStatus(draft:string,id?:string):Promise<{upload:BrowserUpload|null;maxBytes:number}> {
  const response=await fetch(`/api/posts/${draft}/video-upload${id?`?uploadId=${id}`:""}`,{cache:"no-store"});
  const data=await response.json();if(!response.ok)throw new BrowserUploadError(data.error??"Upload status is unavailable.",data.code);
  // The server's effective limit; never fall back to a larger one.
  if(!Number.isSafeInteger(data.maxBytes) || data.maxBytes<1)throw new BrowserUploadError("Upload status is unavailable.");
  return {upload:data.upload,maxBytes:data.maxBytes};
}
/** Hash the complete file in bounded chunks. A renamed file with the same
 * bytes is safe to resume; a changed middle chunk is NOT. The server still
 * independently validates stored metadata and does not trust this digest.
 */
export async function uploadFingerprint(file:File):Promise<string> {
  const {sha256}=await import("@noble/hashes/sha2.js");
  const hash=sha256.create();
  for(let start=0;start<file.size;start+=1024*1024)hash.update(new Uint8Array(await file.slice(start,start+1024*1024).arrayBuffer()));
  return Array.from(hash.digest(),b=>b.toString(16).padStart(2,"0")).join("");
}
export function tusUploadOptions(input:{
  session:BrowserUpload;authorization:{token:string;endpoint:string;bucket:string;path:string};publishableKey:string;
  onProgress:(sent:number,total:number)=>void;onSuccess:()=>void;onError:(error:Error)=>void;
}) {
  const origin=new URL(input.authorization.endpoint).origin;
  // Hosted Storage requires the project's PUBLIC key beside the signed token.
  if(!input.publishableKey)throw new BrowserUploadError("Large-video uploads aren't configured here yet.");
  return {
    endpoint:input.authorization.endpoint,headers:{apikey:input.publishableKey,"x-signature":input.authorization.token},
    metadata:{bucketName:input.authorization.bucket,objectName:input.authorization.path,contentType:"video/mp4",cacheControl:"3600"},
    chunkSize:YOUTUBE_TUS_CHUNK_BYTES,uploadDataDuringCreation:true,removeFingerprintOnSuccess:true,
    retryDelays:[0,1000,3000,5000],
    fingerprint:async()=>`voom-youtube:${origin}:${input.session.id}:${input.session.fingerprint}`,
    onBeforeRequest:(request:{getURL:()=>string})=>{
      const url=new URL(request.getURL());
      if(url.origin!==origin || !url.pathname.startsWith("/storage/v1/upload/resumable"))throw Error("Unexpected upload destination.");
    },
    onProgress:input.onProgress,onSuccess:input.onSuccess,onError:input.onError,
  };
}
