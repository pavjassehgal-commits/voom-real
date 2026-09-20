import Link from "next/link";
import { PageHead } from "@/components/voom/shell/AppShell";
import { Icon } from "@/components/voom/icons";
import { Card, Tag } from "@/components/voom/ui/primitives";
import { getResendAvailability } from "@/lib/email/config";
import { getOperatingData } from "@/lib/voom/operating-data";

export const dynamic = "force-dynamic";

// Multi-Social Core: Voom plans on four channels — Instagram, TikTok, YouTube
// and email. Instagram and email have real integrations; TikTok and YouTube
// are planning-only until their publishing connections ship, and the tiles
// say so truthfully. SMS marketing was removed from the product, so no SMS
// connection tile exists any more (historical SMS data stays read-only).
export default async function ConnectionsPage() {
  const data = await getOperatingData();
  if (!data) return null;

  const selected = new Set(data.business.preferred_channels.map((x) => x.toLowerCase()));
  const email = getResendAvailability();

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
          description="Planning connected: create, approve and schedule TikTok-native videos inside Voom. Publishing is not connected yet — Voom will tell you plainly when it can publish, and never claims a post went live without provider confirmation."
          selected={selected.has("tiktok")}
          connected={false}
          statusLabel="Planning only"
        />
        <Connection
          icon="play"
          name="YouTube"
          description="Planning connected: Shorts and full videos with title, description, concept and outline. Publishing is not connected yet — nothing external happens until a real YouTube connection ships."
          selected={selected.has("youtube")}
          connected={false}
          statusLabel="Planning only"
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
        Voom campaigns run on Instagram, TikTok, YouTube and email. TikTok and YouTube content can be planned,
        approved and scheduled now; their publishing connections do not exist yet, so Voom never marks them
        published. SMS marketing is no longer part of the product.
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
