import { draftChange, UUID, json, sameOrigin, LINKEDIN_MESSAGES } from "@/lib/linkedin/http";
import { readLinkedInConfig } from "@/lib/linkedin/config";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const runtime = "nodejs";
export async function PATCH(request: Request,{params}:{params:Promise<{id:string}>}) {
  const user = await getCurrentUser();
  if (!user) return json({error:"Please log in again."},401);
  if (!sameOrigin(request)) return json({error:"That request was not valid."},403);
  const {id} = await params;
  const parsed = draftChange.safeParse(await request.json().catch(()=>null));
  if (!UUID.safeParse(id).success || !parsed.success) return json({error:"Review the draft and confirm before scheduling."},400);
  const input = parsed.data;
  if (input.action==="approve" && !readLinkedInConfig()) return json({error:"LinkedIn is not configured yet."},503);
  const scheduledAt = input.scheduledAt ?? (input.action==="approve" ? new Date().toISOString() : null);
  if (input.action==="approve" && input.scheduledAt && Date.parse(input.scheduledAt)<=Date.now()) {
    return json({error:LINKEDIN_MESSAGES.linkedin_schedule_invalid},400);
  }
  try {
    const admin = createAdminClient();
    const result = input.action==="approve"
      ? await admin.rpc("approve_linkedin_draft",{p_owner:user.id,p_draft:id,p_version:input.version,
          p_connection:input.connectionId,p_member:input.memberSub,p_schedule:scheduledAt})
      : await admin.rpc("edit_linkedin_draft",{p_owner:user.id,p_draft:id,p_version:input.version,p_text:input.text,
          p_schedule:scheduledAt,p_reject:input.action==="reject"});
    if (result.error) {
      const safeCode = Object.keys(LINKEDIN_MESSAGES).find(code=>result.error.message===code);
      return json({error:safeCode ? LINKEDIN_MESSAGES[safeCode] : "This action could not be confirmed. Refresh and retry."},409);
    }
    return json({message:input.action==="approve" ? "Approved and scheduled in VOOM. Nothing is Published until LinkedIn confirms."
      : input.action==="reject" ? "Rejected. Unsubmitted publishing was cancelled." : "Saved. Review and approve this version before publishing."});
  } catch { return json({error:"The action could not be confirmed. Refresh before retrying."},503); }
}
