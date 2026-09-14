import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import { instagramKeyRing, readInstagramConfig, type InstagramConfig } from "@/lib/instagram/config";
import type { InstagramKeyRing } from "@/lib/instagram/crypto";
import { getInstagramServerCredentials } from "@/lib/instagram/data";
import { INSIGHTS_METRICS_BY_KIND, hasInsightsPermission } from "@/lib/instagram/metrics";
import {
  availableMetrics,
  mergeMetrics,
  normalizeInsightPayload,
  normalizeMediaNode,
  performanceContentTypeForMediaKind,
  type MetricSources,
  type PerformanceContentType,
  type PerformanceMetric,
  type PerformanceMetrics,
} from "./types.ts";

/**
 * The durable server-side performance sync.
 *
 * WHAT IT DOES
 *   For every Instagram item VOOM ITSELF PUBLISHED (a real
 *   instagram_publish_queue row in status 'published' carrying a real Meta
 *   media id), it reads the media node and — when the connected account
 *   exposes them — that media's insights, normalizes everything into Voom's
 *   own performance model, and upserts ONE snapshot per collection window.
 *
 * WHAT IT CAN NEVER DO
 *   - publish anything: the queue is only SELECTed, never claimed, written or
 *     completed, and no container is ever created,
 *   - read a draft/content item that is not already published: the source
 *     query is `status = 'published'` plus a non-null media id, which the
 *     database itself guarantees only exists after Meta returned a media id,
 *   - modify media or captions: no UPDATE targets a draft, asset or caption,
 *   - cross owners: every credential read is keyed by the row's own
 *     owner_user_id, and every write carries that same owner,
 *   - invent metrics: a metric is stored only when Meta actually returned a
 *     number for it; refused metrics are reported as unavailable instead,
 *   - write a fake zero: metrics that were not returned are ABSENT from the
 *     stored object.
 *
 * Expired/revoked connections fail gracefully: the owner is skipped with a
 * truthful reason and no Meta call is attempted. The sync never changes the
 * connection's own state, because publishing and insight reads have different
 * permissions — a refused insight read must never disable publishing.
 */

/** How far back Voom keeps refreshing metrics for published content. */
export const PERFORMANCE_SYNC_LOOKBACK_DAYS = 30;
/** Published items measured per run (bounded work per cron invocation). */
export const PERFORMANCE_SYNC_LIMIT = 25;
/** Wall-clock ceiling for one invocation; it stops cleanly rather than overrun. */
export const PERFORMANCE_SYNC_BUDGET_MS = 90_000;
/** Snapshots are one per (owner, media, hour): a rerun refreshes that window. */
export const PERFORMANCE_COLLECTION_WINDOW_MS = 60 * 60 * 1000;

export const PERFORMANCE_SNAPSHOT_TABLE = "instagram_performance_snapshots";

export type PerformanceSyncOutcome =
  | "stored"
  | "refreshed"
  | "insights_unavailable"
  | "media_unavailable";

export interface PerformanceSyncItemResult {
  ownerId: string;
  instagramMediaId: string;
  draftId: string | null;
  outcome: PerformanceSyncOutcome;
  code: string;
  /** Only the metrics Meta really returned (never a filled-in zero). */
  storedMetrics: PerformanceMetric[];
  /** Requested metrics Meta did not expose for this media. */
  unavailableMetrics: string[];
}

export interface PerformanceSyncOwnerResult {
  ownerId: string;
  outcome: "synced" | "connection_unavailable" | "unauthorized" | "rate_limited" | "failed";
  code: string;
  checked: number;
  stored: number;
  refreshed: number;
}

export interface PerformanceSyncResult {
  ok: boolean;
  /** Set when the run could not read anything (e.g. Instagram unconfigured). */
  skipped: string | null;
  collectedAt: string;
  owners: number;
  checked: number;
  stored: number;
  refreshed: number;
  unavailable: number;
  failed: number;
  /** True when the item/owner/budget cap stopped the run before it finished. */
  truncated: boolean;
  ownersProcessed: PerformanceSyncOwnerResult[];
  items: PerformanceSyncItemResult[];
}

/**
 * The ONLY Instagram capability this module needs: two read-only calls. It is
 * a structural port, not the concrete client, so the sync can be driven by a
 * fake in tests (no Meta call ever) and so importing this module never pulls
 * the network client into a process that does not need it.
 */
export interface PerformanceReadPort {
  getMediaDetails(accessToken: string, mediaId: string): Promise<Record<string, unknown> | null>;
  getMediaInsights(input: { accessToken: string; mediaId: string; metrics: string[] }): Promise<MediaInsightsRead>;
}

