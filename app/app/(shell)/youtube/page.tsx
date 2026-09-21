"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { YouTubeConnectModal } from "@/components/voom/modals/YouTubeConnectModal";
import { DisconnectYouTubeModal } from "@/components/voom/modals/DisconnectYouTubeModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import type { YouTubeConnectionView } from "@/lib/youtube/types";

/**
 * The YouTube hub — the REAL connection (YouTube Provider Integration v1).
 *
 * Everything on this page is truthful by construction:
 *   - the connection card shows the channel identity YouTube itself returned
 *     and the scopes Google actually granted;
 *   - Google's unaudited-project restriction is stated plainly while it
 *     applies: uploads from an API project that has not passed the YouTube
 *     API Services Compliance Audit are locked to PRIVATE by YouTube, and
 *     Voom says so instead of promising public publishing;
 *   - the queue list shows the durable queue's own states. "Published"
 *     appears only when YouTube returned a real video id AND its own
 *     uploadStatus='processed'; provider-applied privacy is shown next to
 *     requested privacy whenever they differ;
 *   - performance numbers come from the official Data API statistics part
 *     only — an absent metric means YouTube did not return it, never zero.
 */

type QueueItem = {
  id: string;
  draftId: string;
  format: "short" | "video";
  title: string;
  status: string;
  statusLabel: string;
  statusTone: "green" | "amber" | "red" | "grey";
  scheduledAt: string;
  requestedPrivacy: string | null;
  providerPrivacy: string | null;
  madeForKids: boolean | null;
  videoId: string | null;
  providerNote: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  publishedAt: string | null;
  attempts: number;
};

type PerformanceVideo = {
  videoId: string;
  contentType: string;
  publishedAt: string | null;
  collectedAt: string | null;
  metrics: Record<string, number>;
};

export default function YouTubePage() {
  return <Suspense fallback={null}><YouTubePageContent /></Suspense>;
}

