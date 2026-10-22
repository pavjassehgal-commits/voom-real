"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Icon } from "@/components/voom/icons";
import { SocialEditorModal } from "@/components/voom/modals/SocialEditorModal";
import { BTN, ChannelGlyph, CreateStepper, PageHeader, StatusChip } from "@/components/voom/redesign/ui";
import type { CreateDraft, ReadinessCheck } from "@/lib/voom/create-readiness";
import { useModal } from "@/lib/voom/modal";
import { cx } from "@/lib/voom/cx";
import { StepFooter } from "./CreatePreview";

const CHANNEL_NAME = { instagram: "Instagram", tiktok: "TikTok", youtube: "YouTube" } as const;

type When = "pick" | "unscheduled";

/**
 * Create · Step 3 · Schedule.
 * Instagram: "Schedule post" saves the chosen time and approves the post
 * through the existing `/api/posts/[id]` route — the same validation, the
 * same schedule guard and the same content-version check as the editor.
 * TikTok / YouTube: the platforms require a per-post privacy and consent
 * record, which only the existing publishing editor collects, so scheduling
 * hands off to it rather than re-implementing that compliance step.
 */
export function CreateSchedule({ draft, connected, checks }: { draft: CreateDraft; connected: boolean | null; checks: ReadinessCheck[] }) {
  const router = useRouter();
  const { open } = useModal();
  const [when, setWhen] = useState<When>("pick");
  // The input shows the browser's local time, which the server cannot know,
  // so the default is filled in after mount (deferred, not a synchronous
  // setState in the effect body).
  const [local, setLocal] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setLocal((current) => current || toLocalInput(draft.scheduledAt && Date.parse(draft.scheduledAt) > Date.now() ? draft.scheduledAt : nextHour())), 0);
    return () => window.clearTimeout(timer);
  }, [draft.scheduledAt]);
  const [busy, setBusy] = useState<"save" | "schedule" | null>(null);
  const [error, setError] = useState("");
  const [done, setDone] = useState<{ at: string } | null>(null);

  const failing = checks.filter((check) => !check.ok);
  const iso = when === "pick" && local ? new Date(local).toISOString() : null;
  const goesLive = iso ? formatWhen(iso) : null;
  const isInstagram = draft.editor === "post";

  async function patch(body: Record<string, unknown>) {
    const response = await fetch(isInstagram ? `/api/posts/${draft.id}` : `/api/social-drafts/${draft.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const json = await response.json() as { post?: { contentVersion?: number }; error?: string };
    if (!response.ok) throw new Error(json.error ?? "Voom couldn't save that. Please retry.");
    return json;
  }

  async function saveDraft() {
    setBusy("save"); setError("");
    try {
      await patch({ scheduledAt: iso });
      window.dispatchEvent(new Event("voom:data-changed"));
      router.push(`/app/content/${draft.id}`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't save that. Please retry.");
      setBusy(null);
    }
  }

  async function schedule() {
    if (!iso) return;
    setBusy("schedule"); setError("");
    if (!isInstagram) {
      // Save the chosen time, then confirm privacy/consent in the publishing editor.
      try {
        await patch({ scheduledAt: iso });
        window.dispatchEvent(new Event("voom:data-changed"));
        open(<SocialEditorModal draftId={draft.id} onChanged={() => router.refresh()} />);
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "Voom couldn't save that time. Please retry.");
      } finally {
        setBusy(null);
      }
      return;
    }
    try {
      const saved = await patch({ scheduledAt: iso });
      await patch({ action: "approve", ...(typeof saved.post?.contentVersion === "number" ? { contentVersion: saved.post.contentVersion } : {}) });
      window.dispatchEvent(new Event("voom:data-changed"));
      setDone({ at: iso });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Voom couldn't schedule that. Please retry.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="min-w-0 pb-24">
      <PageHeader title={`Schedule your ${draft.typeLabel.replace(/^Instagram /, "")}`} subtitle={<span className="text-[14px]">{draft.title || "Untitled"} · saved in Voom</span>} actions={<CreateStepper step={3} />} />

      {error && <div role="alert" className="mb-4 rounded-[16px] border border-[var(--red)]/30 bg-[var(--red-soft)] px-4 py-3 text-[14px] text-[var(--red)]">{error}</div>}

      <div className="grid min-w-0 grid-cols-[minmax(0,1fr)] gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <section className="voom-card p-5 sm:p-6" aria-labelledby="schedule-when">
            <h2 id="schedule-when" className="text-[17px] font-semibold text-text">When should it go out?</h2>
            <div className="mt-4 grid gap-3 md:grid-cols-2" role="radiogroup" aria-label="When">
              <Option selected={when === "pick"} onSelect={() => setWhen("pick")} title="Pick a date and time" detail="Voom publishes at this time once approved.">
                <input type="datetime-local" value={local} onChange={(event) => { setLocal(event.target.value); setWhen("pick"); }}
                  aria-label="Date and time" className={cx(BTN.field, "mt-3 w-full")} />
              </Option>
              <Option selected={when === "unscheduled"} onSelect={() => setWhen("unscheduled")} title="Keep it unscheduled" detail="Stays in Content › Drafts with no date. Save it as a draft." />
            </div>
          </section>

          <section className="voom-card p-5 sm:p-6" aria-labelledby="schedule-channel">
            <h2 id="schedule-channel" className="text-[17px] font-semibold text-text">Channel</h2>
            <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-3">
              <span className="flex items-center gap-3"><ChannelGlyph channel={draft.channel} size={26} /><span><span className="block font-semibold text-text">{CHANNEL_NAME[draft.channel]}</span><span className="block text-[13px] text-text-2">{draft.typeLabel}</span></span></span>
              <span className="flex items-center gap-3">
                <span className="text-[14px] font-semibold text-text">{iso ? new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(new Date(iso)) : "No time"}</span>
                <StatusChip status={connected === false ? "connection_required" : failing.length ? "needs_approval" : "published"} label={connected === false ? "Not connected" : failing.length ? `${failing.length} to fix` : "Ready"} small />
              </span>
            </div>
          </section>

          <section className="voom-card flex gap-4 p-5 sm:p-6" aria-labelledby="schedule-approval">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-[12px] bg-[var(--green-soft)] text-[var(--green)]"><Icon name="shield" size={18} /></span>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="schedule-approval" className="text-[16px] font-semibold text-text">Approval</h2>
                <Link href="/app/automations" className="text-[13.5px] font-medium text-[var(--brand-ink)] hover:opacity-80">Automation settings</Link>
              </div>
              <p className="mt-1 text-[14px] leading-relaxed text-text-2">
                {isInstagram
                  ? "Nothing publishes without approval. As the workspace owner, scheduling this post approves exactly the version you previewed."
                  : `${CHANNEL_NAME[draft.channel]} requires you to confirm privacy and consent for each post. Scheduling opens the publishing settings where you confirm it.`}
              </p>
            </div>
          </section>
        </div>

        <aside className="voom-card self-start p-5 sm:p-6" aria-label="Summary">
          <div className="flex items-center gap-3">
            <span className="relative grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-[12px] bg-[linear-gradient(140deg,#f6a38a,#f3c4d6)] text-white">
              {draft.previewUrl && !draft.mimeType?.startsWith("video")
                // eslint-disable-next-line @next/next/no-img-element -- short-lived signed preview URL
                ? <img src={draft.previewUrl} alt="" className="absolute inset-0 h-full w-full object-cover" />
                : <Icon name={draft.kind === "instagram_post" ? "img" : "video"} size={20} />}
            </span>
            <span className="min-w-0"><span className="block truncate text-[15px] font-semibold text-text">{draft.title || "Untitled"}</span><span className="block text-[13px] text-text-2">{draft.typeLabel} · 1 channel</span></span>
          </div>
          <div className="mt-4 rounded-[16px] border border-[var(--brand-line)] bg-[var(--brand-soft-2)] p-4">
            <div className="text-[11.5px] font-semibold uppercase tracking-[0.14em] text-[var(--brand-ink)]">Goes live</div>
            <div className="mt-1 text-[20px] font-bold tracking-[-0.02em] text-text">{goesLive ?? "Not scheduled"}</div>
            <div className="mt-0.5 text-[13px] text-text-2">{goesLive ? "Your local time" : "Saved as a draft without a date"}</div>
          </div>
          <dl className="mt-4 space-y-2.5 text-[14px]">
            <Row label="Channel" value={CHANNEL_NAME[draft.channel]} />
            <Row label="Approval" value={isInstagram ? "Owner — scheduling approves" : "Confirmed in publishing settings"} />
            <Row label="Ad spend" value="None (organic)" />
          </dl>
          <div className={cx("mt-4 flex items-start gap-2 rounded-[14px] px-3.5 py-3 text-[13.5px]", failing.length ? "bg-[var(--amber-soft)] text-[var(--amber)]" : "bg-[var(--green-soft)] text-[var(--green)]")}>
            <Icon name={failing.length ? "warn" : "check"} size={15} className="mt-0.5 shrink-0" />
            <span>{failing.length ? `${failing.length} readiness check${failing.length === 1 ? "" : "s"} to fix: ${failing.map((check) => check.label).join(", ")}.` : `All ${checks.length} readiness checks passed`}</span>
          </div>
          {failing.length > 0 && <Link href={`/app/studio/${draft.id}`} className="mt-3 inline-flex text-[13.5px] font-semibold text-[var(--brand-ink)] hover:underline">Review in preview</Link>}
        </aside>
      </div>

      <StepFooter>
        <Link href={`/app/studio/${draft.id}`} className="inline-flex items-center gap-2 text-[14px] font-medium text-text-2 hover:text-text"><Icon name="back" size={15} /> Back to preview</Link>
        <div className="flex gap-2.5">
          <button type="button" className={cx(BTN.quiet, "rounded-full")} disabled={busy !== null} onClick={() => void saveDraft()}>{busy === "save" ? "Saving…" : "Save draft"}</button>
          <button type="button" className={BTN.primary} disabled={busy !== null || when !== "pick" || !local || (isInstagram && failing.length > 0)} onClick={() => void schedule()}>
            {busy === "schedule" ? "Scheduling…" : isInstagram ? "Schedule post" : "Confirm and schedule"} <Icon name="arrow" size={15} />
          </button>
        </div>
      </StepFooter>

      {done && <Confirmation draft={draft} at={done.at} connected={connected} />}
    </div>
  );
}

function Option({ selected, onSelect, title, detail, children }: { selected: boolean; onSelect: () => void; title: string; detail: string; children?: React.ReactNode }) {
  return (
    <div className={cx("rounded-[16px] border p-4 transition", selected ? "border-[var(--brand-line)] bg-[var(--brand-soft-2)]" : "border-line")}>
      <button type="button" role="radio" aria-checked={selected} onClick={onSelect} className="flex w-full items-start gap-3 text-left">
        <span className={cx("mt-0.5 grid h-5 w-5 shrink-0 place-items-center rounded-full border-2", selected ? "border-[var(--brand)]" : "border-line-2")}>{selected && <span className="h-2.5 w-2.5 rounded-full bg-[var(--brand)]" />}</span>
        <span><span className="block text-[15px] font-semibold text-text">{title}</span><span className="block text-[13px] text-text-2">{detail}</span></span>
      </button>
      {children}
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-3"><dt className="text-text-2">{label}</dt><dd className="text-right font-semibold text-text">{value}</dd></div>;
}

/** Figma "26 — Scheduled confirmation": shown only after the approve call succeeded. */
function Confirmation({ draft, at, connected }: { draft: CreateDraft; at: string; connected: boolean | null }) {
  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-[rgba(26,31,48,0.35)] p-4 backdrop-blur-[3px]" role="dialog" aria-modal="true" aria-labelledby="scheduled-title">
      <div className="w-full max-w-[480px] rounded-[24px] bg-surface p-6 text-center shadow-[var(--shadow-lg)] sm:p-7">
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-full bg-[var(--green-soft)] text-[var(--green)]"><Icon name="check" size={22} /></span>
        <h2 id="scheduled-title" className="mt-4 text-[22px] font-bold leading-tight tracking-[-0.03em] text-text">Scheduled for {formatWhen(at)}</h2>
        <p className="mt-2 text-[14px] leading-relaxed text-text-2">Your {draft.typeLabel} will publish to {CHANNEL_NAME[draft.channel]}. It shows “Published” only after {CHANNEL_NAME[draft.channel]} confirms.</p>
        <div className="mt-4 flex items-center justify-between rounded-[14px] border border-line px-4 py-3">
          <span className="flex items-center gap-2.5 font-semibold text-text"><ChannelGlyph channel={draft.channel} size={20} />{CHANNEL_NAME[draft.channel]}</span>
          <StatusChip status="scheduled" label="Scheduled" small />
        </div>
        {connected === false && <p className="mt-3 rounded-[14px] bg-[var(--coral-soft)] px-4 py-3 text-left text-[13.5px] text-[var(--coral)]">Connect {CHANNEL_NAME[draft.channel]} before {formatWhen(at)} so this post can go out on time.</p>}
        <div className="mt-5 grid grid-cols-2 gap-3">
          <Link href="/app/studio" className={cx(BTN.quiet, "rounded-full")}>Create another</Link>
          <Link href="/app/calendar" className={BTN.primary}>View in calendar <Icon name="arrow" size={14} /></Link>
        </div>
      </div>
    </div>
  );
}

function nextHour() {
  const date = new Date(Date.now() + 60 * 60_000);
  date.setMinutes(0, 0, 0);
  return date.toISOString();
}

function toLocalInput(iso: string) {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  const today = new Date();
  const prefix = date.toDateString() === today.toDateString() ? "Today, " : "";
  return `${prefix}${new Intl.DateTimeFormat("en-GB", { weekday: "short", day: "numeric", month: "short" }).format(date)} · ${new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }).format(date)}`;
}
