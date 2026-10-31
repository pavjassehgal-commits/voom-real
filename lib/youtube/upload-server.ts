import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { inspectYouTubeUpload, readPrivateVideoRange } from "./upload-inspect.ts";
import { YOUTUBE_UPLOAD_BUCKET } from "./upload-rules.ts";

export interface YouTubeUploadSession {
  id: string; owner_user_id: string | null; draft_id: string | null; content_version: number;
  storage_path: string; display_name: string; byte_size: number; fingerprint: string;
  status: string; expires_at: string; claim: string | null;
}
export class UploadError extends Error {
  code:string;
  status:number;
  constructor(code: string, status = 409) { super(code);this.code=code;this.status=status; }
}
export function publicUpload(u: YouTubeUploadSession) {
  return {id:u.id,name:u.display_name,size:Number(u.byte_size),fingerprint:u.fingerprint,status:u.status,expiresAt:u.expires_at};
}
export async function uploadRpc(db: SupabaseClient, name: string, args: Record<string,unknown>) {
  const {data,error}=await db.rpc(name,args);
  if(error) {
    const known=["upload_limit_reached","upload_already_pending","upload_provider_owned","upload_generation_active","upload_draft_changed","upload_unavailable","upload_expired","upload_validation_busy","upload_request_conflict","upload_owner_required","upload_invalid_file"];
    const code=known.find(x=>error.message===x);
    throw new UploadError(code??"upload_operation_unconfirmed",code==="upload_limit_reached"?429:code?409:503);
  }
  if(["begin_youtube_upload","authorize_youtube_upload","claim_youtube_upload_validation"].includes(name)) {
    const row=Array.isArray(data)?data[0]:data;
    if(!row || typeof row.id!=="string")throw new UploadError("upload_operation_unconfirmed",503);
    return row;
  }
  return data;
}
export async function loadUpload(db: SupabaseClient, owner: string, draft: string, id?: string): Promise<YouTubeUploadSession | null> {
  let query=db.from("youtube_upload_sessions").select("*").eq("owner_user_id",owner).eq("draft_id",draft);
  if(id)query=query.eq("id",id);
  else query=query.in("status",["pending","validating"]).order("created_at",{ascending:false}).limit(1);
  const {data,error}=await query.maybeSingle();
  if(error)throw new UploadError("upload_status_unavailable",503);
  return data as YouTubeUploadSession | null;
}

export async function authorizeUpload(db: SupabaseClient, owner: string, draft: string, id: string, projectUrl: string, maxBytes: number) {
  const u=await uploadRpc(db,"authorize_youtube_upload",{p_owner:owner,p_draft:draft,p_id:id}) as YouTubeUploadSession;
  // A session from a higher earlier limit gets no grant Storage would refuse.
  if(Number(u.byte_size)>maxBytes)throw new UploadError("upload_too_large",413);
  const bucket=await db.storage.getBucket(YOUTUBE_UPLOAD_BUCKET);
  if(bucket.error || bucket.data.public || Number(bucket.data.file_size_limit)!==256*1024*1024)throw new UploadError("upload_storage_not_ready",503);
  const {data,error}=await db.storage.from(YOUTUBE_UPLOAD_BUCKET).createSignedUploadUrl(u.storage_path,{upsert:false});
  if(error || !data?.token)throw new UploadError("upload_authorization_unavailable",503);
  // Storage owns/signs this capability. Enforce the documented two-hour TTL,
  // never synthesize signatures or return the service-role credential.
  let exp: number;
  try { exp=JSON.parse(Buffer.from(data.token.split(".")[1],"base64url").toString()).exp; }
  catch { throw new UploadError("upload_authorization_unavailable",503); }
  if(!Number.isSafeInteger(exp) || exp*1000<=Date.now() || exp*1000>Date.now()+7_230_000)throw new UploadError("upload_authorization_unavailable",503);
  const endpoint=new URL(projectUrl);
  if(endpoint.protocol!=="https:" || endpoint.username || endpoint.password)throw new UploadError("upload_storage_not_ready",503);
  if(endpoint.hostname.endsWith(".supabase.co") && !endpoint.hostname.endsWith(".storage.supabase.co"))endpoint.hostname=endpoint.hostname.replace(/\.supabase\.co$/,".storage.supabase.co");
  // Token-authorized TUS uploads use Storage's signed route; the plain
  // /upload/resumable route expects a user JWT and refuses x-signature alone.
  endpoint.pathname="/storage/v1/upload/resumable/sign";endpoint.search="";endpoint.hash="";
  return {upload:publicUpload(u),authorization:{token:data.token,expiresAt:new Date(exp*1000).toISOString(),endpoint:endpoint.toString(),bucket:YOUTUBE_UPLOAD_BUCKET,path:u.storage_path}};
}