function YouTubePageContent() {
  const { open } = useModal();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<YouTubeConnectionView | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [performance, setPerformance] = useState<PerformanceVideo[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [defaultPrivacy, setDefaultPrivacy] = useState<string>("");
  const [defaultMadeForKids, setDefaultMadeForKids] = useState<string>("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const connectionError = searchParams.get("youtube_error");
  const justConnected = searchParams.get("youtube") === "connected";

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [statusResponse, queueResponse, performanceResponse] = await Promise.all([
        fetch("/api/integrations/youtube/status", { cache: "no-store" }),
        fetch("/api/integrations/youtube/queue", { cache: "no-store" }),
        fetch("/api/integrations/youtube/performance", { cache: "no-store" }),
      ]);
      if (!statusResponse.ok) throw new Error("status_failed");
      const statusBody = await statusResponse.json() as { connection: YouTubeConnectionView };
      setConnection(statusBody.connection);
      setDefaultPrivacy(statusBody.connection.defaultPrivacy ?? "");
      setDefaultMadeForKids(statusBody.connection.defaultMadeForKids === null ? "" : String(statusBody.connection.defaultMadeForKids));
      setQueue(queueResponse.ok ? (await queueResponse.json() as { items: QueueItem[] }).items : null);
      setPerformance(performanceResponse.ok ? (await performanceResponse.json() as { videos: PerformanceVideo[] }).videos : null);
    } catch {
      setLoadError(true);
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    window.addEventListener("voom:data-changed", () => void load());
    return () => { window.removeEventListener("voom:data-changed", () => void load()); window.clearTimeout(timer); };
  }, [load]);

  async function saveDefaults() {
    setSettingsBusy(true);
    setSettingsMessage(null);
    try {
      const response = await fetch("/api/integrations/youtube/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          defaultPrivacy: defaultPrivacy === "" ? null : defaultPrivacy,
          defaultMadeForKids: defaultMadeForKids === "" ? null : defaultMadeForKids === "true",
        }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save those defaults.");
      setSettingsMessage("Defaults saved. They fill gaps for items with no explicit declaration — Voom never guesses on its own.");
      await load();
    } catch (cause) {
      setSettingsMessage(cause instanceof Error ? cause.message : "Could not save those defaults.");
    } finally {
      setSettingsBusy(false);
    }
  }

  const connected = connection?.connected === true;

  return (
    <div className="mx-auto max-w-[900px]">
      <PageHead
        title="YouTube"
        description={connected
          ? "Your YouTube channel is securely connected. Approved, scheduled items publish through the durable queue — Published appears only after YouTube confirms."
          : "Connect your YouTube channel to publish Shorts and full videos through Voom's durable queue."}
        actions={connected
          ? <Btn variant="danger" size="sm" onClick={() => open(<DisconnectYouTubeModal onDisconnected={() => void load()} />)}>Disconnect</Btn>
          : <Btn variant="primary" size="sm" onClick={() => open(<YouTubeConnectModal />)}>Connect YouTube</Btn>}
      />

      {justConnected && (
        <div role="status" className="mb-3.5 rounded-xl border border-green/35 bg-green/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-green">
          YouTube channel connected. Tokens are encrypted on Voom&apos;s server; nothing was published yet.
        </div>
      )}
      {connectionError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red">
          The YouTube connection did not complete (<code>{connectionError}</code>). Nothing was stored. Please retry — if Google
          did not grant offline access, make sure you choose your channel on the consent screen and allow the requested permissions.
        </div>
      )}
      {loadError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
          YouTube status could not be loaded right now. Please retry.
        </div>
      )}

      {connected && connection && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <div className="flex items-center gap-2.5">
              {connection.thumbnailUrl
                ? <img src={connection.thumbnailUrl} alt="" className="h-[52px] w-[52px] rounded-full object-cover" />
                : <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[#ff0000] text-white"><Icon name="play" /></span>}
              <div>
                <div className="flex items-center gap-1.5">
                  <b className="text-[17px]">{connection.channelTitle ?? connection.channelId}</b>
                  <Tag tone="t-green"><Icon name="check" size={12} /> Connected</Tag>
                </div>
                <div className="text-[13px] text-text-3">
                  {connection.channelHandle ? `${connection.channelHandle} · ` : ""}{connection.channelId}
                </div>
                <div className="mt-0.5 text-xs text-text-3">
                  Scopes granted: {connection.scopes.map((scope) => scope.replace("https://www.googleapis.com/auth/", "")).join(", ") || "none reported"}
                </div>
              </div>
            </div>
          </div>
          {!connection.projectAudited && (
            <div role="status" className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber">
              Google restriction in effect: videos uploaded through an API project that has not passed the YouTube API
              Services Compliance Audit are locked to <b>private</b> viewing mode by YouTube — no matter which privacy is
              requested. Voom uploads, then reports the privacy YouTube actually applied. Public publishing becomes
              available once the project passes Google&apos;s audit.
            </div>
          )}
        </Card>
      )}

      {connected && (
        <Card className="mt-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">Publishing defaults</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-3">
            Optional, explicit defaults for items that carry no declaration of their own. Voom never guesses
            policy-sensitive metadata: with no default and no per-item declaration, the item waits visibly in
            &quot;Needs audience declaration&quot; instead of publishing with a value nobody chose.
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <label className="block">
              <span className="text-xs font-medium text-text-2">Default privacy</span>
              <select
                value={defaultPrivacy}
                onChange={(event) => setDefaultPrivacy(event.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
              >
                <option value="">No default (declare per item)</option>
                <option value="private">Private</option>
                <option value="unlisted">Unlisted</option>
                <option value="public">Public</option>
              </select>
            </label>
            <label className="block">
              <span className="text-xs font-medium text-text-2">Default audience (COPPA)</span>
              <select
                value={defaultMadeForKids}
                onChange={(event) => setDefaultMadeForKids(event.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm"
              >
                <option value="">No default (declare per item)</option>
                <option value="false">Not made for kids</option>
                <option value="true">Made for kids</option>
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Btn variant="outline" size="sm" disabled={settingsBusy} onClick={() => void saveDefaults()}>{settingsBusy ? "Saving…" : "Save defaults"}</Btn>
            {settingsMessage ? <span className="text-xs text-text-3">{settingsMessage}</span> : null}
          </div>
        </Card>
      )}

      <Card className="mt-3.5 p-4">
        <h2 className="font-display text-lg font-semibold">Publish queue</h2>
        <p className="mt-1 text-xs text-text-3">
          The durable YouTube queue. Scheduled means approved and waiting for its time — not submitted. Published
          means YouTube returned this video id and confirmed it is processed.
        </p>
        {!queue || queue.length === 0 ? (
          <p className="mt-3 text-sm text-text-3">Nothing on the YouTube queue yet. Approve and schedule a YouTube Short or Video in the Studio or a campaign.</p>
        ) : (
          <div className="mt-3 divide-y divide-line">
            {queue.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="truncate text-sm">{item.title}</b>
                    <Tag tone="t-grey">{item.format === "short" ? "Short" : "Video"}</Tag>
                    <Tag tone={item.statusTone === "green" ? "t-green" : item.statusTone === "amber" ? "t-amber" : item.statusTone === "red" ? "t-red" : "t-grey"}>{item.statusLabel}</Tag>
                  </div>
                  <div className="mt-0.5 text-xs text-text-3">
                    {new Date(item.scheduledAt).toLocaleString()}
                    {item.videoId ? <> · <a className="underline" href={`https://www.youtube.com/watch?v=${item.videoId}`} target="_blank" rel="noreferrer">youtube.com/watch?v={item.videoId}</a></> : null}
                    {item.providerPrivacy && item.requestedPrivacy && item.providerPrivacy !== item.requestedPrivacy
                      ? <> · requested {item.requestedPrivacy}, YouTube applied <b>{item.providerPrivacy}</b></>
                      : item.providerPrivacy ? <> · {item.providerPrivacy}</> : null}
                  </div>
                  {item.providerNote ? <div className="mt-0.5 text-xs text-amber">{item.providerNote}</div> : null}
                  {item.failureMessage ? <div className="mt-0.5 text-xs text-red">{item.failureMessage}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {performance && performance.length > 0 && (
        <Card className="mt-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">Performance</h2>
          <p className="mt-1 text-xs text-text-3">
            Official YouTube Data API statistics for videos Voom published. A dash means YouTube did not return that
            number — it is never a zero in disguise.
          </p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            {performance.slice(0, 12).map((video) => (
              <div key={video.videoId} className="rounded-xl bg-surface-2 p-3">
                <div className="flex items-center justify-between gap-2">
                  <a className="truncate text-sm font-medium underline" href={`https://www.youtube.com/watch?v=${video.videoId}`} target="_blank" rel="noreferrer">{video.videoId}</a>
                  <Tag tone="t-grey">{video.contentType === "short" ? "Short" : "Video"}</Tag>
                </div>
                <div className="mt-1.5 grid grid-cols-3 gap-2 text-xs text-text-3">
                  <span>Views <b className="font-mono text-text-1">{typeof video.metrics.views === "number" ? video.metrics.views.toLocaleString() : "—"}</b></span>
                  <span>Likes <b className="font-mono text-text-1">{typeof video.metrics.likes === "number" ? video.metrics.likes.toLocaleString() : "—"}</b></span>
                  <span>Comments <b className="font-mono text-text-1">{typeof video.metrics.comments === "number" ? video.metrics.comments.toLocaleString() : "—"}</b></span>
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {!connected && !loadError && (
        <Card className="mt-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">How YouTube publishing works in Voom</h2>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-text-2">
            <li>1. Plan a YouTube Short or full Video in the Studio or a campaign, declare its audience and privacy, approve and schedule it.</li>
            <li>2. Approval puts it on Voom&apos;s durable YouTube queue — one publish identity per item, impossible to double-upload.</li>
            <li>3. At the scheduled time the worker streams the video to YouTube through Google&apos;s resumable upload protocol; interrupted uploads resume, they never restart or duplicate.</li>
            <li>4. YouTube processes the video; Voom reports Published only when YouTube itself confirms processing finished, with the real video id.</li>
            <li>5. Performance collects real views, likes and comments for published videos — read-only, hourly, never revenue data.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
