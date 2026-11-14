import "server-only";
import type { AdminClient } from "@/lib/post/server-data";
import { addDays, formatLocalTime, relativeDayLabel, isoToLocalDate, localToUtcIso } from "./timezone";
import type { TodayItem } from "./today-view";
import { instagramPublishReadiness } from "@/lib/instagram/publish-readiness";
import { isPastInstant } from "./schedule-guard";
import { MISSED_GRACE_MINUTES } from "./workflow/state";
import { PLAN_CHANNEL_LABELS } from "./workflow/channels";

const CHANNELS = ["instagram", "tiktok", "youtube", "linkedin"] as const;
type ScheduledJob = { id: string; draft_id: string; status: string; scheduled_at: string; approved_content_version?: number; channel: typeof CHANNELS[number] };

const FORMAT_LABELS: Record<string, string> = {
  instagram_post: "Instagram Post", reel: "Reel", story: "Instagram Story", linkedin_text: "LinkedIn Text Post",
  youtube_short: "YouTube Short", youtube_video: "YouTube Video", tiktok_video: "TikTok Video",
};

export type ScheduledPost = TodayItem & {
  channel: ScheduledJob["channel"];
  publishAt: string;
  dayLabel: string;
  statusLabel: string;
};

/** Read-only execution truth, including jobs outside the active marketing plan.
 * No calendar projections, held jobs, stale approvals or disconnected accounts
 * count as scheduled. All reads remain owner-scoped; read failures fail closed.
 */
export function loadTodayScheduledItems(admin: AdminClient, ownerId: string, today: string, timeZone: string, now: Date = new Date()) {
  return loadScheduledPosts(admin, ownerId, timeZone, now, { from: today, until: addDays(today, 7) });
}

export async function loadScheduledPosts(admin: AdminClient, ownerId: string, timeZone: string, now: Date, window?: { from: string; until: string }): Promise<ScheduledPost[]> {
  const start = window && localToUtcIso(window.from, 0, timeZone);
  const end = window && localToUtcIso(window.until, 0, timeZone);
  const jobs = await Promise.all(CHANNELS.map(async channel => {
    const rows: ScheduledJob[] = [];
    let after: string | undefined;
    do {
      let query = admin.from(`${channel}_publish_queue`)
        .select(channel === "linkedin" ? "id,draft_id,status,scheduled_at,approved_content_version" : "id,draft_id,status,scheduled_at")
        .eq("owner_user_id", ownerId).eq("status", "scheduled").order("id").limit(250);
      if (start && end) query = query.gte("scheduled_at", start).lt("scheduled_at", end);
      if (after) query = query.gt("id", after);
      const { data, error } = await query;
      if (error) throw new Error("today_schedule_read_failed");
      const page = (data ?? []) as unknown as Omit<ScheduledJob, "channel">[];
      rows.push(...page.map(job => ({ ...job, channel })));
      after = page.length === 250 ? page[page.length - 1].id : undefined;
    } while (after);
    return rows;
  }));
  const rows = jobs.flat();
  if (!rows.length) return [];
  const ids = [...new Set(rows.map(job => String(job.draft_id)))];
  // Keep REST IN filters below URL length limits for busy calendars.
  const chunks = Array.from({ length: Math.ceil(ids.length / 100) }, (_, index) => ids.slice(index * 100, (index + 1) * 100));
  const [drafts, assets, ...connections] = await Promise.all([
    Promise.all(chunks.map(chunk => admin.from("mara_drafts").select("id,title,content,kind,status,content_version,approved_content_version")
      .eq("owner_user_id", ownerId).in("id", chunk))),
    Promise.all(chunks.map(chunk => admin.from("post_draft_assets").select("draft_id,status,storage_path")
      .eq("owner_user_id", ownerId).in("draft_id", chunk))),
    ...CHANNELS.map(channel => {
      const query = channel === "instagram"
        ? admin.from("instagram_connections").select("status,scopes,token_expires_at")
        : admin.from(`${channel}_connections`).select("status,scopes");
      return query.eq("owner_user_id", ownerId).eq("status", "connected");
    }),
  ]);
  if ([...drafts, ...assets, ...connections].some(read => read.error)) throw new Error("today_schedule_read_failed");
  const byDraft = new Map(drafts.flatMap(page => page.data ?? []).map(draft => [String(draft.id), draft]));
  const media = new Set(assets.flatMap(page => page.data ?? []).filter(asset => asset.status === "uploaded"
    && typeof asset.storage_path === "string" && asset.storage_path.startsWith(`${ownerId}/`)).map(asset => String(asset.draft_id)));
  const permitted = new Set(CHANNELS.filter((channel, index) => (connections[index].data ?? []).some(connection => {
    const scopes = Array.isArray(connection.scopes) ? connection.scopes : [];
    if (channel === "instagram") return instagramPublishReadiness({ status: connection.status, scopes,
      tokenExpiresAt: "token_expires_at" in connection ? connection.token_expires_at as string | null : null }, now) === "ready";
    const permission = { instagram: "instagram_business_content_publish", tiktok: "video.publish", youtube: "https://www.googleapis.com/auth/youtube.upload", linkedin: "w_member_social" }[channel];
    return scopes.includes(permission) || channel === "youtube" && scopes.includes("youtube.upload");
  })));
  const seen = new Set<string>();
  const items: ScheduledPost[] = [];
  for (const job of rows) {
    if (job.channel === "instagram" && isPastInstant(job.scheduled_at, now, MISSED_GRACE_MINUTES * 60_000)) continue;
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
    items.push({
      draftId: id, channel: job.channel, channelLabel: PLAN_CHANNEL_LABELS[job.channel],
      status: "scheduled", statusLabel: "Scheduled", publishingJobKey: `${job.channel}:${job.id}`,
      publishAt: job.scheduled_at, slotDate: date, localDate: date,
      dayLabel: relativeDayLabel(date, now, timeZone), localTime: formatLocalTime(job.scheduled_at, timeZone),
      contentTypeLabel: FORMAT_LABELS[draft.kind],
      concept: String(draft.title), caption: String(draft.content),
    });
  }
  return items.sort((a, b) => a.publishAt.localeCompare(b.publishAt));
}
