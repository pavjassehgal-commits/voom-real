"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useVoomActions, useVoomState } from "@/lib/voom/store";
import type { InstagramConnectionView } from "@/lib/instagram/types";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { InstagramConnectModal } from "@/components/voom/modals/InstagramConnectModal";
import { DisconnectInstagramModal } from "@/components/voom/modals/DisconnectInstagramModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";

type InstagramInsights = {
  metrics: Record<string, number>;
  media: Array<{ id: string; caption: string; mediaType: string; mediaUrl: string | null; thumbnailUrl: string | null; permalink: string | null; timestamp: string | null; likes: number; comments: number }>;
  syncedAt: string;
  metricsAvailable: boolean;
  mediaAvailable: boolean;
};

const GETS = [
  "Read your professional account identity",
  "Create feed and Reel publishing containers after explicit approval",
  "Keep access tokens encrypted and server-only",
  "Disconnect the account from Voom at any time",
];
const NEVERS = [
  "Change your password or account settings",
  "Spend money without your written approval",
  "Follow, unfollow or DM anyone unprompted",
  "Share your data with other brands",
];

export default function InstagramPage() {
  return <Suspense fallback={null}><InstagramPageContent /></Suspense>;
}

function InstagramPageContent() {
  const { igConnected, brand } = useVoomState();
  const { goTo } = useVoomActions();
  const { open } = useModal();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<InstagramConnectionView | null>(null);
  const [insights, setInsights] = useState<InstagramInsights | null>(null);
  const [insightsError, setInsightsError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const connectionError = searchParams.has("instagram_error");

  const syncInsights = useCallback(async () => {
    setSyncing(true);
    setInsightsError(false);
    try {
      const response = await fetch("/api/integrations/instagram/insights", { cache: "no-store" });
      if (!response.ok) throw new Error("sync_failed");
      setInsights(await response.json() as InstagramInsights);
    } catch { setInsightsError(true); }
    finally { setSyncing(false); }
  }, []);

  useEffect(() => {
    let active = true;
    fetch("/api/integrations/instagram/status", { cache: "no-store" })
      .then(async (response) => response.ok ? (await response.json() as { connection: InstagramConnectionView }).connection : null)
      .then((value) => { if (active) { setConnection(value); if (value?.connected) void syncInsights(); } })
      .catch(() => { if (active) setConnection(null); });
    return () => { active = false; };
  }, [igConnected, syncInsights]);

  if (connection?.connected) {
    return (
      <div className="mx-auto max-w-[900px]">
        <PageHead
          title="Instagram"
          description="Your professional Instagram account is securely connected to Voom."
          actions={
            <Btn variant="outline" size="sm" disabled={syncing} onClick={() => void syncInsights()}>{syncing ? "Syncing…" : "Refresh insights"}</Btn>
          }
        />
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <div className="flex items-center gap-2.5">
              <span
                className="flex h-[60px] w-[60px] items-center justify-center rounded-full p-[2.5px]"
                style={{ background: "linear-gradient(45deg,#f9ce34,#ee2a7b,#6228d7)" }}
              >
                <span className="voom-grad grid h-full w-full place-items-center rounded-full border-2 border-surface text-[19px] text-white">
                  {(connection.name || connection.username || brand.name)[0]}
                </span>
              </span>
              <div>
                <div className="flex items-center gap-1.5">
                  <b className="text-[17px]">{connection.name || connection.username}</b>
                  <Tag tone="t-green">
                    <Icon name="check" size={12} /> Connected
                  </Tag>
                </div>
                <div className="text-[13px] text-text-3">@{connection.username} · {formatAccountType(connection.accountType)}</div>
                <div className="mt-0.5 text-xs text-text-3">Connected {connection.connectedAt ? new Date(connection.connectedAt).toLocaleString() : "recently"}</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant="danger" size="sm" onClick={() => open(<DisconnectInstagramModal />)}>
                Disconnect
              </Btn>
            </div>
          </div>
          <div className="my-3.5 h-px bg-line" />
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            {[["Views", insights?.metrics.views], ["Reach", insights?.metrics.reach], ["Engaged", insights?.metrics.accounts_engaged], ["Followers", insights?.metrics.follower_count]].map(([label, value]) => (
              <div key={String(label)} className="rounded-xl bg-surface-2 p-3"><div className="text-xs text-text-3">{label}</div><b className="font-mono text-lg">{typeof value === "number" ? value.toLocaleString() : "—"}</b></div>
            ))}
          </div>
          {insightsError ? <div role="alert" className="mt-3 rounded-xl border border-red/30 bg-red/10 p-3 text-sm text-red">Instagram insights could not be refreshed. Your connection is still safe; please retry.</div> : null}
        </Card>
        <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold">Top posts, last 30 days</h2>
              {insights?.mediaAvailable ? <Tag tone="t-green">Live</Tag> : null}
            </div>
            {insights?.media.length ? insights.media.slice(0, 3).map((item) => [item.caption || "Instagram post", item.mediaType, String(item.likes + item.comments), "#e8481f"] as [string,string,string,string]).map(([t, ty, v, c]) => (
              <div key={t} className="flex items-center gap-2.5 border-b border-line py-2.5 last:border-0">
                <div className="h-12 w-[38px] flex-none rounded-[8px]" style={{ background: c }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.3px] font-semibold">{t}</div>
                  <span className="text-xs text-text-3">{ty}</span>
                </div>
                <b className="font-mono text-[13px]">{v}</b>
                <span className="text-[11.5px] text-text-3">interactions</span>
              </div>
            )) : <div className="rounded-xl bg-surface-2 p-4 text-sm text-text-2">{insights?.mediaAvailable ? "No Instagram posts were returned for this account yet." : "Recent Instagram posts are temporarily unavailable."}</div>}
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg font-semibold">What Voom can do now</h2>
            {(
              [
                ["Prepare Reel drafts for your review", "reels"],
                ["Keep publishing blocked until explicitly enabled", "instagram"],
                ["Create approved Instagram drafts", "reels"],
                ["Review scheduled content", "calendar"],
              ] as [string, string][]
            ).map(([t, g]) => (
              <button key={t} onClick={() => goTo(g)} className="flex w-full items-center justify-between border-b border-line py-2.5 text-left last:border-0">
                <span className="flex items-center gap-2 text-[13.3px]">
                  <span className="grid h-[18px] w-[18px] place-items-center rounded-full bg-green">
                    <Icon name="check" size={11} className="text-white" />
                  </span>
                  {t}
                </span>
                <span className="text-text-3">
                  <Icon name="arrow" size={16} />
                </span>
              </button>
            ))}
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-[760px]">
      <PageHead title="Instagram" description="Connect a Business or Creator account securely for future publishing and insights features." />
      {connectionError ? <div role="alert" className="mb-3.5 rounded-xl border border-red/30 bg-red/10 p-3 text-sm text-red">Instagram could not be connected. No account changes were made. Please try again.</div> : null}
      <div
        className="relative overflow-hidden rounded-[var(--r-lg)] p-[30px] text-white"
        style={{ background: "linear-gradient(120deg,#f9ce34,#ee2a7b 48%,#6228d7)" }}
      >
        <div className="mb-4 grid h-[52px] w-[52px] place-items-center rounded-2xl bg-white/20">
          <Icon name="ig" size={24} />
        </div>
        <h2 className="font-display text-2xl font-bold">Connect Instagram securely</h2>
        <p className="mt-1.5 max-w-[440px] text-[14.5px] leading-[1.6] opacity-90">
          Connect a professional account through Instagram. Drafting and scheduling stay inside Voom; external publishing remains blocked until it is separately enabled.
        </p>
        <Btn
          className="mt-5 bg-white text-[#b62d6a] hover:bg-white/90"
          variant="plain"
          onClick={() => open(<InstagramConnectModal />)}
        >
          <Icon name="ig" size={16} /> Connect Instagram account
        </Btn>
      </div>
      <div className="mt-3.5 grid gap-3.5 sm:grid-cols-2">
        <Card className="p-4">
          <h3 className="mb-2.5 text-[14.5px] font-semibold">What Voom gets access to</h3>
          {GETS.map((t) => (
            <div key={t} className="flex items-start gap-2.5 py-1.5">
              <span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-green">
                <Icon name="check" size={11} className="text-white" />
              </span>
              <span className="text-[13.3px] leading-[1.5]">{t}</span>
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <h3 className="mb-2.5 text-[14.5px] font-semibold">What she never does</h3>
          {NEVERS.map((t) => (
            <div key={t} className="flex items-start gap-2.5 py-1.5">
              <span className="mt-0.5 grid h-[19px] w-[19px] flex-none place-items-center rounded-full bg-text-3">
                <Icon name="x" size={11} className="text-white" />
              </span>
              <span className="text-[13.3px] leading-[1.5]">{t}</span>
            </div>
          ))}
        </Card>
      </div>
      <Card className="mt-3.5 bg-surface-2 p-4">
        <div className="flex items-start gap-2.5">
          <Icon name="shield" className="text-text-3" />
          <p className="text-[13px] leading-[1.6] text-text-2">
            Connection uses Instagram&apos;s authorization page. Credentials and access tokens stay server-only; Voom never asks for your Instagram password.
            {!connection?.configured ? <><br /><b>Meta application settings are not configured yet, so connection is safely unavailable.</b></> : null}
          </p>
        </div>
      </Card>
    </div>
  );
}

function formatAccountType(value: string | null) {
  if (!value) return "Professional account";
  return value.toLowerCase().replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