export interface MediaInsightsRead {
  entries: unknown[];
  unavailable: string[];
  refused: boolean;
}

export interface PerformanceSyncDeps {
  db?: SupabaseClient;
  config?: InstagramConfig | null;
  /** Test seam: a read-only Instagram port. Production builds the real one. */
  client?: PerformanceReadPort;
  now?: Date;
  limit?: number;
  budgetMs?: number;
  /** Optional owner scope (operator/debug use). Never widens a read: rows are
   *  still filtered by the owner id carried on the row itself. */
  ownerIds?: string[];
}

/** One published queue row that is eligible to be measured. */
interface PublishedRow {
  id: string;
  owner_user_id: string;
  draft_id: string;
  calendar_item_id: string | null;
  media_kind: string;
  instagram_media_id: string;
  published_at: string;
}

export async function runInstagramPerformanceSync(deps: PerformanceSyncDeps = {}): Promise<PerformanceSyncResult> {
  const config = deps.config !== undefined ? deps.config : readInstagramConfig();
  const now = deps.now ?? new Date();
  const collectedAt = collectionWindow(now).toISOString();
  const result: PerformanceSyncResult = {
    ok: true, skipped: null, collectedAt, owners: 0, checked: 0, stored: 0, refreshed: 0,
    unavailable: 0, failed: 0, truncated: false, ownersProcessed: [], items: [],
  };
  if (!config) {
    // Not configured is not a failure: nothing is read and nothing is written.
    result.ok = false;
    result.skipped = "instagram_not_configured";
    return result;
  }
  const db = deps.db ?? (await import("@/utils/supabase/admin")).createAdminClient();
  // The concrete client is imported lazily: this module must stay loadable
  // (and testable) without dragging the network client into the graph.
  const client = deps.client ?? (await createDefaultReadPort(config));
  const keyRing = instagramKeyRing(config);
  const deadline = now.getTime() + (deps.budgetMs ?? PERFORMANCE_SYNC_BUDGET_MS);

  const rows = await loadPublishedRows(db, { now, limit: deps.limit ?? PERFORMANCE_SYNC_LIMIT, ownerIds: deps.ownerIds });
  const byOwner = new Map<string, PublishedRow[]>();
  for (const row of rows) {
    const list = byOwner.get(row.owner_user_id) ?? [];
    list.push(row);
    byOwner.set(row.owner_user_id, list);
  }
  result.owners = byOwner.size;

  let budgetExhausted = false;
  for (const [ownerId, ownerRows] of byOwner) {
    if (Date.now() > deadline) {
      budgetExhausted = true;
      break;
    }
    const ownerOutcome = await syncOwner({ db, client, ownerId, rows: ownerRows, collectedAt, now, deadline, keyRing, result });
    result.ownersProcessed.push(ownerOutcome);
    // Item-level stores/refreshes are counted inside syncOwner; the number of
    // published items examined belongs to the run's own totals.
    result.checked += ownerOutcome.checked;
    if (ownerOutcome.outcome === "rate_limited") {
      // Meta is rate limiting: stop the whole run instead of hammering.
      budgetExhausted = true;
      break;
    }
  }
  // A cap was reached while eligible published rows were still unmeasured.
  result.truncated = budgetExhausted || rows.length >= (deps.limit ?? PERFORMANCE_SYNC_LIMIT);
  return result;
}

