import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { getResendAvailability } from "@/lib/email/config";
import { getOperatingData } from "@/lib/voom/operating-data";
import { readTikTokConfig } from "@/lib/tiktok/config";
import { getTikTokConnection } from "@/lib/tiktok/data";
import { readYouTubeConfig } from "@/lib/youtube/config";
import { getYouTubeConnection } from "@/lib/youtube/data";
import { getCurrentUser } from "@/lib/voom/server-data";
import { createAdminClient } from "@/utils/supabase/admin";

export const dynamic = "force-dynamic";

// Multi-Social Core: Voom plans on four channels — Instagram, TikTok, YouTube
// and email. ALL FOUR have real integrations. The TikTok tile reads the REAL
// tiktok_connections row (migration 0049) — connected means TikTok's own
// account identity and the video.publish scope TikTok actually granted,
// never an assumed capability. The YouTube tile reads the REAL
// youtube_connections row (migration 0047) the same way.
// SMS marketing was removed from the product, so no SMS connection tile
// exists any more (historical SMS data stays read-only).
export default async function ConnectionsPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const selected = new Set(data.business.preferred_channels.map((x) => x.toLowerCase()));
  const email = getResendAvailability();

  const youTubeConfig = readYouTubeConfig();
  const tikTokConfig = readTikTokConfig();
  const user = await getCurrentUser();
  const youTube = user
    ? await getYouTubeConnection(createAdminClient(), user.id, Boolean(youTubeConfig), youTubeConfig?.projectAudited === true).catch(() => null)
    : null;
  const youTubeConnected = Boolean(youTube?.connected) && Boolean(youTube?.scopes.includes("https://www.googleapis.com/auth/youtube.upload"));
  const tikTok = user
    ? await getTikTokConnection(createAdminClient(), user.id, Boolean(tikTokConfig), tikTokConfig?.appAudited === true).catch(() => null)
    : null;
  const tikTokConnected = Boolean(tikTok?.connected) && Boolean(tikTok?.scopes.includes("video.publish"));

  return (
    <div>
      <PageHead title="Connections" description="Manage the channels Voom can read and prepare work for." />
      <div className="grid gap-3 lg:grid-cols-2">
        <Connection
          icon="ig"
          name="Instagram"
          description="Professional account, live content and performance. Publishing is live through your connected account."
          selected={selected.has("instagram")}
          href="/app/instagram"
        />
        <Connection
          icon="film"
          name="TikTok"
          description={tikTokConnected
            ? `Connected${tikTok?.displayName ? `: ${tikTok.displayName}` : ""}. Approved, scheduled videos publish through the durable TikTok queue; Published appears only after TikTok's own post-status confirms.${tikTok && !tikTok.appAudited ? " TikTok currently restricts unaudited-app posts to private (Only me) viewership — Voom reports exactly what TikTok accepts." : ""}`
            : tikTok?.configured
              ? "Real TikTok publishing is available: connect your account to publish videos through Voom's durable queue. Until you connect, TikTok content can be planned, approved and scheduled inside Voom — nothing is published."
              : "Planning connected: TikTok-native videos with caption, concept and script. The server-side TikTok integration is not configured yet, so nothing is published to TikTok."}
          selected={selected.has("tiktok")}
          connected={tikTokConnected}
          statusLabel={tikTok?.configured ? "Not connected" : "Planning only"}
          href={tikTok?.configured ? "/app/tiktok" : undefined}
        />
        <Connection
          icon="play"
          name="YouTube"
          description={youTubeConnected
            ? `Connected${youTube?.channelTitle ? `: ${youTube.channelTitle}` : ""}. Approved, scheduled Shorts and videos publish through the durable YouTube queue; Published appears only after YouTube confirms the video is processed.${youTube && !youTube.projectAudited ? " Google currently locks uploads from unaudited API projects to private — Voom reports the privacy YouTube actually applied." : ""}`
            : youTube?.configured
              ? "Real YouTube publishing is available: connect your channel to publish Shorts and full videos through Voom's durable queue. Until you connect, YouTube content can be planned, approved and scheduled inside Voom — nothing is published."
              : "Planning connected: Shorts and full videos with title, description, concept and outline. The server-side YouTube integration is not configured yet, so nothing is published to YouTube."}
          selected={selected.has("youtube")}
          connected={youTubeConnected}
          statusLabel={youTube?.configured ? "Not connected" : "Planning only"}
          href={youTube?.configured ? "/app/youtube" : undefined}
        />
        <Connection
          icon="mail"
          name="Email"
          description={email.configured
            ? "Resend is configured on the server. Approved campaign emails send only through an explicit send action, and Delivered requires the verified webhook."
            : "Campaign delivery integration is not configured yet."}
          selected={selected.has("email")}
          configured={email.configured}
        />
      </div>
      <p className="mt-4 max-w-2xl text-xs leading-relaxed text-text-3">
        Voom campaigns run on Instagram, TikTok, YouTube and email. All four publish for real through their
        connected accounts — and each reports Published only after the provider itself confirms (Instagram&apos;s
        media id, TikTok&apos;s own PUBLISH_COMPLETE, YouTube&apos;s processed video). SMS marketing is no longer
        part of the product.
      </p>
    </div>
  );
}

function Connection({ icon, name, description, selected, configured = false, connected = true, statusLabel, href }: { icon: string; name: string; description: string; selected: boolean; configured?: boolean; connected?: boolean; statusLabel?: string; href?: string }) {
  const content = (
    <Card className="flex items-center gap-4 p-4 transition hover:border-line-2">
      <span className="grid h-11 w-11 place-items-center rounded-xl bg-surface-2 text-brand"><Icon name={icon} /></span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <b>{name}</b>
          {selected && <Tag tone="t-grey">Selected</Tag>}
          {configured && <Tag tone="t-blue">Configured on server</Tag>}
          {connected ? <Tag tone="t-green">Connected</Tag> : <Tag tone="t-amber">{statusLabel ?? "Not connected"}</Tag>}
        </div>
        <p className="mt-1 text-xs text-text-3">{description}</p>
      </div>
      <span className="text-text-3">{href ? "→" : "Later"}</span>
    </Card>
  );
  return href ? <Link href={href}>{content}</Link> : content;
}
