import { draftInput, json, sameOrigin } from "@/lib/linkedin/http";
import { ensureStudioConversation } from "@/lib/post/server-data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export async function GET() {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  try {
    const admin = createAdminClient();
    const [drafts,queue] = await Promise.all([
      admin.from("mara_drafts").select("id,title,content,status,content_version,proposed_publish_at")
        .eq("owner_user_id",user.id).eq("kind","linkedin_text").order("created_at",{ascending:false}).limit(50),
      admin.from("linkedin_publish_queue").select("id,draft_id,approved_content_version,status,scheduled_at,next_attempt_at,provider_ref,failure_code,attempts")
        .eq("owner_user_id",user.id).order("created_at",{ascending:false}).limit(100),
    ]);
    if (drafts.error || queue.error) throw new Error();
    return json({drafts:drafts.data,queue:queue.data});
  } catch { return json({error:"LinkedIn drafts and queue could not be loaded. Nothing was changed."},503); }
}
export async function POST(request: Request) {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  if (!sameOrigin(request)) return json({error:"That request was not valid."},403);
  const parsed = draftInput.safeParse(await request.json().catch(()=>null));
  if (!parsed.success) return json({error:"Enter text between 1 and 3,000 characters."},400);
  try {
    const admin = createAdminClient();
    const {data:business,error} = await admin.from("businesses").select("id").eq("owner_user_id",user.id).single();
    if (error || !business) return json({error:"Complete your business setup first."},409);
    const conversationId = await ensureStudioConversation(admin,user.id);
    const {data:existing,error:readError} = await admin.from("mara_drafts").select("id,content,kind")
      .eq("owner_user_id",user.id).eq("id",parsed.data.id).maybeSingle();
    if (readError) throw new Error();
    if (existing) return existing.kind==="linkedin_text" && existing.content===parsed.data.text
      ? json({id:existing.id}) : json({error:"Refresh this draft before saving."},409);
    const saved = await admin.from("mara_drafts").insert({id:parsed.data.id,owner_user_id:user.id,conversation_id:conversationId,
      kind:"linkedin_text",channel:"LinkedIn",title:"LinkedIn text post",content:parsed.data.text,
      social_channel:"linkedin",social_format:"text",status:"draft",approval_origin:"user"});
    if (saved.error) throw new Error();
    return json({id:parsed.data.id});
  } catch { return json({error:"The draft could not be saved. Retry with the same draft rather than creating a duplicate."},503); }
}
