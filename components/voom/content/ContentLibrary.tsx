"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/voom/icons";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN, ChannelGlyph, EmptyPanel, PageHeader, StatCard, StatusChip } from "@/components/voom/redesign/ui";
import { compactNumber } from "@/lib/voom/today-metrics";
import { CONTENT_TABS, filterContent, type ContentBucket, type ContentItem, type ContentPeriod } from "@/lib/voom/content-library-core";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";

type Tab = "all" | ContentBucket;

export interface ContentPerformance {
  headline: string | null;
  windowDays: number;
  views: number | null;
  likes: number | null;
  comments: number | null;
  best: { title: string; typeLabel: string; basisValue: number | null; basisLabel: string | null } | null;
}

const PAGE_SIZE = 12;

/**
 * Content library (Figma "27 — Content · All content" … "30 — Published").
 * Every count, filter and card is a real item; editing opens the existing
 * Post / Social editors so approval, scheduling and publishing rules are the
 * same ones the rest of Voom enforces.
 */
export function ContentLibrary({ items, limited, unavailable, performance, initialTab = "all" }: {
  initialTab?: Tab;
  items: ContentItem[];
  limited: boolean;
  unavailable: boolean;
  performance: ContentPerformance | null;
}) {
  const router = useRouter();
  const { open } = useModal();
  const [tab, setTab] = useState<Tab>(initialTab);
  const [channel, setChannel] = useState<"all" | ContentItem["channel"]>("all");
  const [period, setPeriod] = useState<ContentPeriod>("all");
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<"newest" | "oldest">("newest");
  const [view, setView] = useState<"grid" | "list">("grid");
  const [shown, setShown] = useState(PAGE_SIZE);

  const counts = useMemo(() => items.reduce((acc, item) => ({ ...acc, [item.bucket]: (acc[item.bucket] ?? 0) + 1 }), {} as Record<ContentBucket, number>), [items]);
  const visible = useMemo(() => filterContent(items, { tab, channel, period, query, sort, now: new Date() }), [items, tab, channel, period, query, sort]);
  const tabs = CONTENT_TABS.filter((entry) => entry.id !== "attention" || (counts.attention ?? 0) > 0);

  function selectTab(next: Tab) {
    setTab(next);
    setShown(PAGE_SIZE);
    try { window.history.replaceState(null, "", next === "all" ? "/app/content" : `/app/content?tab=${next}`); } catch { /* cosmetic */ }
  }

  function edit(item: ContentItem) {
    const onChanged = () => router.refresh();
    open(item.editor === "social"
      ? <SocialEditorModal draftId={item.id} onChanged={onChanged} />
      : <PostEditorModal postId={item.id} onChanged={onChanged} />);
  }

  return (
    <div className="min-w-0">
      <PageHeader
        title="Content"
        subtitle="Plan, create, manage and publish content across all your channels."
        actions={<>
          <button type="button" className={BTN.outline} onClick={() => open(<CreateContentModal onChanged={() => router.refresh()} />)}>
            <Icon name="sparkle" size={14} /> Try with MARA
          </button>
          <Link href="/app/studio" className={BTN.primary}><Icon name="plus" size={15} /> Create content</Link>
        </>}
      />

      <div className="mb-5 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard icon="file" value={items.length} label="Total content" tone="brand" />
        <StatCard icon="cal" value={counts.scheduled ?? 0} label="Scheduled" tone="blue" />
        <StatCard icon="send" value={counts.published ?? 0} label="Published" tone="green" />
        <StatCard icon="clock" value={counts.drafts ?? 0} label="Drafts" tone="coral" />
      </div>

      <section className="voom-card min-w-0 overflow-hidden" aria-label="Content library">
        <div className="flex min-w-0 flex-col gap-3 border-b border-line px-4 pt-2 sm:px-6 lg:flex-row lg:items-center lg:justify-between">
          <div role="tablist" aria-label="Content status" className="-mb-px flex min-w-0 gap-1 overflow-x-auto">
            {tabs.map((entry) => {
              const count = entry.id === "all" ? items.length : counts[entry.id] ?? 0;
              const active = tab === entry.id;
              return (
                <button key={entry.id} type="button" role="tab" aria-selected={active} onClick={() => selectTab(entry.id)}
                  className={cx("flex shrink-0 items-center gap-2 border-b-2 px-3 py-4 text-[14.5px] transition", active ? "border-[var(--brand)] font-semibold text-[var(--brand-ink)]" : "border-transparent text-text-2 hover:text-text")}>
                  {entry.label}
                  <span className={cx("rounded-full px-2 py-0.5 text-[11.5px] font-semibold", active ? "bg-[var(--brand-soft)] text-[var(--brand-ink)]" : "bg-surface-3 text-text-2")}>{count}</span>
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap gap-2 pb-3 lg:pb-0">
            <label className="sr-only" htmlFor="content-channel">Channel</label>
            <select id="content-channel" value={channel} onChange={(event) => { setChannel(event.target.value as typeof channel); setShown(PAGE_SIZE); }} className={cx(BTN.field, "pr-8")}>
              <option value="all">All channels</option>
              <option value="instagram">Instagram</option>
              <option value="tiktok">TikTok</option>
              <option value="youtube">YouTube</option>
            </select>
            <label className="sr-only" htmlFor="content-period">Period</label>
            <select id="content-period" value={period} onChange={(event) => { setPeriod(event.target.value as ContentPeriod); setShown(PAGE_SIZE); }} className={cx(BTN.field, "pr-8")}>
              <option value="all">Any date</option>
              <option value="month">This month</option>
              <option value="7">Last 7 days onward</option>
              <option value="30">Last 30 days onward</option>
            </select>
          </div>
        </div>

        <div className="flex min-w-0 flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-end sm:px-6">
          <label className="relative min-w-0 sm:w-[300px]">
            <span className="sr-only">Search content</span>
            <Icon name="search" size={16} className="pointer-events-none absolute left-3.5 top-[14px] text-text-3" />
            <input value={query} onChange={(event) => { setQuery(event.target.value); setShown(PAGE_SIZE); }} placeholder="Search content…" className={cx(BTN.field, "w-full pl-10")} />
          </label>
          <div className="flex gap-2">
            <div className="flex rounded-[14px] border border-line p-1" role="group" aria-label="Layout">
              {(["grid", "list"] as const).map((mode) => (
                <button key={mode} type="button" aria-pressed={view === mode} onClick={() => setView(mode)} aria-label={mode === "grid" ? "Grid view" : "List view"}
                  className={cx("grid h-9 w-9 place-items-center rounded-[10px] transition", view === mode ? "bg-[var(--brand-soft)] text-[var(--brand-ink)]" : "text-text-2 hover:text-text")}>
                  <Icon name={mode === "grid" ? "grid" : "list"} size={16} />
                </button>
              ))}
            </div>
            <button type="button" className={BTN.quiet} onClick={() => setSort(sort === "newest" ? "oldest" : "newest")} aria-label={`Sort: ${sort === "newest" ? "newest first" : "oldest first"}`}>
              <Icon name="sort" size={15} /> {sort === "newest" ? "Newest first" : "Oldest first"}
            </button>
          </div>
        </div>

        {tab === "published" && performance && <PublishedInsights performance={performance} />}

        <div className="px-4 pb-5 sm:px-6">
          {unavailable ? (
            <EmptyPanel icon="warn" title="Content couldn’t load">Voom couldn’t read your content right now. Refresh to try again — nothing has been changed.</EmptyPanel>
          ) : visible.length === 0 ? (
            <TabEmpty tab={tab} filtered={items.length > 0 && (channel !== "all" || period !== "all" || Boolean(query))} onTab={selectTab} />
          ) : view === "grid" ? (
            <ul className="grid grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {visible.slice(0, shown).map((item) => <li key={item.id} className="min-w-0"><ContentCard item={item} onEdit={() => edit(item)} /></li>)}
            </ul>
          ) : (
            <ContentTable items={visible.slice(0, shown)} onEdit={edit} />
          )}
        </div>

        {visible.length > 0 && (
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-4 sm:px-6">
            <p className="text-[13.5px] text-text-2">
              Showing {Math.min(shown, visible.length)} of {visible.length}
              {limited && " · your 50 most recent posts per channel group"}
            </p>
            {shown < visible.length && <button type="button" className={BTN.quiet} onClick={() => setShown(shown + PAGE_SIZE)}>Load more</button>}
          </div>
        )}
      </section>
    </div>
  );
}

function PublishedInsights({ performance }: { performance: ContentPerformance }) {
  const tiles = [
    { label: "Views", value: performance.views },
    { label: "Likes", value: performance.likes },
    { label: "Comments", value: performance.comments },
  ].filter((tile) => tile.value !== null) as { label: string; value: number }[];
  return (
    <div className="px-4 pb-4 sm:px-6">
      {performance.headline && (
        <div className="mb-3 flex min-w-0 flex-col gap-3 rounded-[16px] border border-[rgba(31,143,108,0.18)] bg-[var(--green-soft)] p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-surface text-[var(--green)]"><Icon name="bars" size={17} /></span>
            <p className="min-w-0 text-[14px] leading-relaxed text-text">{performance.headline}</p>
          </div>
          <Link href="/app/performance" className={cx(BTN.primary, "h-10 shrink-0 self-start sm:self-auto")}>See performance <Icon name="arrow" size={14} /></Link>
        </div>
      )}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {tiles.map((tile) => (
          <div key={tile.label} className="voom-tile px-4 py-3">
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-3">{tile.label}</div>
            <div className="mt-1 text-[22px] font-bold tracking-[-0.03em] text-text">{compactNumber(tile.value)}</div>
            <div className="text-[12px] text-text-3">Instagram · last {performance.windowDays} days</div>
          </div>
        ))}
        {performance.best && (
          <div className="voom-tile px-4 py-3">
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.12em] text-text-3">Top post</div>
            <div className="mt-1 truncate text-[17px] font-bold tracking-[-0.02em] text-text">{performance.best.title || "Untitled"}</div>
            <div className="text-[12px] text-text-3">{performance.best.typeLabel}{performance.best.basisValue !== null && performance.best.basisLabel ? ` · ${compactNumber(performance.best.basisValue)} ${performance.best.basisLabel.toLowerCase()}` : ""}</div>
          </div>
        )}
      </div>
    </div>
  );
}

function ContentCard({ item, onEdit }: { item: ContentItem; onEdit: () => void }) {
  return (
    <article className="flex h-full min-w-0 flex-col rounded-[18px] border border-line bg-surface transition hover:border-[var(--line-2)] hover:shadow-[var(--shadow)]">
      <div className="flex items-center justify-between gap-2 px-3 pt-3">
        <ChannelGlyph channel={item.channel} size={20} />
        <StatusChip status={item.state} label={item.stateLabel} small />
      </div>
      <Link href={`/app/content/${item.id}`} className="mx-3 mt-2.5 block overflow-hidden rounded-[12px]" aria-label={`Open ${item.title}`}>
        <Thumb item={item} />
      </Link>
      <div className="min-w-0 flex-1 px-3 pt-3">
        <Link href={`/app/content/${item.id}`} className="block truncate text-[14.5px] font-semibold text-text hover:underline">{item.title}</Link>
        {item.excerpt && <p className="mt-0.5 truncate text-[13px] text-text-2">{item.excerpt}</p>}
        <p className="mt-2 flex items-center gap-1.5 text-[12.5px] text-text-2"><Icon name="cal" size={13} className="shrink-0" /><span className="truncate">{whenLabel(item)}</span></p>
      </div>
      <div className="mt-3 flex min-h-[48px] items-center justify-between gap-2 border-t border-line px-3 py-2">
        <CardFooter item={item} />
        <ItemMenu item={item} onEdit={onEdit} />
      </div>
    </article>
  );
}

function Thumb({ item, small = false }: { item: ContentItem; small?: boolean }) {
  return (
    <div className={cx("relative grid place-items-center overflow-hidden bg-[linear-gradient(140deg,var(--brand-soft),var(--surface-3))]", small ? "h-12 w-12 rounded-[10px]" : "aspect-[16/10] w-full")}>
      {item.previewUrl
        // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
        ? <img src={item.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
        : <span className="flex flex-col items-center gap-1 text-text-3"><Icon name={kindIcon(item.kind)} size={small ? 16 : 22} />{!small && <span className="text-[11.5px] font-medium">{item.mediaReady ? item.mediaName ?? "Media attached" : "No media yet"}</span>}</span>}
    </div>
  );
}

function CardFooter({ item }: { item: ContentItem }) {
  if (item.bucket === "published" && item.metrics) {
    return (
      <span className="flex gap-3 text-[12.5px] text-text-2">
        {item.metrics.views !== null && <span className="inline-flex items-center gap-1"><Icon name="eye" size={13} />{compactNumber(item.metrics.views)}</span>}
        {item.metrics.likes !== null && <span className="inline-flex items-center gap-1"><Icon name="heart" size={13} />{compactNumber(item.metrics.likes)}</span>}
        {item.metrics.comments !== null && <span className="inline-flex items-center gap-1"><Icon name="comment" size={13} />{compactNumber(item.metrics.comments)}</span>}
      </span>
    );
  }
  if (item.bucket === "attention") return <span className="line-clamp-2 text-[12px] text-[var(--red)]">{item.failureMessage ?? item.stateLabel}</span>;
  if (item.bucket === "scheduled" && item.scheduledAt) return <span className="text-[12.5px] text-text-2">{relative(item.scheduledAt)}</span>;
  return (
    <span className="flex min-w-0 items-center gap-2 text-[12.5px] text-text-2">
      <span className="truncate">Edited {relative(item.updatedAt)}</span>
      {item.bucket === "drafts" && <StatusChip status={item.mediaReady ? "published" : "missed"} label={item.mediaReady ? "Media ready" : "Needs media"} small />}
    </span>
  );
}

/** Per-item menu: only actions that exist (open the detail, open the editor). */
function ItemMenu({ item, onEdit }: { item: ContentItem; onEdit: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !ref.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("click", close, true);
    document.addEventListener("keydown", close);
    return () => { document.removeEventListener("click", close, true); document.removeEventListener("keydown", close); };
  }, [open]);
  return (
    <div className="relative shrink-0" ref={ref}>
      <button type="button" onClick={() => setOpen(!open)} aria-haspopup="menu" aria-expanded={open} aria-label={`Actions for ${item.title}`}
        className="grid h-8 w-8 place-items-center rounded-full text-text-2 transition hover:bg-surface-3 hover:text-text">
        <Icon name="dots" size={16} />
      </button>
      {open && (
        <div role="menu" className="absolute bottom-10 right-0 z-30 w-44 rounded-[14px] border border-line bg-surface p-1.5 shadow-[var(--shadow-lg)]">
          <Link role="menuitem" href={`/app/content/${item.id}`} className="flex items-center gap-2 rounded-[10px] px-3 py-2 text-[13.5px] text-text hover:bg-surface-3"><Icon name="eye" size={14} /> Open details</Link>
          <button role="menuitem" type="button" onClick={() => { setOpen(false); onEdit(); }} className="flex w-full items-center gap-2 rounded-[10px] px-3 py-2 text-left text-[13.5px] text-text hover:bg-surface-3"><Icon name="pencil" size={14} /> Edit</button>
        </div>
      )}
    </div>
  );
}

function ContentTable({ items, onEdit }: { items: ContentItem[]; onEdit: (item: ContentItem) => void }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[720px] text-left text-[14px]">
        <thead className="text-[11.5px] uppercase tracking-[0.12em] text-text-3">
          <tr className="border-b border-line">
            <th className="py-3 pr-3 font-semibold">Content</th>
            <th className="py-3 pr-3 font-semibold">Channel</th>
            <th className="py-3 pr-3 font-semibold">Date and time</th>
            <th className="py-3 pr-3 font-semibold">Status</th>
            <th className="py-3 font-semibold"><span className="sr-only">Actions</span></th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => (
            <tr key={item.id} className="border-b border-line last:border-b-0">
              <td className="py-3 pr-3">
                <Link href={`/app/content/${item.id}`} className="flex min-w-0 items-center gap-3">
                  <Thumb item={item} small />
                  <span className="min-w-0">
                    <span className="block max-w-[320px] truncate font-semibold text-text">{item.title}</span>
                    <span className="block text-[12.5px] text-text-2">{item.typeLabel}</span>
                  </span>
                </Link>
              </td>
              <td className="py-3 pr-3"><ChannelGlyph channel={item.channel} size={22} /></td>
              <td className="py-3 pr-3 text-text-2">{whenLabel(item)}</td>
              <td className="py-3 pr-3"><StatusChip status={item.state} label={item.stateLabel} small /></td>
              <td className="py-3 text-right"><ItemMenu item={item} onEdit={() => onEdit(item)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function TabEmpty({ tab, filtered, onTab }: { tab: Tab; filtered: boolean; onTab: (tab: Tab) => void }) {
  if (filtered) return <EmptyPanel icon="filter" title="No content matches these filters">Change the channel, date or search to see more.</EmptyPanel>;
  if (tab === "published") return <EmptyPanel icon="send" title="Nothing published yet" actions={<button type="button" className={BTN.quiet} onClick={() => onTab("scheduled")}>View scheduled</button>}>Posts appear here once the platform confirms they went live.</EmptyPanel>;
  if (tab === "scheduled") return <EmptyPanel icon="cal" title="Nothing scheduled" actions={<button type="button" className={BTN.quiet} onClick={() => onTab("drafts")}>Go to drafts</button>}>Approve a draft with a date and time and it shows up here.</EmptyPanel>;
  if (tab === "drafts") return <EmptyPanel icon="file" title="No drafts" actions={<Link href="/app/studio" className={BTN.primary}>Create content</Link>}>Drafts you or MARA create appear here until they’re scheduled.</EmptyPanel>;
  return <EmptyPanel icon="file" title="No content yet" actions={<Link href="/app/studio" className={BTN.primary}>Create content</Link>}>Create your first post, Reel, Story or video to start your library.</EmptyPanel>;
}

function kindIcon(kind: string) {
  if (kind === "reel") return "reel";
  if (kind === "story") return "story";
  if (kind.includes("video") || kind.includes("short")) return "video";
  return "img";
}

function whenLabel(item: ContentItem) {
  const at = item.scheduledAt;
  if (!at) return item.bucket === "drafts" ? "No time set" : "—";
  const date = new Date(at);
  const today = new Date();
  const sameDay = date.toDateString() === today.toDateString();
  const label = new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(date);
  const time = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date);
  return `${sameDay ? "Today · " : ""}${label} · ${time}`;
}

function relative(iso: string) {
  const diff = Date.parse(iso) - Date.now();
  if (!Number.isFinite(diff)) return "—";
  const minutes = Math.round(Math.abs(diff) / 60_000);
  const unit = minutes < 60 ? `${minutes} min` : minutes < 1440 ? `${Math.round(minutes / 60)}h` : `${Math.round(minutes / 1440)} day${Math.round(minutes / 1440) === 1 ? "" : "s"}`;
  return diff >= 0 ? `In ${unit}` : `${unit} ago`;
}
