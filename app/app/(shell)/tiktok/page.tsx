"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { TikTokConnectModal } from "@/components/voom/modals/TikTokConnectModal";
import { DisconnectTikTokModal } from "@/components/voom/modals/DisconnectTikTokModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import type { TikTokConnectionView } from "@/lib/tiktok/types";

/**
 * The TikTok hub — the REAL connection (TikTok Provider Integration v1).
 *
 * Everything on this page is truthful by construction:
 *   - the connection card shows the identity TikTok itself returned (open_id,
 *     display name, avatar) and the scopes TikTok actually granted;
 *   - TikTok's unaudited-app restriction is stated plainly while it applies:
 *     until Voom's app passes the content-sharing audit, TikTok restricts
 *     posts through it to SELF_ONLY viewership;
 *   - TikTok has NO default privacy level: the default selector is an
 *     explicit owner declaration, and "no default" is a real, visible state;
 *   - the queue list shows the durable queue's own states. "Published"
 *     appears only when TikTok's own post-status endpoint returned
 *     PUBLISH_COMPLETE — the provider's own evidence, never Voom's guess;
 *   - performance data is honestly unavailable: Voom requested no analytics
 *     scopes, so no numbers are shown — and never fake zeros.
 */

type QueueItem = {
  id: string;
  draftId: string;
  title: string;
  status: string;
  statusLabel: string;
  statusTone: "green" | "amber" | "red" | "grey";
  scheduledAt: string;
  requestedPrivacy: string | null;
  providerStatus: string | null;
  providerPostId: string | null;
  providerNote: string | null;
  failureCode: string | null;
  failureMessage: string | null;
  publishedAt: string | null;
  attempts: number;
};

