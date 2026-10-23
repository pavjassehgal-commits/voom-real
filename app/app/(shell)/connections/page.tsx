import Link from "next/link";
import type { ReactNode } from "react";
import { Icon } from "@/components/voom/icons";
import { BTN, ChannelGlyph, PageHeader } from "@/components/voom/redesign/ui";
import { getResendAvailability } from "@/lib/email/config";
import { readInstagramConfig } from "@/lib/instagram/config";
import { getInstagramConnection } from "@/lib/instagram/data";
import { cx } from "@/lib/voom/cx";
import { getOperatingData } from "@/lib/voom/operating-data";
import { readTikTokConfig } from "@/lib/tiktok/config";
import { getTikTokConnection } from "@/lib/tiktok/data";
import { readYouTubeConfig } from "@/lib/youtube/config";
import { getYouTubeConnection } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

const YOUTUBE_UPLOAD_SCOPE = "https://www.googleapis.com/auth/youtube.upload";
const DAY = 24 * 60 * 60 * 1000;

type Tone = "green" | "amber" | "grey" | "blue";

/**
 * Channels — redesign Batch 4C (Figma "Connect your channels", drawn on the
 * PDF page labelled "40 — Channels · Reconnect TikTok").
 *
 * Voom plans on four channels — Instagram, TikTok, YouTube and email — and
 * every card reads that channel's REAL connection row (TikTok requires the
 * granted video.publish scope, YouTube the youtube.upload scope). Connect,
 * reconnect and disconnect stay on each provider's own page, where the real
 * authorization flows live; this page links there. The reference's Facebook,
 * X and LinkedIn cards, its "Coming soon" row (Pinterest, WhatsApp, Threads,
 * Google Business) and per-account follower figures are not shown: Voom does
 * not support those channels and stores no follower counts. SMS marketing was
 * removed from the product, so there is no SMS card.
 */
