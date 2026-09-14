import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { buildPerformanceReport, type PerformanceMeasurement, type PerformanceReport } from "./insights.ts";
import { buildPerformancePlanContext, type PerformancePlanContext } from "./plan-context.ts";
import {
  availableMetrics,
  performanceContentTypeForMediaKind,
  type MetricSources,
  type PerformanceContentType,
  type PerformanceMetrics,
} from "./types.ts";
import { PERFORMANCE_SNAPSHOT_TABLE } from "./sync.ts";

/**
 * Read model for the Performance page, Today's insight and MARA's planning
 * context. One implementation, so a screen and MARA can never disagree.
 *
 * Isolation: EVERY query filters on owner_user_id, and the page passes the
 * session-scoped client so Row Level Security is the boundary as well.
 *
 * The read is tolerant by design: it only ever reports what was measured. A
 * published item with no snapshot is counted as "published without metrics"
 * — that honest denominator is what lets the UI say why it has nothing to
 * compare instead of pretending.
 */

/** How many days of published content the report looks at by default. */
export const PERFORMANCE_WINDOW_DAYS = 30;
const SNAPSHOT_LIMIT = 500;
const PUBLISHED_LIMIT = 200;
const DRAFT_CHUNK = 100;

export interface PerformanceReadOptions {
  now?: Date;
  windowDays?: number;
}

export interface PerformanceReadModel {
  measurements: PerformanceMeasurement[];
  publishedWithoutMetrics: number;
  windowDays: number;
  now: Date;
}

export async function loadPerformanceReport(
  db: SupabaseClient,
  ownerId: string,
  options: PerformanceReadOptions = {},
): Promise<PerformanceReport> {
  const model = await loadPerformanceModel(db, ownerId, options);
  return buildPerformanceReport({
    measurements: model.measurements,
    publishedWithoutMetrics: model.publishedWithoutMetrics,
    now: model.now,
    windowDays: model.windowDays,
  });
}

/**
 * The advisory performance context for MARA's next rolling plan. Returns null
 * whenever there is not enough real data — planning then proceeds exactly as
 * before, with no performance section at all.
 */
export async function loadPerformancePlanContext(
  db: SupabaseClient,
  ownerId: string,
  options: PerformanceReadOptions = {},
): Promise<PerformancePlanContext | null> {
  const report = await loadPerformanceReport(db, ownerId, options);
  return buildPerformancePlanContext(report);
}

export async function loadPerformanceModel(
  db: SupabaseClient,
  ownerId: string,
  options: PerformanceReadOptions = {},
): Promise<PerformanceReadModel> {
  const now = options.now ?? new Date();
  const windowDays = options.windowDays ?? PERFORMANCE_WINDOW_DAYS;
  const cutoff = new Date(now.getTime() - windowDays * 86_400_000).toISOString();

  const { data: snapshotRows } = await db.from(PERFORMANCE_SNAPSHOT_TABLE)
    .select("instagram_media_id,draft_id,content_type,published_at,collected_at,metrics,metric_sources")
    .eq("owner_user_id", ownerId)
    .gte("published_at", cutoff)
    .order("collected_at", { ascending: false })
    .limit(SNAPSHOT_LIMIT);

  // One measurement per media id: the newest collection window wins.
  const latest = new Map<string, PerformanceMeasurement>();
  for (const row of snapshotRows ?? []) {
    const mediaId = typeof row.instagram_media_id === "string" ? row.instagram_media_id : null;
    const publishedAt = row.published_at ? String(row.published_at) : null;
    const contentType = contentTypeOf(row.content_type);
    if (!mediaId || !publishedAt || !contentType || latest.has(mediaId)) continue;
    const metrics = (row.metrics ?? {}) as PerformanceMetrics;
    if (!availableMetrics(metrics).length) continue;
    latest.set(mediaId, {
      instagramMediaId: mediaId,
      draftId: row.draft_id ? String(row.draft_id) : null,
      contentType,
      title: "",
      caption: "",
      publishedAt,
      collectedAt: row.collected_at ? String(row.collected_at) : publishedAt,
      metrics,
      sources: (row.metric_sources ?? {}) as MetricSources,
    });
  }

  const { data: publishedRows } = await db.from("instagram_publish_queue")
    .select("draft_id,media_kind,instagram_media_id,published_at")
    .eq("owner_user_id", ownerId)
    .eq("status", "published")
    .not("instagram_media_id", "is", null)
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(PUBLISHED_LIMIT);

  let publishedWithoutMetrics = 0;
  for (const row of publishedRows ?? []) {
    const mediaId = row.instagram_media_id ? String(row.instagram_media_id) : null;
    // Published (Meta returned a media id) but no snapshot yet: counted
    // honestly so the UI can explain the difference instead of hiding it.
    if (mediaId && !latest.has(mediaId)) publishedWithoutMetrics += 1;
  }

  // Titles/captions come from the SAME drafts Voom planned and published, so
  // topic and purpose are derived from the words the business actually used.
  const draftIds = [...new Set([...latest.values()].map((item) => item.draftId).filter((id): id is string => Boolean(id)))];
  const drafts = new Map<string, { title: string; content: string }>();
  for (let index = 0; index < draftIds.length; index += DRAFT_CHUNK) {
    const chunk = draftIds.slice(index, index + DRAFT_CHUNK);
    const { data } = await db.from("mara_drafts").select("id,title,content").eq("owner_user_id", ownerId).in("id", chunk);
    for (const row of data ?? []) drafts.set(String(row.id), { title: String(row.title ?? ""), content: String(row.content ?? "") });
  }

  const measurements = [...latest.values()]
    .map((item) => {
      const draft = item.draftId ? drafts.get(item.draftId) : undefined;
      return { ...item, title: draft?.title ?? "", caption: draft?.content ?? "" };
    })
    .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

  return { measurements, publishedWithoutMetrics, windowDays, now };
}

function contentTypeOf(value: unknown): PerformanceContentType | null {
  return value === "post" || value === "reel" || value === "story" ? value : null;
}

export { performanceContentTypeForMediaKind };