const PRIVACY_OPTIONS: { value: string; label: string }[] = [
  { value: "PUBLIC_TO_EVERYONE", label: "Everyone" },
  { value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends of friends (mutual follow)" },
  { value: "FOLLOWER_OF_CREATOR", label: "Followers" },
  { value: "SELF_ONLY", label: "Only me (private)" },
];

export default function TikTokPage() {
  return <Suspense fallback={null}><TikTokPageContent /></Suspense>;
}

function TikTokPageContent() {
  const { open } = useModal();
  const searchParams = useSearchParams();
  const [connection, setConnection] = useState<TikTokConnectionView | null>(null);
  const [queue, setQueue] = useState<QueueItem[] | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [defaultPrivacy, setDefaultPrivacy] = useState<string>("");
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [settingsMessage, setSettingsMessage] = useState<string | null>(null);
  const connectionError = searchParams.get("tiktok_error");
  const justConnected = searchParams.get("tiktok") === "connected";

  const load = useCallback(async () => {
    setLoadError(false);
    try {
      const [statusResponse, queueResponse] = await Promise.all([
        fetch("/api/integrations/tiktok/status", { cache: "no-store" }),
        fetch("/api/integrations/tiktok/queue", { cache: "no-store" }),
      ]);
      if (!statusResponse.ok) throw new Error("status_failed");
      const statusBody = await statusResponse.json() as { connection: TikTokConnectionView };
      setConnection(statusBody.connection);
      setDefaultPrivacy(statusBody.connection.defaultPrivacy ?? "");
      setQueue(queueResponse.ok ? (await queueResponse.json() as { items: QueueItem[] }).items : null);
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
      const response = await fetch("/api/integrations/tiktok/settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ defaultPrivacy: defaultPrivacy === "" ? null : defaultPrivacy }),
      });
      const body = await response.json() as { error?: string };
      if (!response.ok) throw new Error(body.error ?? "Could not save those defaults.");
      setSettingsMessage("Default saved. It fills gaps for items with no explicit choice — TikTok's live options still win at publish time.");
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
        title="TikTok"
        description={connected
          ? "Your TikTok account is securely connected. Approved, scheduled items publish through the durable queue — Published appears only after TikTok confirms."
          : "Connect your TikTok account to publish videos through Voom's durable queue."}
        actions={connected
          ? <Btn variant="danger" size="sm" onClick={() => open(<DisconnectTikTokModal onDisconnected={() => void load()} />)}>Disconnect</Btn>
          : <Btn variant="primary" size="sm" onClick={() => open(<TikTokConnectModal />)}>Connect TikTok</Btn>}
      />

      {justConnected && (
        <div role="status" className="mb-3.5 rounded-xl border border-green/35 bg-green/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-green">
          TikTok account connected. Tokens are encrypted on Voom&apos;s server; nothing was published yet.
        </div>
      )}
      {connectionError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-red">
          The TikTok connection did not complete (<code>{connectionError}</code>). Nothing was stored. Please retry.
        </div>
      )}
      {loadError && (
        <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
          TikTok status could not be loaded right now. Please retry.
        </div>
      )}

      {connected && connection && (
        <Card className="p-4">
          <div className="flex flex-wrap items-center justify-between gap-3.5">
            <div className="flex items-center gap-2.5">
              {connection.avatarUrl
                ? <img src={connection.avatarUrl} alt="" className="h-[52px] w-[52px] rounded-full object-cover" />
                : <span className="grid h-[52px] w-[52px] place-items-center rounded-full bg-[#010101] text-white"><Icon name="film" /></span>}
              <div>
                <div className="flex items-center gap-1.5">
                  <b className="text-[17px]">{connection.displayName ?? connection.openId}</b>
                  <Tag tone="t-green"><Icon name="check" size={12} /> Connected</Tag>
                </div>
                <div className="text-[13px] text-text-3">
                  {connection.creatorUsername ? `@${connection.creatorUsername} · ` : ""}{connection.openId}
                </div>
                <div className="mt-0.5 text-xs text-text-3">
                  Scopes granted: {connection.scopes.join(", ") || "none reported"}
                </div>
              </div>
            </div>
          </div>
          {!connection.appAudited && (
            <div role="status" className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3.5 py-2.5 text-[12.5px] leading-relaxed text-amber">
              TikTok restriction in effect: until Voom&apos;s app passes TikTok&apos;s content-sharing audit, TikTok
              restricts posts through it to <b>private (Only me)</b> viewership, and the account must be private at
              posting time. Voom posts as you choose and reports exactly what TikTok accepts — it never claims a
              public post happened. Wider reach becomes available once the audit passes; nothing here pretends
              otherwise.
            </div>
          )}
        </Card>
      )}

      {connected && (
        <Card className="mt-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">Publishing defaults</h2>
          <p className="mt-1 text-xs leading-relaxed text-text-3">
            Optional, explicit default for items that carry no privacy choice of their own. TikTok has NO default
            privacy level: with no default and no per-item choice, the item waits visibly in &quot;Needs a privacy
            choice&quot; instead of publishing with a value nobody chose. The options TikTok returns for your
            account at publish time still win.
          </p>
          <div className="mt-3">
            <label className="block">
              <span className="text-xs font-medium text-text-2">Default privacy</span>
              <select
                value={defaultPrivacy}
                onChange={(event) => setDefaultPrivacy(event.target.value)}
                className="mt-1 w-full rounded-xl border border-line bg-surface px-3 py-2 text-sm sm:max-w-sm"
              >
                <option value="">No default (declare per item)</option>
                {PRIVACY_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
              </select>
            </label>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <Btn variant="outline" size="sm" disabled={settingsBusy} onClick={() => void saveDefaults()}>{settingsBusy ? "Saving…" : "Save default"}</Btn>
            {settingsMessage ? <span className="text-xs text-text-3">{settingsMessage}</span> : null}
          </div>
        </Card>
      )}

      <Card className="mt-3.5 p-4">
        <h2 className="font-display text-lg font-semibold">Publish queue</h2>
        <p className="mt-1 text-xs text-text-3">
          The durable TikTok queue. Scheduled means approved and waiting for its time — not submitted. Published
          means TikTok&apos;s own post-status endpoint confirmed PUBLISH_COMPLETE.
        </p>
        {!queue || queue.length === 0 ? (
          <p className="mt-3 text-sm text-text-3">Nothing on the TikTok queue yet. Approve and schedule a TikTok Video in the Studio or a campaign.</p>
        ) : (
          <div className="mt-3 divide-y divide-line">
            {queue.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <b className="truncate text-sm">{item.title}</b>
                    <Tag tone={item.statusTone === "green" ? "t-green" : item.statusTone === "amber" ? "t-amber" : item.statusTone === "red" ? "t-red" : "t-grey"}>{item.statusLabel}</Tag>
                  </div>
                  <div className="mt-0.5 text-xs text-text-3">
                    {new Date(item.scheduledAt).toLocaleString()}
                    {item.requestedPrivacy ? <> · privacy: {item.requestedPrivacy}</> : null}
                    {item.providerStatus ? <> · TikTok: {item.providerStatus}</> : null}
                    {item.providerPostId ? <> · post {item.providerPostId}</> : null}
                  </div>
                  {item.providerNote ? <div className="mt-0.5 text-xs text-amber">{item.providerNote}</div> : null}
                  {item.failureMessage ? <div className="mt-0.5 text-xs text-red">{item.failureMessage}</div> : null}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      <Card className="mt-3.5 p-4">
        <h2 className="font-display text-lg font-semibold">Performance</h2>
        <p className="mt-1 text-xs leading-relaxed text-text-3">
          TikTok performance data is not available through Voom&apos;s connection. Voom intentionally requests only
          the scopes it needs to publish (basic identity + posting) and asks TikTok for no analytics access, so no
          numbers are shown here — and none are invented. Check TikTok&apos;s own analytics for views and engagement.
        </p>
      </Card>

      {!connected && !loadError && (
        <Card className="mt-3.5 p-4">
          <h2 className="font-display text-lg font-semibold">How TikTok publishing works in Voom</h2>
          <ul className="mt-2 space-y-1.5 text-[13px] leading-relaxed text-text-2">
            <li>1. Plan a TikTok Video in the Studio or a campaign, declare its privacy choice, approve and schedule it.</li>
            <li>2. Approval puts it on Voom&apos;s durable TikTok queue — one publish identity per item, impossible to double-post.</li>
            <li>3. At the scheduled time the worker checks TikTok&apos;s live creator options, then starts the Direct Post and streams the video in resumable chunks; interrupted uploads resume, they never restart or duplicate.</li>
            <li>4. TikTok processes the video; Voom reports Published only when TikTok&apos;s own post-status endpoint confirms PUBLISH_COMPLETE.</li>
            <li>5. Until Voom&apos;s app passes TikTok&apos;s content-sharing audit, TikTok restricts posts to private viewership — Voom says so plainly and never claims more.</li>
          </ul>
        </Card>
      )}
    </div>
  );
}