export default async function ConnectionsPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const selected = new Set(data.business.preferred_channels.map((x) => x.toLowerCase()));
  const email = getResendAvailability();
  const user = await getCurrentUser();
  const admin = createAdminClient();

  const instagramConfig = readInstagramConfig();
  const youTubeConfig = readYouTubeConfig();
  const tikTokConfig = readTikTokConfig();
  const [instagram, youTube, tikTok] = user ? await Promise.all([
    getInstagramConnection(admin, user.id, Boolean(instagramConfig)).catch(() => null),
    getYouTubeConnection(admin, user.id, Boolean(youTubeConfig), youTubeConfig?.projectAudited === true).catch(() => null),
    getTikTokConnection(admin, user.id, Boolean(tikTokConfig), tikTokConfig?.appAudited === true).catch(() => null),
  ]) : [null, null, null];
  const youTubeConnected = Boolean(youTube?.connected) && Boolean(youTube?.scopes.includes(YOUTUBE_UPLOAD_SCOPE));
  const tikTokConnected = Boolean(tikTok?.connected) && Boolean(tikTok?.scopes.includes("video.publish"));
  const instagramConnected = Boolean(instagram?.connected);
  const eligible = data.coordinator?.state.emailState.eligibleContactsCount ?? null;

  const igExpiresInDays = daysUntil(instagram?.tokenExpiresAt);
  const needsAttention = (status: string | undefined) => status === "expired" || status === "revoked" || status === "error";
  const attention = [needsAttention(instagram?.status), needsAttention(tikTok?.status), needsAttention(youTube?.status)].filter(Boolean).length
    + (instagramConnected && igExpiresInDays !== null && igExpiresInDays <= 7 ? 1 : 0);
  const connectedCount = [instagramConnected, tikTokConnected, youTubeConnected].filter(Boolean).length;

  return (
    <div className="min-w-0">
      <PageHeader
        title="Connect your channels"
        subtitle="Link your social accounts and email so Voom can publish, schedule and track performance for you."
        actions={
          <div className="voom-card flex max-w-[380px] items-start gap-3 px-4 py-3.5">
            <span className="voom-create-btn grid h-9 w-9 shrink-0 place-items-center rounded-full text-white"><Icon name="lock" size={16} /></span>
            <span className="min-w-0">
              <b className="block text-[14px] font-semibold text-text">Connect once, publish everywhere</b>
              <span className="block text-[12.5px] leading-snug text-text-2">Voom asks only for what it needs to publish and read performance. Disconnect any channel from its own page at any time.</span>
            </span>
          </div>
        }
      />

      <div className="mb-4">
        <h2 className="text-[17px] font-semibold text-text">Your accounts</h2>
        <p className="text-[13px] text-text-2">
          {connectedCount} of 3 social accounts connected{attention ? ` · ${attention} need${attention === 1 ? "s" : ""} attention` : ""} · email is set up in Settings
        </p>
      </div>

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 md:grid-cols-2 xl:grid-cols-4">
        <ChannelCard
          channel="instagram"
          name="Instagram"
          selected={selected.has("instagram")}
          {...(instagramConnected
            ? { tone: igExpiresInDays !== null && igExpiresInDays <= 7 ? "amber" : "green", status: igExpiresInDays !== null && igExpiresInDays <= 7 ? "Needs attention" : "Connected" }
            : needsAttention(instagram?.status) ? { tone: "amber", status: "Needs attention" }
            : instagram?.configured === false ? { tone: "grey", status: "Planning only" } : { tone: "grey", status: "Not connected" }) as { tone: Tone; status: string }}
          identity={instagram?.username ? `@${instagram.username}` : null}
          subline={instagram?.accountType ? `${capitalise(instagram.accountType.toLowerCase())} account` : null}
          facts={instagramConnected ? [
            ["Connected", formatDay(instagram?.connectedAt)],
            ["Last synced", formatDay(instagram?.lastSyncedAt)],
            ["Access", igExpiresInDays === null ? "—" : igExpiresInDays > 0 ? `${igExpiresInDays} days left` : "Expired"],
          ] : null}
          description={instagramConnected
            ? "Posts, Reels and Stories publish through your connected professional account. Published appears only after Meta returns the media id."
            : instagram?.configured === false
              ? "The server-side Instagram integration is not configured yet, so nothing is published to Instagram."
              : "Connect your professional account to publish posts, Reels and Stories and read their performance."}
          warning={instagramConnected && igExpiresInDays !== null && igExpiresInDays <= 7
            ? `Access expires in ${Math.max(0, igExpiresInDays)} day${igExpiresInDays === 1 ? "" : "s"}. Reconnect to keep scheduled posts publishing.`
            : needsAttention(instagram?.status) ? "Instagram access stopped working. Reconnect to keep scheduled posts publishing." : null}
          action={instagramConnected && !(igExpiresInDays !== null && igExpiresInDays <= 7)
            ? { href: "/app/instagram", label: "Manage", primary: false }
            : { href: "/app/instagram", label: instagramConnected || needsAttention(instagram?.status) ? "Reconnect Instagram" : "Connect Instagram", primary: true }}
        />
        <ChannelCard
          channel="tiktok"
          name="TikTok"
          selected={selected.has("tiktok")}
          {...(tikTokConnected ? { tone: "green", status: "Connected" }
            : needsAttention(tikTok?.status) ? { tone: "amber", status: "Needs attention" }
            : tikTok?.configured ? { tone: "grey", status: "Not connected" } : { tone: "grey", status: "Planning only" }) as { tone: Tone; status: string }}
          identity={tikTok?.creatorUsername ? `@${tikTok.creatorUsername}` : tikTok?.displayName ?? null}
          subline={tikTokConnected ? "Publishing scope granted (video.publish)" : null}
          facts={null}
          description={tikTokConnected
            ? `Approved, scheduled videos publish through the durable TikTok queue; Published appears only after TikTok's own post-status confirms.${tikTok && !tikTok.appAudited ? " TikTok currently restricts unaudited-app posts to private (Only me) viewership — Voom reports exactly what TikTok accepts." : ""}`
            : tikTok?.configured
              ? "Real TikTok publishing is available: connect your account to publish videos through Voom's durable queue. Until you connect, TikTok content can be planned, approved and scheduled inside Voom — nothing is published."
              : "Planning connected: TikTok-native videos with caption, concept and script. The server-side TikTok integration is not configured yet, so nothing is published to TikTok."}
          warning={needsAttention(tikTok?.status) ? "TikTok access stopped working. Reconnect to keep scheduled videos publishing." : null}
          action={!tikTok?.configured ? null
            : tikTokConnected ? { href: "/app/tiktok", label: "Manage", primary: false }
            : { href: "/app/tiktok", label: needsAttention(tikTok?.status) ? "Reconnect TikTok" : "Connect TikTok", primary: true }}
        />
        <ChannelCard
          channel="youtube"
          name="YouTube"
          selected={selected.has("youtube")}
          {...(youTubeConnected ? { tone: "green", status: "Connected" }
            : needsAttention(youTube?.status) ? { tone: "amber", status: "Needs attention" }
            : youTube?.configured ? { tone: "grey", status: "Not connected" } : { tone: "grey", status: "Planning only" }) as { tone: Tone; status: string }}
          identity={youTube?.channelTitle ?? null}
          subline={youTube?.channelHandle ?? null}
          facts={youTubeConnected ? [
            ["Connected", formatDay(youTube?.connectedAt)],
            ["Last synced", formatDay(youTube?.lastSyncedAt)],
            ["Default", youTube?.defaultPrivacy ? capitalise(youTube.defaultPrivacy) : "Per video"],
          ] : null}
          description={youTubeConnected
            ? `Approved, scheduled Shorts and videos publish through the durable YouTube queue; Published appears only after YouTube confirms the video is processed.${youTube && !youTube.projectAudited ? " Google currently locks uploads from unaudited API projects to private — Voom reports the privacy YouTube actually applied." : ""}`
            : youTube?.configured
              ? "Real YouTube publishing is available: connect your channel to publish Shorts and full videos through Voom's durable queue. Until you connect, YouTube content can be planned, approved and scheduled inside Voom — nothing is published."
              : "Planning connected: Shorts and full videos with title, description, concept and outline. The server-side YouTube integration is not configured yet, so nothing is published to YouTube."}
          warning={needsAttention(youTube?.status) ? "YouTube access stopped working. Reconnect to keep scheduled videos publishing." : null}
          action={!youTube?.configured ? null
            : youTubeConnected ? { href: "/app/youtube", label: "Manage", primary: false }
            : { href: "/app/youtube", label: needsAttention(youTube?.status) ? "Reconnect YouTube" : "Connect YouTube", primary: true }}
        />
        <ChannelCard
          channel="email"
          name="Email"
          selected={selected.has("email")}
          tone={email.configured ? "blue" : "grey"}
          status={email.configured ? "Configured on server" : "Not configured"}
          identity={eligible !== null ? `${eligible.toLocaleString("en-US")} contact${eligible === 1 ? "" : "s"} can receive campaigns` : null}
          subline="Subscribed to marketing email"
          facts={null}
          checks={["Send email campaigns", "Run automated flows", "Track delivery through the verified webhook"]}
          description={email.configured
            ? "There is no account to connect: set your sender name, sending address and domain in Settings. Approved campaign emails send only through an explicit send action, and Delivered requires the verified webhook."
            : "Campaign delivery integration is not configured yet."}
          warning={null}
          action={{ href: "/app/settings#email", label: "Manage", primary: false }}
        />
      </div>

      <p className="mt-5 max-w-3xl text-[12.5px] leading-relaxed text-text-3">
        Voom campaigns run on Instagram, TikTok, YouTube and email. Each reports Published only after the provider itself
        confirms (Instagram&apos;s media id, TikTok&apos;s own PUBLISH_COMPLETE, YouTube&apos;s processed video). SMS marketing is
        no longer part of the product.
      </p>
    </div>
  );
}