async function syncOwner(input: {
  db: SupabaseClient;
  client: PerformanceReadPort;
  ownerId: string;
  rows: PublishedRow[];
  collectedAt: string;
  now: Date;
  deadline: number;
  keyRing: InstagramKeyRing;
  result: PerformanceSyncResult;
}): Promise<PerformanceSyncOwnerResult> {
  const { db, client, ownerId, rows, collectedAt, now, result, keyRing } = input;
  const outcome: PerformanceSyncOwnerResult = { ownerId, outcome: "synced", code: "ok", checked: rows.length, stored: 0, refreshed: 0 };

  // 1) Connection state first: a disconnected, expired, revoked or errored
  //    account is skipped without a single Meta call.
  const { data: connection } = await db.from("instagram_connections")
    .select("status,scopes,token_expires_at").eq("owner_user_id", ownerId).maybeSingle();
  if (!connection || String(connection.status) !== "connected") {
    outcome.outcome = "connection_unavailable";
    outcome.code = connection ? `connection_${String(connection.status)}` : "connection_missing";
    return outcome;
  }
  const expiresAt = connection.token_expires_at ? Date.parse(String(connection.token_expires_at)) : null;
  if (expiresAt !== null && Number.isFinite(expiresAt) && expiresAt <= now.getTime()) {
    outcome.outcome = "connection_unavailable";
    outcome.code = "connection_token_expired";
    return outcome;
  }
  const scopes = Array.isArray(connection.scopes) ? (connection.scopes as string[]) : [];
  let insightsAllowed = hasInsightsPermission(scopes);

  // 2) Owner-scoped credentials (decryption failure == not connected).
  let credentials: { userId: string; accessToken: string };
  try {
    credentials = await getInstagramServerCredentials(db, ownerId, keyRing);
  } catch {
    outcome.outcome = "connection_unavailable";
    outcome.code = "connection_credentials_unavailable";
    return outcome;
  }

  const { data: business } = await db.from("businesses").select("id").eq("owner_user_id", ownerId).maybeSingle();
  const businessId = business && business.id ? String(business.id) : null;

  for (const row of rows) {
    if (Date.now() > input.deadline || result.truncated) break;
    const contentType = performanceContentTypeForMediaKind(row.media_kind);
    if (!contentType || !row.published_at) {
      result.items.push({
        ownerId, instagramMediaId: row.instagram_media_id, draftId: row.draft_id,
        outcome: "media_unavailable", code: "unsupported_media_kind", storedMetrics: [], unavailableMetrics: [],
      });
      result.unavailable += 1;
      continue;
    }
    try {
      const item = await measureItem({
        db, client, ownerId, row, contentType, businessId, collectedAt,
        accessToken: credentials.accessToken, insightsAllowed,
      });
      result.items.push(item.result);
      if (item.result.outcome === "stored") {
        result.stored += 1;
        outcome.stored += 1;
      } else if (item.result.outcome === "refreshed") {
        result.refreshed += 1;
        outcome.refreshed += 1;
      } else {
        result.unavailable += 1;
      }
      // Meta refused the insights permission for this account — stop
      // requesting them for the remaining media in this run, whether or not
      // the media-node metrics were still storable.
      if (item.result.code === "insights_refused") insightsAllowed = false;
    } catch (error) {
      if (readErrorCode(error) === "rate_limited") {
        outcome.outcome = "rate_limited";
        outcome.code = "rate_limited";
        return outcome;
      }
      if (readErrorCode(error) === "unauthorized") {
        // Revoked/expired token or missing permission. Stop this owner, keep
        // the connection row exactly as it is, and keep the run alive.
        outcome.outcome = "unauthorized";
        outcome.code = "connection_unauthorized";
        return outcome;
      }
      outcome.outcome = "failed";
      outcome.code = "performance_read_failed";
      result.failed += 1;
      result.items.push({
        ownerId, instagramMediaId: row.instagram_media_id, draftId: row.draft_id,
        outcome: "media_unavailable", code: "performance_read_failed", storedMetrics: [], unavailableMetrics: [],
      });
    }
  }
  return outcome;
}

