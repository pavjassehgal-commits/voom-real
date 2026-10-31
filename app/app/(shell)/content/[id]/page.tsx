import Link from "next/link";
import { notFound } from "next/navigation";
import { ContentDetailActions } from "@/components/voom/content/ContentDetailActions";
import { Icon } from "@/components/voom/icons";
import { ChannelGlyph, StatusChip } from "@/components/voom/redesign/ui";
import { getQueueItemForDraft } from "@/lib/instagram/publish-queue";
import { loadPerformanceReport } from "@/lib/performance/data";
import { getPostDraft } from "@/lib/post/server-data";
import { readSocialChannelReadiness } from "@/lib/social/readiness";
import { getSocialDraft } from "@/lib/social/server-drafts";
import { fromPost, fromSocial } from "@/lib/voom/content-library";
import { resolveContentDetail } from "@/lib/voom/content-library-core";
import { getCurrentUser } from "@/lib/voom/server-data";
import { compactNumber } from "@/lib/voom/today-metrics";
import { createAdminClient } from "@/utils/supabase/admin";
import { createClient } from "@/utils/supabase/server";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const CAPTION_LIMITS: Record<string, number> = { instagram: 2200, tiktok: 2200, youtube: 5000 };
const BUCKET_LABELS: Record<string, string> = { drafts: "Drafts", scheduled: "Scheduled", published: "Published", attention: "Needs attention", rejected: "All content" };

/**
 * Content · Post detail (Figma "32 — Content · Post detail", Keep).
 * Read-only over the post's own record, its durable queue row and stored
 * measurements; Edit / Reschedule open the existing editor, which owns every
 * approval and scheduling rule.
 */