const TONES: Record<Tone, string> = {
  green: "bg-[var(--green-soft)] text-[var(--green)]",
  amber: "bg-[var(--amber-soft)] text-[var(--amber)]",
  grey: "bg-surface-3 text-text-2",
  blue: "bg-[var(--blue-soft)] text-[var(--blue)]",
};

function ChannelCard({ channel, name, selected, tone, status, identity, subline, facts, checks, description, warning, action }: {
  channel: string;
  name: string;
  selected: boolean;
  tone: Tone;
  status: string;
  identity: string | null;
  subline: string | null;
  facts: [string, string][] | null;
  checks?: string[];
  description: string;
  warning: string | null;
  action: { href: string; label: string; primary: boolean } | null;
}): ReactNode {
  return (
    <section className="voom-card flex min-w-0 flex-col p-5" aria-label={`${name} — ${status}`}>
      <div className="flex items-start gap-3">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-[13px] bg-surface-2"><ChannelGlyph channel={channel} size={28} /></span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <b className="text-[16px] font-semibold text-text">{name}</b>
            {selected && <span className="rounded-full bg-[var(--brand-soft)] px-2 py-0.5 text-[11px] font-semibold text-[var(--brand-ink)]">In your plan</span>}
          </div>
          <span className={cx("mt-1 inline-flex rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold", TONES[tone])}>{status}</span>
        </div>
      </div>
      {(identity || subline) && <div className="mt-3">
        {identity && <div className="truncate text-[13.5px] font-medium text-text">{identity}</div>}
        {subline && <div className="truncate text-[12.5px] text-text-2">{subline}</div>}
      </div>}
      {facts && <dl className="mt-3 divide-y divide-line rounded-[12px] bg-surface-2 px-3">
        {facts.map(([label, value]) => <div key={label} className="flex items-center justify-between gap-3 py-2 text-[12.5px]">
          <dt className="text-text-2">{label}</dt>
          <dd className="truncate font-semibold text-text">{value}</dd>
        </div>)}
      </dl>}
      {checks && <ul className="mt-3 space-y-1.5">
        {checks.map((check) => <li key={check} className="flex items-center gap-2 text-[12.5px] text-text-2"><Icon name="check" size={13} className="text-[var(--green)]" />{check}</li>)}
      </ul>}
      <p className="mt-3 text-[12.5px] leading-relaxed text-text-2">{description}</p>
      {warning && <p role="status" className="mt-3 flex gap-2 rounded-[12px] border border-[var(--coral)]/25 bg-[var(--coral-soft)] px-3 py-2.5 text-[12.5px] leading-snug text-[var(--coral)]"><Icon name="warn" size={14} className="mt-0.5 shrink-0" />{warning}</p>}
      <div className="mt-auto pt-4">
        {action
          ? <Link href={action.href} className={cx(action.primary ? BTN.primary : BTN.quiet, "w-full")}>{action.primary ? <>{action.label} <Icon name="arrow" size={14} /></> : <><Icon name="settings" size={15} /> {action.label}</>}</Link>
          : <span className="block rounded-[14px] border border-dashed border-line-2 px-3 py-2.5 text-center text-[12.5px] text-text-3">Available once configured on the server</span>}
      </div>
    </section>
  );
}

/** Whole days until an ISO time (negative once past); null when unknown. */
function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  return Number.isFinite(at) ? Math.ceil((at - Date.now()) / DAY) : null;
}

function formatDay(iso: string | null | undefined) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short" }).format(date);
}

function capitalise(value: string) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}