/** Storage is immutable (no upsert). Validate exact stored bytes, not the
 * browser's dimensions/MIME/size. A lost final RPC response never deletes media.
 */
export async function completeUpload(db: SupabaseClient, owner: string, draft: string, id: string) {
  const u=await uploadRpc(db,"claim_youtube_upload_validation",{p_owner:owner,p_draft:draft,p_id:id}) as YouTubeUploadSession;
  if(u.status==="attached") {
    const {data,error}=await db.from("post_draft_assets").select("storage_path").eq("owner_user_id",owner).eq("draft_id",draft).maybeSingle();
    if(error)throw new UploadError("upload_operation_unconfirmed",503);
    if(data?.storage_path!==u.storage_path)throw new UploadError("upload_no_longer_current");
    return;
  }
  let finalizing=false;
  try {
    const storage=db.storage.from(YOUTUBE_UPLOAD_BUCKET);
    const object=await storage.info(u.storage_path);
    if(object.error || !object.data) {
      if(object.error && String(object.error.statusCode)==="404")throw new UploadError("upload_not_complete");
      throw new UploadError("video_validation_unavailable",503);
    }
    if(!Number.isSafeInteger(object.data.size) || !object.data.contentType)throw new UploadError("video_validation_unavailable",503);
    if(Number(object.data.size)!==Number(u.byte_size) || object.data.contentType!=="video/mp4")throw new UploadError("invalid_video",400);
    const signed=await storage.createSignedUrl(u.storage_path,300);
    if(signed.error || !signed.data?.signedUrl)throw new UploadError("video_validation_unavailable",503);
    const info=await inspectYouTubeUpload(Number(u.byte_size),u.display_name,(start,end)=>readPrivateVideoRange(signed.data.signedUrl,start,end));
    const {data:row,error}=await db.from("mara_drafts").select("kind").eq("owner_user_id",owner).eq("id",draft).maybeSingle();
    if(error || !row)throw new UploadError("upload_status_unavailable",503);
    if(row.kind==="youtube_short" && (info.width>info.height || info.durationSeconds>180))throw new UploadError("invalid_short",400);
    finalizing=true;
    const saved=await uploadRpc(db,"finish_youtube_upload",{p_owner:owner,p_draft:draft,p_id:id,p_claim:u.claim});
    if(saved!==true)throw new UploadError("upload_operation_unconfirmed",503);
  } catch(reason) {
    // Before finalization, release a lease for safe validation retry. After a
    // DB request, it may already be attached: do not cancel or remove anything.
    const invalid=reason instanceof Error && ["invalid_video","video_metadata_too_large"].includes(reason.message);
    if(!finalizing)await db.rpc("release_youtube_upload",{p_owner:owner,p_draft:draft,p_id:id,p_claim:u.claim,p_cancel:invalid || (reason instanceof UploadError && reason.status===400)});
    if(reason instanceof UploadError)throw reason;
    throw new UploadError(invalid?"invalid_video":"video_validation_unavailable",invalid?400:503);
  }
}

/** Existing authenticated YouTube reconcile cadence, no new worker schedule. */
export async function cleanupYouTubeUploads(db: SupabaseClient) {
  const rows=await uploadRpc(db,"claim_youtube_upload_cleanup",{p_limit:10}) as YouTubeUploadSession[];
  let removed=0;
  for(const row of rows) {
    if(!/^[a-f0-9-]{36}\/youtube-uploads\/[a-f0-9-]{36}\.mp4$/.test(row.storage_path))throw new UploadError("upload_cleanup_path_invalid",503);
    const result=await db.storage.from(YOUTUBE_UPLOAD_BUCKET).remove([row.storage_path]);
    const acknowledged=await uploadRpc(db,"finish_youtube_upload_cleanup",{p_id:row.id,p_claim:row.claim,p_success:!result.error});
    if(acknowledged!==true)throw new UploadError("upload_cleanup_unconfirmed",503);
    if(!result.error)removed++;
  }
  return {checked:rows.length,removed};
}
