"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN, ChannelGlyph, CreateStepper, PageHeader, StatusChip } from "@/components/voom/redesign/ui";
import { isSocialVideoDraftKind, type SocialVideoDraftKind } from "@/lib/post/core";
import { channelIdentity } from "@/lib/voom/workflow/presentation";
import { cx } from "@/lib/voom/cx";

type StudioKind = "instagram_post" | "reel" | "story" | SocialVideoDraftKind;

interface StudioPost {
  id: string;
  kind: StudioKind;
  typeLabel: string;
  concept: string;
  internalState: "draft" | "approved" | "scheduled_internal" | "ready_to_publish";
  internalStateLabel: string;
  scheduledAt: string | null;
  visualReady: boolean;
  visual: { previewUrl: string | null; mimeType: string; displayName: string } | null;
  updatedAt: string;
}

interface PlanItem { draftId: string; concept: string; status: string; channel: string }

/** Every format Voom really publishes, on the channel that publishes it. */
const FORMATS: { kind: StudioKind; label: string; detail: string; icon: string; channel: "instagram" | "tiktok" | "youtube" }[] = [
  { kind: "instagram_post", label: "Instagram Post", detail: "A single image or text update for the feed.", icon: "img", channel: "instagram" },
  { kind: "reel", label: "Instagram Reel", detail: "Short vertical video, up to 90 seconds.", icon: "reel", channel: "instagram" },
  { kind: "story", label: "Instagram Story", detail: "A quick update that disappears after 24 hours.", icon: "story", channel: "instagram" },
  { kind: "tiktok_video", label: "TikTok Video", detail: "Vertical video with a hook and a one-line caption.", icon: "video", channel: "tiktok" },
  { kind: "youtube_short", label: "YouTube Short", detail: "Short vertical video with a search-friendly title.", icon: "reel", channel: "youtube" },
  { kind: "youtube_video", label: "YouTube Video", detail: "Long-form horizontal video with a title and description.", icon: "video", channel: "youtube" },
];

const DEFAULT_TITLES: Record<StudioKind, string> = {
  instagram_post: "New Instagram Post",
  reel: "New Reel",
  story: "New Instagram Story",
  tiktok_video: "New TikTok Video",
  youtube_short: "New YouTube Short",
  youtube_video: "New YouTube Video",
};

const PLAN_OPEN_STATES = new Set(["needs_approval", "ready_for_review", "waiting_for_media", "generating", "draft"]);

/**
 * Create · Compose (Figma "21 — Create · Empty state", Keep).
 * Step 1 of Compose → Preview → Schedule. Choosing a format and continuing
 * creates a real draft through the existing `/api/posts` create route, then
 * the flow continues on that draft. Existing drafts reopen in the existing
 * Post / Social editors. Nothing is published from this screen.
 */
