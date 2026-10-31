import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";
import { getSocialDraft } from "@/lib/social/server-drafts";
import { safePostAssetName } from "@/lib/post/asset";
import { YOUTUBE_UPLOAD_UUID, validYouTubeUploadFile, youtubeEffectiveMaxBytes, youtubeUploadLimitLabel } from "@/lib/youtube/upload-rules";
import { authorizeUpload, completeUpload, loadUpload, publicUpload, uploadRpc, UploadError } from "@/lib/youtube/upload-server";

export const runtime="nodejs";
export const maxDuration=120;
const headers={"Cache-Control":"no-store"};
const maxBytes=()=>youtubeEffectiveMaxBytes(process.env.YOUTUBE_UPLOAD_MAX_BYTES);
const messages: Record<string,string>={
  upload_limit_reached:"Upload limit reached. Wait before starting another upload.",
  upload_already_pending:"This draft already has an upload. Resume or cancel it first.",
  upload_provider_owned:"YouTube is already processing this post. Its video cannot be replaced.",
  upload_generation_active:"Wait for this draft's existing media generation to finish.",
  upload_draft_changed:"This draft changed during upload. Your existing content is safe. Cancel this upload and review the draft before starting again.",
  upload_not_complete:"The file is not fully stored yet. Resume the same upload; do not start another.",
  upload_validation_busy:"This upload is being checked. Check its status again shortly.",
  invalid_video:"Choose a valid MP4 with a video track and duration. Export as H.264 MP4 if your file cannot be previewed.",
  invalid_short:"A Short must be square or vertical and at most three minutes.",
  upload_storage_not_ready:"Large-video storage is not configured safely yet.",
  upload_expired:"This upload expired. Cancel it before starting a new upload.",
};
const tooLarge=()=>`This video is larger than ${youtubeUploadLimitLabel(maxBytes())}. Export a smaller MP4 and try again.`;
type Context={params:Promise<{id:string}>};
function failure(reason:unknown) {
  const e=reason instanceof UploadError?reason:new UploadError("upload_operation_unconfirmed",503);
  return Response.json({error:e.code==="upload_too_large"?tooLarge():messages[e.code]??"Voom couldn't confirm this upload. Check the same upload's status before retrying; nothing was published.",code:e.code},{status:e.status,headers});
}
async function identity(context:Context) {
  const user=await getCurrentUser();if(!user)throw new UploadError("not_authenticated",401);
  const {id}=await context.params;if(!YOUTUBE_UPLOAD_UUID.test(id))throw new UploadError("not_found",404);
  return {owner:user.id,draft:id};
}
async function jsonBody(request:Request) {
  if(!request.body)throw new UploadError("invalid_request",400);
  const reader=request.body.getReader();const chunks:Uint8Array[]=[];let length=0;
  try {
    while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4096)throw new UploadError("invalid_request",413);chunks.push(value);}
    const data=new Uint8Array(length);let at=0;for(const c of chunks){data.set(c,at);at+=c.length;}
    const body=JSON.parse(new TextDecoder().decode(data));
    if(!body || typeof body!=="object" || Array.isArray(body))throw Error();return body as Record<string,unknown>;
  }catch(e){throw e instanceof UploadError?e:new UploadError("invalid_request",400);}finally{await reader.cancel().catch(()=>undefined);}
}
export async function GET(request:Request,context:Context) {
  try {
    const {owner,draft}=await identity(context),id=new URL(request.url).searchParams.get("uploadId")??undefined;
    if(id && !YOUTUBE_UPLOAD_UUID.test(id))throw new UploadError("not_found",404);
    const db=createAdminClient(),u=await loadUpload(db,owner,draft,id);
    return Response.json({upload:u?publicUpload(u):null,maxBytes:maxBytes()},{headers});
  }catch(e){return failure(e);}
}
export async function POST(request:Request,context:Context) {
  try {
    if(request.headers.get("origin")!==new URL(request.url).origin)throw new UploadError("invalid_origin",403);
    const {owner,draft}=await identity(context),body=await jsonBody(request),db=createAdminClient();
    const allowed=body.action==="start"?["action","key","name","size","fingerprint"]:["action","uploadId"];
    if(Object.keys(body).some(k=>!allowed.includes(k)))throw new UploadError("invalid_request",400);
    if(body.action==="start") {
      if(validYouTubeUploadFile(body.name,body.size) && !validYouTubeUploadFile(body.name,body.size,maxBytes()))throw new UploadError("upload_too_large",413);
      if(typeof body.key!=="string" || !YOUTUBE_UPLOAD_UUID.test(body.key) || !validYouTubeUploadFile(body.name,body.size,maxBytes()) || typeof body.fingerprint!=="string" || !/^[a-f0-9]{64}$/.test(body.fingerprint))throw new UploadError("invalid_request",400);
      const u=await uploadRpc(db,"begin_youtube_upload",{p_owner:owner,p_draft:draft,p_key:body.key,p_name:safePostAssetName(String(body.name)),p_bytes:body.size,p_fingerprint:body.fingerprint});
      return Response.json({upload:publicUpload(u)},{headers});
    }
    if(typeof body.uploadId!=="string" || !YOUTUBE_UPLOAD_UUID.test(body.uploadId))throw new UploadError("invalid_request",400);
    if(body.action==="authorize")return Response.json(await authorizeUpload(db,owner,draft,body.uploadId,process.env.NEXT_PUBLIC_SUPABASE_URL??"",maxBytes()),{headers});
    if(body.action==="cancel") {
      const changed=await uploadRpc(db,"release_youtube_upload",{p_owner:owner,p_draft:draft,p_id:body.uploadId,p_claim:null,p_cancel:true});
      if(!changed)throw new UploadError("upload_operation_unconfirmed");
      return Response.json({cancelled:true},{headers});
    }
    if(body.action==="complete") {
      await completeUpload(db,owner,draft,body.uploadId);
      const view=await getSocialDraft(db,owner,draft);if(!view)throw new UploadError("upload_operation_unconfirmed",503);
      return Response.json({draft:view,message:"Video stored privately. Review and approve separately; nothing was queued or published."},{headers});
    }
    throw new UploadError("invalid_request",400);
  }catch(e){return failure(e);}
}
