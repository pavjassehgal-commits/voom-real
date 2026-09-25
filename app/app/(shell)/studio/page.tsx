"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "@/components/voom/icons";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { Btn, Chip, Tag } from "@/components/voom/ui/primitives";
import { isSocialVideoDraftKind, type SocialVideoDraftKind } from "@/lib/post/core";
import {
  ChannelPill,
  Disclosure,
  MetaChip,
  Panel,
  PanelHead,
  ProgressDots,
  QuietState,
  SectionLabel,
  WorkspaceFrame,
  WorkspaceHeader,
} from "@/components/voom/workspace/ui";
import { channelClasses, channelIdentity } from "@/lib/voom/workflow/presentation";

type StudioKind = "instagram_post" | "reel" | "story" | SocialVideoDraftKind;

interface StudioPost {
  id: string;
  kind: StudioKind;
  typeLabel: string;
  concept: string;
  format: string;
  originLabel: string;
  internalState: "draft" | "approved" | "scheduled_internal" | "ready_to_publish";
  internalStateLabel: string;
  scheduledAt: string | null;
  visualReady: boolean;
  visual: { previewUrl: string | null; mimeType: string; displayName: string } | null;
  updatedAt: string;
}

/** The same internal-state vocabulary the studio read model already returns. */
const STATE_TONE: Record<StudioPost["internalState"], string> = {
  draft: "t-amber",
  approved: "t-blue",
  scheduled_internal: "t-green",
  ready_to_publish: "t-green",
};

const STATE_ORDER: StudioPost["internalState"][] = ["draft", "approved", "scheduled_internal", "ready_to_publish"];

/**
 * The internal stages Voom tracks for one piece of work. The labels shown are
 * the read model's own labels — the Studio never invents a fifth stage, and
 * "Ready to publish" is explicitly an INTERNAL readiness, not a publication.
 */
const STAGE_COPY: Record<StudioPost["internalState"], { label: string; hint: string }> = {
  draft: { label: "Draft", hint: "Being written. Nothing is scheduled and nothing leaves Voom." },
  approved: { label: "Approved", hint: "You approved it. It needs a schedule and a stored visual." },
  scheduled_internal: { label: "Scheduled internally", hint: "Approved with a time, still missing its visual." },
  ready_to_publish: { label: "Ready to publish", hint: "Approved, scheduled and holding a real stored visual." },
};

/** Which channel identity a Studio draft belongs to. */
const KIND_CHANNEL: Record<StudioKind, "instagram" | "tiktok" | "youtube"> = {
  instagram_post: "instagram",
  reel: "instagram",
  story: "instagram",
  tiktok_video: "tiktok",
  youtube_short: "youtube",
  youtube_video: "youtube",
};

interface FormatChoice { kind: StudioKind; channel: "instagram" | "tiktok" | "youtube"; label: string; detail: string }

const FORMATS: FormatChoice[] = [
  { kind: "instagram_post", channel: "instagram", label: "Instagram Post", detail: "1:1 or 4:5 feed post with caption, CTA and hashtags." },
  { kind: "reel", channel: "instagram", label: "Reel", detail: "9:16 video — film it yourself, import one, or Create with MARA." },
  { kind: "story", channel: "instagram", label: "Instagram Story", detail: "9:16 full-screen visual. Stories carry no caption." },
  { kind: "tiktok_video", channel: "tiktok", label: "TikTok Video", detail: "Vertical video: hook, beats and a one-line caption." },
  { kind: "youtube_short", channel: "youtube", label: "YouTube Short", detail: "Short vertical video with a search-friendly title." },
  { kind: "youtube_video", channel: "youtube", label: "YouTube Video", detail: "Longer form: title, full description and outline." },
];

const CHANNEL_STARTS: { channel: "instagram" | "tiktok" | "youtube"; note: string }[] = [
  { channel: "instagram", note: "Posts, Reels and Stories. Real publishing through your connected account." },
  { channel: "tiktok", note: "TikTok-native videos. Published only after TikTok's own post status confirms." },
  { channel: "youtube", note: "Shorts and full videos. Published only after YouTube confirms processing." },
];