async function measureItem(input: {
  db: SupabaseClient;
  client: PerformanceReadPort;
  ownerId: string;
  row: PublishedRow;
  contentType: PerformanceContentType;
  businessId: string | null;
  collectedAt: string;
  accessToken: string;
  insightsAllowed: boolean;
}): Promise<{ result: PerformanceSyncItemResult }> {
  const { db, client, row, collectedAt } = input;
  const result: PerformanceSyncItemResult = {
    ownerId: input.ownerId,
    instagramMediaId: row.instagram_media_id,
    draftId: row.draft_id,
    outcome: "media_unavailable",
    code: "no_metrics_exposed",
    storedMetrics: [],
    unavailableMetrics: [],
  };

  // Read the published media node (never the container, never anything else).
  const details = await client.getMediaDetails(input.accessToken, row.instagram_media_id);
  if (!details) {
    result.code = "media_not_readable";
    return { result };
  }
  const sources: MetricSources = {};
  const nodeMetrics = normalizeMediaNode(details);
  const nodeFixed: PerformanceMetrics = {};
  for (const metric of availableMetrics(nodeMetrics)) {
    nodeFixed[metric] = nodeMetrics[metric];
    sources[metric] = "media_node";
  }

  let insightMetrics: PerformanceMetrics = {};
  // Why per-media insights could not be read, when they could not be. A
  // refused read stays visible on the item even when the media-node metrics
  // were still storable, because the snapshot is then only partial.
  let insightsBlocked: "insights_refused" | "insights_scope_missing" | null = null;
  if (input.insightsAllowed) {
    const read = await client.getMediaInsights({
      accessToken: input.accessToken,
      mediaId: row.instagram_media_id,
      metrics: INSIGHTS_METRICS_BY_KIND[input.contentType],
    });
    const normalized = normalizeInsightPayload({ data: read.entries });
    insightMetrics = normalized.metrics;
    for (const metric of normalized.metricsAvailable) sources[metric] = "insights";
    result.unavailableMetrics = read.unavailable;
    if (read.refused) insightsBlocked = "insights_refused";
  } else {
    insightsBlocked = "insights_scope_missing";
    result.unavailableMetrics = [...INSIGHTS_METRICS_BY_KIND[input.contentType]];
  }

  // Insights win over the media-node fallback for the same metric; both are
  // real Meta values, so either alone is a legitimate snapshot.
  const merged = mergeMetrics(insightMetrics, nodeFixed);
  const stored = availableMetrics(merged);
  if (!stored.length) {
    // Nothing was exposed. Voom stores NOTHING rather than a row of zeros.
    result.outcome = insightsBlocked ? "insights_unavailable" : "media_unavailable";
    result.code = insightsBlocked ?? "no_metrics_exposed";
    result.storedMetrics = [];
    return { result };
  }

  const { data: existing } = await db.from(PERFORMANCE_SNAPSHOT_TABLE)
    .select("id").eq("owner_user_id", input.ownerId)
    .eq("instagram_media_id", row.instagram_media_id).eq("collected_at", collectedAt).maybeSingle();
  const snapshot = {
    owner_user_id: input.ownerId,
    business_id: input.businessId,
    draft_id: row.draft_id,
    calendar_item_id: row.calendar_item_id,
    publish_queue_id: row.id,
    instagram_media_id: row.instagram_media_id,
    content_type: input.contentType,
    published_at: row.published_at,
    collected_at: collectedAt,
    metrics: merged,
    metric_sources: sources,
    provider_media_type: providerMediaType(details),
  };
  const { error } = await db.from(PERFORMANCE_SNAPSHOT_TABLE)
    .upsert(snapshot, { onConflict: "owner_user_id,instagram_media_id,collected_at" });
  if (error) throw new Error("performance_snapshot_write_failed");

  result.outcome = existing ? "refreshed" : "stored";
  // A partial snapshot (media-node metrics only) keeps the refusal visible, so
  // the run's own numbers never read as "everything came back".
  result.code = insightsBlocked ?? (existing ? "refreshed_snapshot" : "stored_snapshot");
  result.storedMetrics = stored;
  return { result };
}

/** Published-only source query: 'published' plus a real Meta media id. */
async function loadPublishedRows(
  db: SupabaseClient,
  input: { now: Date; limit: number; ownerIds?: string[] },
): Promise<PublishedRow[]> {
  const cutoff = new Date(input.now.getTime() - PERFORMANCE_SYNC_LOOKBACK_DAYS * 86_400_000).toISOString();
  let query = db.from("instagram_publish_queue")
    .select("id,owner_user_id,draft_id,calendar_item_id,media_kind,instagram_media_id,published_at")
    .eq("status", "published")
    .not("instagram_media_id", "is", null)
    .not("published_at", "is", null)
    .gte("published_at", cutoff)
    .order("published_at", { ascending: false })
    .limit(input.limit);
  if (input.ownerIds?.length) query = query.in("owner_user_id", input.ownerIds);
  const { data, error } = await query;
  if (error) throw new Error("performance_source_read_failed");
  return (data ?? [])
    .map((row) => ({
      id: String(row.id),
      owner_user_id: String(row.owner_user_id),
      draft_id: String(row.draft_id),
      calendar_item_id: row.calendar_item_id ? String(row.calendar_item_id) : null,
      media_kind: String(row.media_kind),
      instagram_media_id: String(row.instagram_media_id),
      published_at: row.published_at ? String(row.published_at) : "",
    }))
    .filter((row) => Boolean(row.instagram_media_id) && Boolean(row.published_at));
}

/** Truncates an instant to the snapshot collection window (hourly). */
export function collectionWindow(now: Date): Date {
  return new Date(Math.floor(now.getTime() / PERFORMANCE_COLLECTION_WINDOW_MS) * PERFORMANCE_COLLECTION_WINDOW_MS);
}

/**
 * Reads the error code off the client's typed error WITHOUT importing the
 * client module: the port only promises the code, so the sync can classify a
 * refusal/an authorization failure without depending on Meta's client.
 */
function readErrorCode(error: unknown): string | null {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  return typeof code === "string" ? code : null;
}

/** Built only when the caller did not inject a port (i.e. never in tests). */
async function createDefaultReadPort(config: InstagramConfig): Promise<PerformanceReadPort> {
  const { InstagramClient } = await import("@/lib/instagram/client");
  return new InstagramClient(config);
}

function providerMediaType(details: Record<string, unknown>): string | null {
  const value = details.media_product_type ?? details.media_type;
  return typeof value === "string" && value.length <= 40 ? value : null;
}
