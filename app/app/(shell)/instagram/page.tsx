"use client";

import { useVoomActions, useVoomState, useCurrentPack } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { PageHead } from "@/components/voom/shell/AppShell";
import { InstagramConnectModal } from "@/components/voom/modals/InstagramConnectModal";
import { DisconnectInstagramModal } from "@/components/voom/modals/DisconnectInstagramModal";
import { Btn, Card, Tag } from "@/components/voom/ui/primitives";
import { DemoTag, PROTO_TEXT } from "@/components/voom/ui/Notes";

const GETS = [
  "Publish Reels, posts and stories on your behalf",
  "Read reach, engagement and follower insights",
  "Read and reply to comments and DMs",
  "View your last 90 days of performance",
];
const NEVERS = [
  "Change your password or account settings",
  "Spend money without your written approval",
  "Follow, unfollow or DM anyone unprompted",
  "Share your data with other brands",
];

export default function InstagramPage() {
  const { igConnected, brand } = useVoomState();
  const { toast, goTo } = useVoomActions();
  const { open } = useModal();
  const pack = useCurrentPack();

  if (igConnected) {
    return (
      <div className="mx-auto max-w-[900px]">
        <PageHead
          title="Instagram"
          description="Connected in this prototype — no real Instagram account is linked."
          tags={<DemoTag />}
          actions={
            <Btn
              variant="outline"
              size="sm"
              onClick={() => {
                toast("Resyncing insights…", "info");
                setTimeout(() => toast("Synced 90 days of data"), 1200);
              }}
            >
              Sync now
            </Btn>
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
                  {brand.name[0]}
                </span>
              </span>
              <div>
                <div className="flex items-center gap-1.5">
                  <b className="text-[17px]">{brand.name}</b>
                  <Tag tone="t-green">
                    <Icon name="check" size={12} /> Connected
                  </Tag>
                </div>
                <div className="text-[13px] text-text-3">{brand.handle} · Business account</div>
                <div className="mt-0.5 text-xs text-text-3">Last synced 4 minutes ago</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Btn variant="ghost" size="sm" onClick={() => toast("Permissions unchanged (demo)", "info")}>
                Permissions
              </Btn>
              <Btn variant="danger" size="sm" onClick={() => open(<DisconnectInstagramModal />)}>
                Disconnect
              </Btn>
            </div>
          </div>
          <div className="my-3.5 h-px bg-line" />
          <div className="grid gap-2.5 sm:grid-cols-3">
            {(
              [
                ["48,204", "Followers", "+3,412"],
                ["6.8%", "Engagement", "+1.2 pts"],
                ["184.2K", "30-day reach", "+18.4%"],
              ] as [string, string, string][]
            ).map(([a, b, c]) => (
              <div key={a} className="rounded-xl bg-surface-2 p-2.5 text-center">
                <b className="block font-display text-[19px]">{a}</b>
                <span className="text-[11px] text-text-3">{b}</span>
                <div className="mt-0.5 text-[11px] font-semibold text-green">{c}</div>
              </div>
            ))}
          </div>
        </Card>
        <div className="mt-3.5 grid gap-3.5 lg:grid-cols-2">
          <Card className="p-4">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <h2 className="font-display text-lg font-semibold">Top posts, last 30 days</h2>
              <DemoTag />
            </div>
            {(
              [
                [pack.top[0], "Reel", "112K", "#e8481f"],
                [pack.top[1], "Feed", "28K", "#c9306b"],
                [pack.top[2], "Reel", "41K", "#e8481f"],
              ] as [string, string, string, string][]
            ).map(([t, ty, v, c]) => (
              <div key={t} className="flex items-center gap-2.5 border-b border-line py-2.5 last:border-0">
                <div className="h-12 w-[38px] flex-none rounded-[8px]" style={{ background: c }} />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[13.3px] font-semibold">{t}</div>
                  <span className="text-xs text-text-3">{ty}</span>
                </div>
                <b className="font-mono text-[13px]">{v}</b>
                <span className="text-[11.5px] text-text-3">views</span>
              </div>
            ))}
          </Card>
          <Card className="p-4">
            <h2 className="mb-3 font-display text-lg font-semibold">What MARA can do now</h2>
            {(
              [
                ["Auto-publish Reels at 7:10 PM", "reels"],
                ["Pull live insights into your dashboard", "dash"],
                ["Run paid campaigns on this account", "ads"],
                ["Draft replies to comments", "mara"],
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
      <PageHead title="Instagram" description="Connect a Business or Creator account so MARA can publish and read insights." />
      <div
        className="relative overflow-hidden rounded-[var(--r-lg)] p-[30px] text-white"
        style={{ background: "linear-gradient(120deg,#f9ce34,#ee2a7b 48%,#6228d7)" }}
      >
        <div className="mb-4 grid h-[52px] w-[52px] place-items-center rounded-2xl bg-white/20">
          <Icon name="ig" size={24} />
        </div>
        <h2 className="font-display text-2xl font-bold">Let MARA run your Instagram</h2>
        <p className="mt-1.5 max-w-[440px] text-[14.5px] leading-[1.6] opacity-90">
          Publish Reels and posts automatically, pull real reach and engagement, and spot trends before your competitors do.
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
          <h3 className="mb-2.5 text-[14.5px] font-semibold">What MARA gets access to</h3>
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
            This is a visual prototype — no real Instagram connection is made. &quot;Connect&quot; walks through a simulated authorisation flow using
            sample accounts.
            <br />
            <b>{PROTO_TEXT}</b>
          </p>
        </div>
      </Card>
    </div>
  );
}
