import "server-only";
import type { AdminClient } from "@/lib/post/server-data";
import { addDays, formatLocalTime, isoToLocalDate, localToUtcIso } from "./timezone";
import type { TodayItem } from "./today-view";

const CHANNELS = ["instagram", "tiktok", "youtube", "linkedin"] as const;
type ScheduledJob = { id: string; draft_id: string; status: string; scheduled_at: string; approved_content_version?: number; channel: typeof CHANNELS[number] };

/** Read-only execution truth, including jobs outside the active marketing plan.
 * No calendar projections, held jobs, stale approvals or disconnected accounts
 * count as scheduled. All reads remain owner-scoped; read failures fail closed.
 */
export async function loadTodayScheduledItems(admin: AdminClient, ownerId: string, today: string, timeZone: string): Promise<TodayItem[]> {
  const start = localToUtcIso(today, 0, timeZone);
  const end = localToUtcIso(addDays(today, 7), 0, timeZone);
  const jobs = await Promise.all(CHANNELS.map(async channel => {
    const result = await admin.from(`${channel}_publish_queue`)
      .select(channel === "linkedin" ? "id,draft_id,status,scheduled_at,approved_content_version" : "id,draft_id,status,scheduled_at")
      .eq("owner_user_id", ownerId).eq("status", "scheduled").gte("scheduled_at", start).lt("scheduled_at", end);
    if (result.error) throw new Error("today_schedule_read_failed");
    return ((result.data ?? []) as unknown as Omit<ScheduledJob, "channel">[]).map(job => ({ ...job, channel }));
  }));
  const rows = jobs.flat();
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(job => String(job.draft_id)))];
  const [drafts, assets, ...connections] = await Promise.all([
    admin.from("mara_drafts").select("id,title,content,kind,status,content_version,approved_content_version")
      .eq("owner_user_id", ownerId).in("id", ids),
    admin.from("post_draft_assets").select("draft_id,status,storage_path")
      .eq("owner_user_id", ownerId).in("draft_id", ids),
    ...CHANNELS.map(channel => admin.from(`${channel}_connections`).select("status,scopes")
      .eq("owner_user_id", ownerId).eq("status", "connected")),
  ]);
  if ([drafts, assets, ...connections].some(read => read.error)) throw new Error("today_schedule_read_failed");
  const byDraft = new Map((drafts.data ?? []).map(draft => [String(draft.id), draft]));
  const media = new Set((assets.data ?? []).filter(asset => asset.status === "uploaded"
    && typeof asset.storage_path === "string" && asset.storage_path.startsWith(`${ownerId}/`)).map(asset => String(asset.draft_id)));
  const permitted = new Set(CHANNELS.filter((channel, index) => (connections[index].data ?? []).some(connection => {
    const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
    const permission = { instagram: "instagram_business_content_publish", tiktok: "video.publish", youtube: "https://www.googleapis.com/auth/youtube.upload", linkedin: "w_member_social" }[channel];
    return scopes.includes(permission) || channel === "youtube" && scopes.includes("youtube.upload");
  })));
  const seen = new Set<string>();
  const items: TodayItem[] = [];
  for (const job of rows) {
    const id = String(job.draft_id), draft = byDraft.get(id);
    if (!draft || draft.status !== "approved" || !Number(draft.approved_content_version)
      || draft.content_version !== draft.approved_content_version || !permitted.has(job.channel)) continue;
    if (job.channel === "linkedin" && job.approved_content_version !== draft.content_version) continue;
    const expected = { instagram: ["instagram_post", "reel", "story"], tiktok: ["tiktok_video"], youtube: ["youtube_short", "youtube_video"], linkedin: ["linkedin_text"] }[job.channel];
    if (!expected.includes(String(draft.kind)) || job.channel !== "linkedin" && !media.has(id)) continue;
    const key = `${job.channel}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const date = isoToLocalDate(job.scheduled_at, timeZone);
    items.push({ draftId: id, publishingJobKey: `${job.channel}:${job.id}`, publishAt: job.scheduled_at, slotDate: date, localDate: date,
      status: "scheduled", statusLabel: "Scheduled", channelLabel: { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube", linkedin: "LinkedIn" }[job.channel],
      contentTypeLabel: draft.kind === "linkedin_text" ? "Text" : draft.kind === "instagram_post" ? "Post" : draft.kind === "youtube_short" ? "Short" : "Video",
      concept: String(draft.title), caption: String(draft.content), localTime: formatLocalTime(job.scheduled_at, timeZone) });
  }
  return items.sort((a, b) => a.publishAt!.localeCompare(b.publishAt!));
}