export default function StudioPage() {
  const router = useRouter();
  const { open } = useModal();
  const [posts, setPosts] = useState<StudioPost[]>([]);
  const [plan, setPlan] = useState<PlanItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [kind, setKind] = useState<StudioKind | null>(null);
  const [idea, setIdea] = useState("");
  const [busy, setBusy] = useState<"mara" | "continue" | "save" | null>(null);

  const load = useCallback(async () => {
    try {
      const [postsResponse, workflowResponse] = await Promise.all([
        fetch("/api/posts", { cache: "no-store" }),
        fetch("/api/voom/workflow", { cache: "no-store" }).catch(() => null),
      ]);
      const body = await postsResponse.json() as { posts?: StudioPost[]; error?: string };
      if (!postsResponse.ok) throw new Error(body.error ?? "Your content couldn't load.");
      setPosts(body.posts ?? []);
      if (workflowResponse?.ok) {
        const workflow = await workflowResponse.json() as { snapshot?: { items?: PlanItem[] } };
        setPlan((workflow.snapshot?.items ?? []).filter((item) => PLAN_OPEN_STATES.has(item.status)).slice(0, 3));
      }
      setError("");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your content couldn't load.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Deferred so the fetch callback is not a synchronous setState in the effect.
  useEffect(() => { const timer = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(timer); }, [load]);
  useEffect(() => {
    const refresh = () => void load();
    window.addEventListener("voom:data-changed", refresh);
    return () => window.removeEventListener("voom:data-changed", refresh);
  }, [load]);

  const recent = useMemo(() => [...posts].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(0, 3), [posts]);
  const chosen = FORMATS.find((entry) => entry.kind === kind) ?? null;

  /** Creates the draft through the existing create route, then continues the flow on it. */
  async function start(mode: "mara" | "continue" | "save") {
    if (!kind) return;
    setBusy(mode);
    setError("");
    try {
      const response = await fetch("/api/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, origin: mode === "mara" ? "mara" : "own_asset", concept: idea.trim().slice(0, 160) || DEFAULT_TITLES[kind] }),
      });
      const body = await response.json() as { id?: string; error?: string };
      if (!response.ok || !body.id) throw new Error(body.error ?? "Voom couldn't start that draft.");
      window.dispatchEvent(new Event("voom:data-changed"));
      if (mode === "save") {
        router.push(`/app/content/${body.id}`);
      } else {
        router.push(`/app/studio/${body.id}`);
        // Compose happens in the existing editor for this format.
        open(isSocialVideoDraftKind(kind)
          ? <SocialEditorModal draftId={body.id} onChanged={() => router.refresh()} />
          : <PostEditorModal postId={body.id} onChanged={() => router.refresh()} />);
      }
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't start that draft.");
      setBusy(null);
    }
  }

  const checks = [
    { label: "Format", done: Boolean(kind) },
    { label: "Media", done: false },
    { label: "Channel", done: Boolean(kind) },
    { label: "Caption", done: false },
  ];

  return (
    <div className="min-w-0 pb-24">
      <PageHeader title="What do you want to create?" subtitle="Pick a format to start. You can change it later." actions={<CreateStepper step={1} />} />

      {error && <div role="alert" className="mb-4 rounded-[16px] border border-[var(--red)]/30 bg-[var(--red-soft)] px-4 py-3 text-[14px] text-[var(--red)]">{error}</div>}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="voom-card p-5 sm:p-6" aria-labelledby="create-format">
            <h2 id="create-format" className="text-[17px] font-semibold text-text">Choose a format</h2>
            <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-3" role="radiogroup" aria-label="Format">
              {FORMATS.map((entry) => {
                const selected = kind === entry.kind;
                return (
                  <button key={entry.kind} type="button" role="radio" aria-checked={selected} onClick={() => setKind(entry.kind)}
                    className={cx("flex min-h-[176px] min-w-0 flex-col rounded-[16px] border p-4 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--brand-line)]",
                      selected ? "border-[var(--brand)] bg-[var(--brand-soft-2)] shadow-[0_0_0_3px_var(--brand-soft)]" : "border-line bg-[linear-gradient(180deg,var(--surface),var(--brand-soft-2))] hover:border-[var(--brand-line)]")}>
                    <span className="grid h-9 w-9 place-items-center rounded-[10px] bg-surface text-text-2 ring-1 ring-line"><Icon name={entry.icon} size={17} /></span>
                    <span className="mt-4 text-[15px] font-semibold text-text">{entry.label}</span>
                    <span className="mt-1.5 flex-1 text-[13px] leading-relaxed text-text-2">{entry.detail}</span>
                    <span className="mt-3 flex items-center gap-1.5 text-[12px] text-text-2"><ChannelGlyph channel={entry.channel} size={16} />{channelIdentity(entry.channel).label}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="create-mara">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="voom-create-btn grid h-8 w-8 place-items-center rounded-[10px] text-white"><Icon name="sparkle" size={14} /></span>
              <h2 id="create-mara" className="text-[17px] font-semibold text-text">Or start with MARA</h2>
              <p className="text-[13.5px] text-text-2">Describe the idea — it becomes the draft’s working title, and MARA creates the visual when you ask it to.</p>
            </div>
            <div className="mt-4 flex min-w-0 flex-col gap-3 sm:flex-row">
              <label className="min-w-0 flex-1">
                <span className="sr-only">Describe the idea</span>
                <input value={idea} onChange={(event) => setIdea(event.target.value)} maxLength={160} placeholder="e.g. A Reel showing our 3-step evening skincare routine" className={cx(BTN.field, "w-full")} />
              </label>
              <button type="button" className={BTN.primary} disabled={!kind || !idea.trim() || busy !== null} onClick={() => void start("mara")}>
                {busy === "mara" ? "Starting…" : "Draft with MARA"}
              </button>
            </div>
            {!kind && <p className="mt-2 text-[12.5px] text-text-3">Choose a format first so MARA drafts the right kind of post.</p>}
            {plan.length > 0 && (
              <div className="mt-4 flex flex-wrap items-center gap-2">
                <span className="text-[13.5px] text-text-2">From this week’s plan:</span>
                {plan.map((item) => (
                  <Link key={item.draftId} href={`/app/studio/${item.draftId}`} className="max-w-full truncate rounded-full border border-[var(--brand-line)] bg-[var(--brand-soft-2)] px-3.5 py-1.5 text-[13.5px] font-semibold text-[var(--brand-ink)] hover:bg-[var(--brand-soft)]">{item.concept}</Link>
                ))}
              </div>
            )}
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="create-continue">
            <div className="flex items-center justify-between gap-3">
              <h2 id="create-continue" className="text-[17px] font-semibold text-text">Continue where you left off</h2>
              <Link href="/app/content?tab=drafts" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">All drafts</Link>
            </div>
            {loading ? <p className="mt-4 text-[14px] text-text-3">Loading your recent work…</p> : recent.length ? (
              <ul className="mt-3 divide-y divide-line">
                {recent.map((post) => (
                  <li key={post.id} className="flex min-w-0 items-center gap-3 py-3">
                    <Link href={`/app/studio/${post.id}`} className="flex min-w-0 flex-1 items-center gap-3">
                      <span className="relative grid h-11 w-11 shrink-0 place-items-center overflow-hidden rounded-[10px] bg-[var(--brand-soft)] text-[var(--brand-ink)]">
                        {post.visual?.previewUrl && !post.visual.mimeType.startsWith("video")
                          // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
                          ? <img src={post.visual.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                          : <Icon name={isSocialVideoDraftKind(post.kind) || post.kind === "reel" ? "video" : "img"} size={16} />}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[14.5px] font-semibold text-text">{post.concept || "Untitled"}</span>
                        <span className="block truncate text-[13px] text-text-2">{post.typeLabel} · Edited {relative(post.updatedAt)}</span>
                      </span>
                    </Link>
                    <StatusChip status={post.internalState === "draft" ? "draft" : "scheduled"} label={post.internalStateLabel} small />
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-[14px] text-text-2">No drafts yet — choose a format above to start your first one.</p>}
          </section>
        </div>

        <aside className="flex min-w-0 flex-col gap-5">
          <section className="voom-card p-5 sm:p-6" aria-labelledby="create-preview">
            <h2 id="create-preview" className="text-[17px] font-semibold text-text">Preview</h2>
            <div className="mt-4 grid place-items-center rounded-[16px] bg-surface-2 px-6 py-8 text-center">
              <span className={cx("grid place-items-center rounded-[12px] border border-dashed border-line-2 text-text-3", chosen?.kind === "youtube_video" ? "h-[72px] w-[128px]" : chosen?.kind === "instagram_post" ? "h-[96px] w-[96px]" : "h-[150px] w-[96px]")}>
                <Icon name="eye" size={20} />
              </span>
              <p className="mt-4 text-[15px] font-semibold text-text">{chosen ? `${chosen.label} selected` : "Nothing to preview yet"}</p>
              <p className="mt-1 max-w-xs text-[13px] leading-relaxed text-text-2">{chosen ? "Continue to add the caption and media, then preview exactly what will publish." : "Choose a format and add media to see how it will look on its channel."}</p>
            </div>
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="create-ready">
            <div className="flex items-center justify-between">
              <h2 id="create-ready" className="text-[15px] font-semibold text-text">Ready to schedule</h2>
              <span className="text-[13px] text-text-2">{checks.filter((check) => check.done).length} of {checks.length}</span>
            </div>
            <ul className="mt-3 space-y-2.5">
              {checks.map((check) => (
                <li key={check.label} className="flex items-center gap-3 text-[14px]">
                  <span className={cx("grid h-5 w-5 place-items-center rounded-full", check.done ? "bg-[var(--green-soft)] text-[var(--green)]" : "border border-dashed border-line-2")}>{check.done && <Icon name="check" size={11} />}</span>
                  <span className={check.done ? "font-semibold text-text" : "text-text-2"}>{check.label}</span>
                </li>
              ))}
            </ul>
            <p className="mt-4 border-t border-line pt-3 text-[12.5px] leading-relaxed text-text-3">
              Publishing truth: nothing leaves Voom until you schedule and approve a post, and it shows Published only after the platform confirms it.
            </p>
          </section>
        </aside>
      </div>

      <div className="fixed inset-x-0 bottom-[68px] z-20 border-t border-line bg-[var(--topbar-bg)] backdrop-blur-[16px] md:bottom-0 md:left-[264px]">
        <div className="mx-auto flex max-w-[1280px] items-center justify-between gap-3 px-4 py-3 sm:px-6 lg:px-10">
          <p className="hidden truncate text-[14px] text-text-2 sm:block">{chosen ? `${chosen.label} — ${chosen.detail}` : "Choose a format to begin"}</p>
          <div className="flex flex-1 justify-end gap-2.5 sm:flex-none">
            <button type="button" className={cx(BTN.quiet, "rounded-full")} disabled={!kind || busy !== null} onClick={() => void start("save")}>{busy === "save" ? "Saving…" : "Save draft"}</button>
            <button type="button" className={BTN.primary} disabled={!kind || busy !== null} onClick={() => void start("continue")}>
              {busy === "continue" ? "Starting…" : "Continue"} <Icon name="arrow" size={15} />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function relative(iso: string) {
  const minutes = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (!Number.isFinite(minutes)) return "recently";
  if (minutes < 60) return `${Math.max(1, minutes)} min ago`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h ago`;
  const days = Math.round(minutes / 1440);
  return days === 1 ? "yesterday" : `${days} days ago`;
}