export default async function ContentDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const user = await getCurrentUser();
  if (!user) return null;
  const admin = createAdminClient();
  const db = await createClient();

  const found = await resolveContentDetail(id, {
    social: (draftId) => getSocialDraft(admin, user.id, draftId),
    post: (draftId) => getPostDraft(admin, user.id, draftId),
  }).catch(() => null);
  if (!found) notFound();
  const { post, social } = found;

  const [queue, performance, readiness] = await Promise.all([
    post ? getQueueItemForDraft(admin, user.id, id).catch(() => null) : Promise.resolve(null),
    post ? loadPerformanceReport(db, user.id).catch(() => null) : Promise.resolve(null),
    readSocialChannelReadiness(admin, user.id).catch(() => []),
  ]);
  const metrics = performance?.items.find((item) => item.draftId === id)?.metrics ?? null;
  const item = post ? fromPost(post, queue, metrics) : fromSocial(social!);
  const caption = post ? post.composedCaption : social!.caption;
  const description = social?.description ?? null;
  const connection = readiness.find((entry) => entry.channel === item.channel);
  const notConnected = connection && !connection.connected;
  const goesLive = item.scheduledAt ? formatWhen(item.scheduledAt) : null;

  const history: { title: string; detail: string; tone: string }[] = [];
  if (queue?.status === "published" && queue.published_at) history.push({ title: "Published", detail: `Confirmed by Instagram · ${formatWhen(queue.published_at)}`, tone: "bg-[var(--green-dot)]" });
  if (queue?.status === "failed") history.push({ title: "Publishing failed", detail: queue.failure_message ?? "The provider attempt failed.", tone: "bg-[var(--red)]" });
  if (queue && queue.attempts > 0 && queue.last_attempt_at) history.push({ title: `Publish attempt${queue.attempts === 1 ? "" : "s"}: ${queue.attempts}`, detail: `Last attempt · ${formatWhen(queue.last_attempt_at)}`, tone: "bg-text-3" });
  if (item.scheduledAt) history.push({ title: `Scheduled for ${formatWhen(item.scheduledAt)}`, detail: item.stateLabel, tone: "bg-[var(--blue)]" });
  history.push({ title: "Last edited", detail: formatWhen(item.updatedAt), tone: "bg-[var(--brand)]" });
  history.push({ title: item.origin === "mara" ? "Draft created with MARA" : "Draft created", detail: formatWhen(item.createdAt), tone: "bg-[var(--brand)]" });

  return (
    <div className="min-w-0">
      <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-2 text-[13.5px] text-text-2">
        <Link href="/app/content" className="hover:text-text">Content</Link>
        <span aria-hidden="true">/</span>
        <Link href={item.bucket === "rejected" ? "/app/content" : `/app/content?tab=${item.bucket}`} className="hover:text-text">{BUCKET_LABELS[item.bucket]}</Link>
        <span aria-hidden="true">/</span>
        <span className="truncate font-semibold text-text">{item.title}</span>
      </nav>

      <header className="mb-5 flex min-w-0 flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <h1 className="text-[clamp(1.75rem,3.2vw,2.25rem)] font-bold leading-[1.1] tracking-[-0.04em] text-text">{item.title}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[14px] text-text-2">
            <StatusChip status={item.state} label={item.stateLabel} small />
            <span>{goesLive ?? "No time set"}</span>
            <span>· {item.typeLabel}</span>
          </div>
        </div>
        <ContentDetailActions id={item.id} editor={item.editor} canReschedule={item.bucket !== "published"} />
      </header>

      {notConnected && (
        <div role="status" className="mb-5 flex min-w-0 flex-col gap-3 rounded-[18px] border border-[rgba(198,88,40,0.25)] bg-[var(--coral-soft)] px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
          <p className="flex min-w-0 items-start gap-3 text-[14.5px] text-text">
            <Icon name="warn" size={18} className="mt-0.5 shrink-0 text-[var(--coral)]" />
            <span><b className="font-semibold text-[var(--coral)]">{CHANNEL_NAME[item.channel]} isn’t connected.</b> Voom can’t publish this post until the account is connected.</span>
          </p>
          <Link href={`/app/${item.channel}`} className="inline-flex h-10 shrink-0 items-center justify-center rounded-[12px] border border-line bg-surface px-4 text-[14px] font-semibold text-text hover:bg-surface-2">Connect {CHANNEL_NAME[item.channel]}</Link>
        </div>
      )}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 lg:grid-cols-[minmax(0,0.75fr)_minmax(0,1.6fr)]">
        <section className="voom-card self-start p-4" aria-label="Media">
          <div className="relative grid aspect-[9/14] place-items-center overflow-hidden rounded-[16px] bg-[linear-gradient(150deg,var(--brand-soft),var(--surface-3))]">
            {item.previewUrl
              // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
              ? <img src={item.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
              : <span className="flex flex-col items-center gap-2 px-6 text-center text-text-3"><Icon name={item.kind === "instagram_post" ? "img" : "video"} size={28} /><span className="text-[13px]">{item.mediaReady ? "Video attached — preview plays in the editor" : "No media attached yet"}</span></span>}
          </div>
          <div className="mt-3 flex items-center justify-between gap-3 text-[13px]">
            <span className="truncate text-text-2">{item.mediaName ?? "No file"}</span>
            {item.bucket !== "published" && <ContentDetailActions id={item.id} editor={item.editor} variant="replace" />}
          </div>
        </section>

        <div className="flex min-w-0 flex-col gap-5">
          <section className="voom-card overflow-x-auto p-5 sm:p-6" aria-labelledby="detail-channels">
            <h2 id="detail-channels" className="text-[16px] font-semibold text-text">Channel</h2>
            <table className="mt-3 w-full min-w-[460px] text-left text-[14px]">
              <thead className="text-[11.5px] uppercase tracking-[0.12em] text-text-3">
                <tr className="border-b border-line"><th className="py-2.5 font-semibold">Channel</th><th className="py-2.5 font-semibold">Format</th><th className="py-2.5 font-semibold">Goes live</th><th className="py-2.5 font-semibold">Status</th></tr>
              </thead>
              <tbody>
                <tr>
                  <td className="py-3"><span className="flex items-center gap-2.5 font-semibold text-text"><ChannelGlyph channel={item.channel} size={22} />{CHANNEL_NAME[item.channel]}</span></td>
                  <td className="py-3 text-text-2">{item.typeLabel}</td>
                  <td className="py-3 text-text-2">{item.scheduledAt ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(item.scheduledAt)) : "—"}</td>
                  <td className="py-3"><StatusChip status={notConnected && item.bucket !== "published" ? "connection_required" : item.state} label={notConnected && item.bucket !== "published" ? "Connect to publish" : item.stateLabel} small /></td>
                </tr>
              </tbody>
            </table>
            {metrics && (
              <div className="mt-3 flex flex-wrap gap-4 border-t border-line pt-3 text-[13px] text-text-2">
                {(["views", "reach", "likes", "comments", "saves", "shares"] as const).filter((key) => typeof metrics[key] === "number").map((key) => (
                  <span key={key}><b className="font-semibold text-text">{compactNumber(metrics[key] as number)}</b> {key}</span>
                ))}
              </div>
            )}
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="detail-caption">
            <div className="flex items-center justify-between gap-3">
              <h2 id="detail-caption" className="text-[16px] font-semibold text-text">{item.channel === "youtube" ? "Title and description" : "Caption"}</h2>
              {item.kind !== "story" && <span className="text-[13px] text-text-2">{(description ?? caption).length} / {CAPTION_LIMITS[item.channel].toLocaleString("en-US")}</span>}
            </div>
            {item.kind === "story" ? (
              <p className="mt-3 text-[14.5px] text-text-2">Instagram Stories carry no caption.</p>
            ) : (
              <p className="mt-3 whitespace-pre-line text-[14.5px] leading-relaxed text-text">{(description ?? caption) || <span className="text-text-3">No caption yet.</span>}</p>
            )}
            {item.hashtags.length > 0 && (
              <div className="mt-3 flex flex-wrap gap-2">
                {item.hashtags.map((tag) => <span key={tag} className="rounded-full bg-[var(--brand-soft)] px-3 py-1 text-[12.5px] font-semibold text-[var(--brand-ink)]">#{tag.replace(/^#/, "")}</span>)}
              </div>
            )}
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="detail-history">
            <h2 id="detail-history" className="text-[16px] font-semibold text-text">History</h2>
            <ol className="mt-4 space-y-4">
              {history.map((entry) => (
                <li key={`${entry.title}-${entry.detail}`} className="flex gap-3">
                  <span className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${entry.tone}`} aria-hidden="true" />
                  <span className="min-w-0"><span className="block text-[14px] font-semibold text-text">{entry.title}</span><span className="block text-[13px] text-text-2">{entry.detail}</span></span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </div>
  );
}

const CHANNEL_NAME = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as const;

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true }).format(date);
}
