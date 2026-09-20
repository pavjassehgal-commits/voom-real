"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { CreateContentModal } from "@/components/voom/modals/CreateContentModal";
import { PostEditorModal } from "@/components/voom/modals/PostEditorModal";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { isSocialVideoDraftKind, type SocialVideoDraftKind } from "@/lib/post/core";

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

const STATE_TONE: Record<StudioPost["internalState"], string> = {
  draft: "t-amber",
  approved: "t-blue",
  scheduled_internal: "t-green",
  ready_to_publish: "t-green",
};

export default function StudioPage() {
  const { open } = useModal();
  const { goTo } = useVoomActions();
  const [posts, setPosts] = useState<StudioPost[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

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

  const counts = posts.reduce(
    (acc, post) => ({ ...acc, [post.internalState]: (acc[post.internalState] ?? 0) + 1 }),
    {} as Record<string, number>,
  );

  return (
    <div>
      <PageHead
        title="Create content"
        description="One Studio for every platform — Instagram Posts, Reels and Stories, TikTok videos, YouTube Shorts and videos — built and approved inside Voom. Approved items appear on your Content Calendar."
        actions={
          <>
            <Btn variant="outline" size="sm" onClick={() => goTo("calendar")}>
              <Icon name="cal" size={14} /> Content Calendar
            </Btn>
            <Btn variant="primary" size="sm" onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}>
              <Icon name="plus" size={14} /> Create content
            </Btn>
          </>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <EntryCard
          icon="ig"
          title="Instagram"
          body="Posts (1:1 or 4:5), Reels and Stories. Create with MARA, or use your own media. Real publishing through your connected account."
          cta="Start an Instagram draft"
          onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}
        />
        <EntryCard
          icon="film"
          title="TikTok"
          body="Plan TikTok-native videos: hook, beats and caption. Publishing starts when the TikTok connection ships."
          cta="Start a TikTok draft"
          onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}
        />
        <EntryCard
          icon="play"
          title="YouTube"
          body="Plan Shorts and full videos with title, description and outline. Publishing starts when the YouTube connection ships."
          cta="Start a YouTube draft"
          onClick={() => open(<CreateContentModal onChanged={() => void load()} />)}
        />
        <EntryCard
          icon="spark"
          title="Existing MARA Reel workflow"
          body="Concept, script, asset pack and the playable preview live under Approvals."
          cta="Open Approvals"
          onClick={() => goTo("approvals")}
        />
      </div>

      {error ? <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div> : null}

      <Card className="p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <h2 className="font-display text-lg font-semibold">Your content</h2>
          <div className="flex flex-wrap gap-1.5">
            <Tag tone="t-amber">{counts.draft ?? 0} drafts</Tag>
            <Tag tone="t-blue">{counts.approved ?? 0} approved</Tag>
            <Tag tone="t-green">{counts.scheduled_internal ?? 0} scheduled internally</Tag>
            <Tag tone="t-green">{counts.ready_to_publish ?? 0} ready to publish</Tag>
          </div>
        </div>

        {loading ? <p className="py-8 text-center text-sm text-text-3">Loading your content…</p> : null}
        {!loading && !posts.length ? (
          <p className="py-8 text-center text-sm text-text-3">
            Nothing here yet. Choose <b>Create content</b> and pick a platform — Instagram, TikTok or YouTube.
          </p>
        ) : null}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {posts.map((post) => (
            <button
              key={post.id}
              type="button"
              onClick={() => open(isSocialVideoDraftKind(post.kind)
                ? <SocialEditorModal draftId={post.id} onChanged={() => void load()} />
                : <PostEditorModal postId={post.id} onChanged={() => void load()} />)}
              className="overflow-hidden rounded-2xl border border-line bg-surface text-left transition hover:border-brand"
            >
              <div className="grid h-[132px] place-items-center bg-surface-2">
                {post.visual?.previewUrl && !post.visual.mimeType.startsWith("video/") ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={post.visual.previewUrl} alt={post.visual.displayName} className="h-full w-full object-cover" />
                ) : (
                  <span className="text-xs text-text-3">{post.visualReady ? "Video preview" : "No visual yet"}</span>
                )}
              </div>
              <div className="p-3.5">
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  <Tag tone="t-brand">{post.typeLabel}</Tag>
                  <Tag tone={STATE_TONE[post.internalState]}>{post.internalStateLabel}</Tag>
                  <Tag tone="t-grey">{post.format}</Tag>
                </div>
                <b className="block truncate text-[14px]">{post.concept || "Untitled"}</b>
                <span className="mt-1 block text-[11.5px] text-text-3">
                  {post.originLabel}
                  {post.scheduledAt ? ` · ${new Date(post.scheduledAt).toLocaleString("en-AE", { timeZone: "Asia/Dubai", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : ""}
                </span>
              </div>
            </button>
          ))}
        </div>

        <p className="mt-4 rounded-xl bg-surface-2 px-3.5 py-2.5 text-[11.5px] leading-relaxed text-text-3">
          Approved Instagram items with a schedule and a visual are published to your connected Instagram account
          automatically at their scheduled time — Voom marks something “Published” only after Instagram confirms it.
          TikTok and YouTube items are planned and approved inside Voom; their publishing connections do not exist
          yet, so nothing external happens until a real connection ships.
        </p>
      </Card>
    </div>
  );
}

function EntryCard({ icon, title, body, cta, onClick }: {
  icon: string; title: string; body: string; cta: string; onClick: () => void;
}) {
  return (
    <Card className="flex flex-col p-4">
      <span className="voom-grad mb-2.5 grid h-9 w-9 place-items-center rounded-xl text-white">
        <Icon name={icon} size={16} />
      </span>
      <b className="font-display text-[15px]">{title}</b>
      <p className="mt-1 mb-3 flex-1 text-[12.5px] leading-relaxed text-text-2">{body}</p>
      <Btn variant="outline" size="sm" onClick={onClick}>{cta}</Btn>
    </Card>
  );
}
