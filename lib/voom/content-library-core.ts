/**
 * Pure Content-library vocabulary (no server imports), shared by the server
 * read model and the client library screen, and unit-testable.
 */
export type ContentBucket = "drafts" | "scheduled" | "published" | "attention" | "rejected";

export interface ContentItem {
  id: string;
  kind: string;
  channel: "instagram" | "tiktok" | "youtube";
  typeLabel: string;
  title: string;
  excerpt: string;
  hashtags: string[];
  scheduledAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Scheduled time when there is one, otherwise the last edit. */
  sortAt: string;
  /** Canonical publish state (lib/social/publish-state) or "rejected". */
  state: string;
  stateLabel: string;
  bucket: ContentBucket;
  origin: string | null;
  previewUrl: string | null;
  mediaName: string | null;
  mediaReady: boolean;
  failureMessage: string | null;
  /** Measured Instagram results, only where a stored measurement exists. */
  metrics: { views: number | null; likes: number | null; comments: number | null } | null;
  editor: "post" | "social";
}

/**
 * One bucket per state. Published requires provider confirmation (the
 * canonical lifecycle guarantees it); anything the provider is still handling
 * stays Scheduled; problems are never hidden inside another tab.
 */
export function contentBucket(state: string): ContentBucket {
  if (state === "published") return "published";
  if (state === "rejected") return "rejected";
  if (["scheduled", "submitting", "provider_processing"].includes(state)) return "scheduled";
  if (["failed", "blocked", "connection_required"].includes(state)) return "attention";
  return "drafts";
}

export const CONTENT_TABS: { id: "all" | ContentBucket; label: string }[] = [
  { id: "all", label: "All content" },
  { id: "drafts", label: "Drafts" },
  { id: "scheduled", label: "Scheduled" },
  { id: "published", label: "Published" },
  { id: "attention", label: "Needs attention" },
];

export type ContentPeriod = "all" | "7" | "30" | "month";

/** Client filters — every one acts on real item fields. */
export function filterContent(items: ContentItem[], options: {
  tab: "all" | ContentBucket;
  channel: "all" | ContentItem["channel"];
  period: ContentPeriod;
  query: string;
  sort: "newest" | "oldest";
  now: Date;
}): ContentItem[] {
  const query = options.query.trim().toLowerCase();
  const start = options.period === "all" ? null
    : options.period === "month" ? new Date(Date.UTC(options.now.getUTCFullYear(), options.now.getUTCMonth(), 1)).getTime()
      : options.now.getTime() - Number(options.period) * 86_400_000;
  const filtered = items.filter((item) =>
    (options.tab === "all" || item.bucket === options.tab)
    && (options.channel === "all" || item.channel === options.channel)
    && (start === null || Date.parse(item.sortAt) >= start)
    && (!query || `${item.title} ${item.excerpt} ${item.typeLabel}`.toLowerCase().includes(query)));
  return filtered.sort((a, b) => options.sort === "newest" ? b.sortAt.localeCompare(a.sortAt) : a.sortAt.localeCompare(b.sortAt));
}