export default function StudioPage() {
  const { open } = useModal();
  const { goTo } = useVoomActions();
  const [posts, setPosts] = useState<StudioPost[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [channelFilter, setChannelFilter] = useState<"all" | "instagram" | "tiktok" | "youtube">("all");
  const [stateFilter, setStateFilter] = useState<"all" | StudioPost["internalState"]>("all");

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/posts", { cache: "no-store" });
      const body = await response.json() as { posts?: StudioPost[]; error?: string };
      if (!response.ok) throw new Error(body.error ?? "Your content couldn't load.");
      setPosts(body.posts ?? []);
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

  const counts = useMemo(() => posts.reduce(
    (acc, post) => ({ ...acc, [post.internalState]: (acc[post.internalState] ?? 0) + 1 }),
    {} as Record<string, number>,
  ), [posts]);

  const visible = useMemo(
    () => posts.filter((post) =>
      (channelFilter === "all" || KIND_CHANNEL[post.kind] === channelFilter)
      && (stateFilter === "all" || post.internalState === stateFilter)),
    [posts, channelFilter, stateFilter],
  );

  const openDraft = useCallback((post: StudioPost) => {
    open(isSocialVideoDraftKind(post.kind)
      ? <SocialEditorModal draftId={post.id} onChanged={() => void load()} />
      : <PostEditorModal postId={post.id} onChanged={() => void load()} />);
  }, [open, load]);

  const create = () => open(<CreateContentModal onChanged={() => void load()} />);

  return (
    <WorkspaceFrame>
      <WorkspaceHeader
        eyebrow="Create · Studio"
        title="Create content"
        question="What am I creating, and how close is each piece to ready?"
        description="One Studio for every platform Voom actually publishes to. Drafts, approvals and internal schedules live here; publishing happens later through each channel's own queue."
        meta={<>
          {STATE_ORDER.map((state) => (
            <MetaChip key={state}>{STAGE_COPY[state].label} <b className="ml-1 text-text">{counts[state] ?? 0}</b></MetaChip>
          ))}
        </>}
        actions={<>
          <Btn variant="ghost" size="sm" onClick={() => goTo("calendar")}>
            <Icon name="cal" size={14} /> Content Calendar
          </Btn>
          <Btn variant="brand" size="sm" onClick={create}>
            <Icon name="plus" size={14} /> Create content
          </Btn>
        </>}
      />

      {error ? <div role="alert" className="relative z-10 mb-3.5 rounded-2xl border border-red/35 bg-red/10 px-4 py-3 text-[13px] text-red">{error}</div> : null}

      {/* ── How close is it to ready ─────────────────────────────────────── */}
      <Panel className="relative z-10 mb-3.5">
        <PanelHead
          icon="trend"
          title="How close is it to ready"
          hint="These are Voom's internal stages. Provider confirmation is a separate, later step — the Studio never marks anything published."
        />
        {/* Two stages per row on a phone: the four readiness stages stay
            scannable instead of costing a full screen each. */}
        <ol className="mt-4 grid min-w-0 grid-cols-2 gap-2 lg:grid-cols-4">
          {STATE_ORDER.map((state, index) => (
            <li key={state} className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] font-bold uppercase tracking-[0.12em] text-text-3">Stage {index + 1}</span>
                <b className="font-display text-[19px] font-semibold tracking-[-0.02em]">{counts[state] ?? 0}</b>
              </div>
              <p className="mt-1.5 text-[13px] font-semibold text-text">{STAGE_COPY[state].label}</p>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">{STAGE_COPY[state].hint}</p>
            </li>
          ))}
        </ol>
      </Panel>

      {/* ── Start something new ──────────────────────────────────────────── */}
      <Panel className="relative z-10 mb-3.5">
        <PanelHead
          icon="plus"
          title="Start something new"
          hint="Pick the platform, then the native format. Voom keeps the draft internal until you approve it."
        />
        <div className="mt-4 grid min-w-0 gap-3 lg:grid-cols-3">
          {CHANNEL_STARTS.map((entry) => (
            <div key={entry.channel} className="min-w-0 rounded-2xl border border-line bg-[var(--surface)]/70 p-3.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className={`h-2 w-2 flex-none rounded-full ${channelClasses(entry.channel).dot}`} aria-hidden="true" />
                <b className="text-[14px] font-semibold">{channelIdentity(entry.channel).label}</b>
              </div>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">{entry.note}</p>
              <div className="mt-3 min-w-0 space-y-1.5">
                {FORMATS.filter((format) => format.channel === entry.channel).map((format) => (
                  <button
                    key={format.kind}
                    type="button"
                    onClick={() => open(<CreateContentModal onChanged={() => void load()} startWith={format.channel} />)}
                    className="ws-row flex w-full min-w-0 items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left transition hover:border-brand"
                  >
                    <span className="min-w-0">
                      <span className="block truncate text-[12.5px] font-semibold text-text">{format.label}</span>
                      <span className="mt-0.5 block text-[11px] leading-snug text-text-3">{format.detail}</span>
                    </span>
                    <Icon name="arrow" size={13} className="flex-none text-text-3" />
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="mt-3 flex min-w-0 flex-col gap-2 rounded-2xl border border-line bg-surface-2 p-3.5 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-text">
              <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--ch-email)" }} />
              Email
            </span>
            <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">
              Email is not created in the Studio. Voom drafts and sends email in Campaigns and Email Flows, on its own cadence — it never fills a social slot.
            </p>
          </div>
          <div className="flex flex-none flex-wrap gap-2">
            <Btn variant="outline" size="sm" onClick={() => goTo("campaigns")}>Campaigns</Btn>
            <Btn variant="ghost" size="sm" onClick={() => goTo("automations")}>Email Flows</Btn>
          </div>
        </div>

        <div className="mt-3 min-w-0 rounded-2xl border border-line bg-surface-2 p-3.5">
          <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
            <div className="min-w-0">
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-text">
                <Icon name="film" size={13} className="text-text-2" /> MARA Reel workflow
              </span>
              <p className="mt-1 text-[11.5px] leading-relaxed text-text-3">
                Concept, script, asset pack and the playable preview stay under Approvals — film it yourself, use an existing asset, or Create with MARA.
              </p>
            </div>
            <Btn variant="outline" size="sm" onClick={() => goTo("approvals")}>Open Approvals</Btn>
          </div>
        </div>
      </Panel>

      {/* ── Everything you are creating ──────────────────────────────────── */}
      <Panel className="relative z-10">
        <PanelHead
          icon="film"
          title="Everything you're creating"
          hint={posts.length ? `${posts.length} draft${posts.length === 1 ? "" : "s"} in the Studio — open one to edit, upload media or schedule it.` : undefined}
          action={posts.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-1.5">
              <Chip active={channelFilter === "all"} onClick={() => setChannelFilter("all")}>All channels</Chip>
              {(["instagram", "tiktok", "youtube"] as const).map((channel) => (
                <Chip key={channel} active={channelFilter === channel} onClick={() => setChannelFilter(channel)}>
                  {channelIdentity(channel).label}
                </Chip>
              ))}
            </div>
          ) : undefined}
        />

        {posts.length > 0 && (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
            <Chip active={stateFilter === "all"} onClick={() => setStateFilter("all")}>Any stage</Chip>
            {STATE_ORDER.map((state) => (
              <Chip key={state} active={stateFilter === state} onClick={() => setStateFilter(state)}>
                {STAGE_COPY[state].label}
              </Chip>
            ))}
          </div>
        )}

        {loading ? <p className="py-8 text-center text-[13px] text-text-3">Loading your content…</p> : null}

        {!loading && !posts.length ? (
          <QuietState icon="spark" title="Nothing here yet">
            <p>Choose <b>Create content</b> and pick a platform — Instagram, TikTok or YouTube. The draft stays inside Voom until you approve it.</p>
            <div className="mt-4"><Btn variant="brand" onClick={create}><Icon name="plus" size={14} /> Create content</Btn></div>
          </QuietState>
        ) : null}

        {!loading && posts.length > 0 && visible.length === 0 ? (
          <QuietState icon="filter" title="Nothing matches these filters">
            <p>No draft in this channel and stage combination. Clear a filter to see the rest of your work.</p>
            <div className="mt-4"><Btn variant="outline" size="sm" onClick={() => { setChannelFilter("all"); setStateFilter("all"); }}>Clear filters</Btn></div>
          </QuietState>
        ) : null}

        {visible.length > 0 && (
          <div className="mt-4 grid min-w-0 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map((post) => (
              <article key={post.id} className="ws-row group min-w-0 overflow-hidden rounded-2xl border border-line bg-[var(--surface)]/70">
                <button type="button" onClick={() => openDraft(post)} className="block w-full min-w-0 text-left">
                  <div className="relative grid h-[104px] place-items-center bg-surface-2">
                    {post.visual?.previewUrl && !post.visual.mimeType.startsWith("video/") ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={post.visual.previewUrl} alt={post.visual.displayName} className="h-full w-full object-cover" />
                    ) : (
                      <span className="flex flex-col items-center gap-1.5 text-[11.5px] text-text-3">
                        <Icon name={post.visualReady ? "play" : "img"} size={18} />
                        {post.visualReady ? "Video stored privately" : "No visual yet"}
                      </span>
                    )}
                    <span className="absolute left-2 top-2"><ChannelPill channel={KIND_CHANNEL[post.kind]} format={undefined} dense /></span>
                  </div>
                  <div className="min-w-0 p-3.5">
                    <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
                      <Tag tone="t-brand">{post.typeLabel}</Tag>
                      <Tag tone={STATE_TONE[post.internalState]}>{post.internalStateLabel}</Tag>
                      <Tag tone="t-grey">{post.format}</Tag>
                    </div>
                    <b className="block truncate text-[14px]">{post.concept || "Untitled"}</b>
                    <span className="mt-1 block truncate text-[11.5px] text-text-3">
                      {post.originLabel}
                      {post.scheduledAt ? ` · ${formatStudioSchedule(post.scheduledAt)}` : ""}
                    </span>
                    <ProgressDots className="mt-2.5" steps={readinessOf(post)} />
                  </div>
                </button>

                <div className="border-t border-line px-3.5 py-2">
                  <Disclosure summary="What this stage means">
                    <div className="space-y-1.5 text-[11.5px] leading-relaxed text-text-2">
                      <p>{STAGE_COPY[post.internalState].hint}</p>
                      <p className="text-text-3">
                        {post.visualReady
                          ? `Visual stored privately in Voom${post.visual?.displayName ? `: ${post.visual.displayName}` : ""}.`
                          : "No stored visual yet — Voom will not queue anything without one."}
                      </p>
                      <p className="text-text-3">
                        Approved and scheduled work appears on the Content Calendar and publishes only after the provider
                        itself confirms it. Uploading or editing here never spends a generation credit.
                      </p>
                    </div>
                  </Disclosure>
                </div>
              </article>
            ))}
          </div>
        )}

        <div className="mt-4 min-w-0 rounded-2xl bg-surface-2 px-3.5 py-3">
          <SectionLabel>The publishing truth</SectionLabel>
          <p className="mt-1.5 text-[11.5px] leading-relaxed text-text-3">
            Approved items with a schedule and a stored visual publish to your connected accounts at their scheduled time.
            Voom marks something “Published” only after the provider itself confirms it: Instagram&apos;s media id,
            TikTok&apos;s own PUBLISH_COMPLETE post status, or YouTube&apos;s processed video. The Studio never generates
            media on its own and never spends a credit without your explicit action.
          </p>
        </div>
      </Panel>
    </WorkspaceFrame>
  );
}

/** The Studio's own readiness read-out, from its own real fields. */
function readinessOf(post: StudioPost): { label: string; done: boolean }[] {
  return [
    { label: "Visual", done: post.visualReady },
    { label: "Approved", done: post.internalState !== "draft" },
    { label: "Scheduled", done: post.internalState === "scheduled_internal" || post.internalState === "ready_to_publish" },
  ];
}

/** Local, human-readable schedule line for a Studio draft (account timezone). */
function formatStudioSchedule(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString("en-GB", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
