"use client";

import { useCallback, useEffect, useState } from "react";

import { useModal } from "@/lib/voom/modal";
import type { EmailFlowStepView, EmailFlowView } from "@/lib/email-flows/types";
import { formatLocalDateTime } from "@/lib/voom/timezone";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Input, Tag, Textarea, cx } from "../ui/primitives";

const STATUS_TONE: Record<string, string> = {
  active: "t-green",
  paused: "t-amber",
  draft: "t-blue",
  archived: "t-grey",
};

/**
 * The flow detail. It answers the three questions a lifecycle automation has to
 * answer on its own: who gets this, why they get it, and what happens next.
 *
 * Everything shown is read from the database — counts, next schedule and the
 * activity log included. Nothing is estimated here.
 */
export function EmailFlowModal({
  flowId,
  initial,
  timeZone = "Asia/Dubai",
  onChanged,
}: {
  flowId: string;
  initial?: EmailFlowView | null;
  timeZone?: string;
  onChanged?: () => void;
}) {
  const { close } = useModal();
  // The caller's copy seeds the state directly, so nothing has to be pushed
  // into it from an effect afterwards.
  const [flow, setFlow] = useState<EmailFlowView | null>(initial ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState(false);
  const [drafts, setDrafts] = useState<EmailFlowStepView[]>(
    () => (initial?.steps ?? []).map((step) => ({ ...step })),
  );

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/voom/email-flows/${encodeURIComponent(flowId)}`, { cache: "no-store" });
      const body = await response.json() as { flow?: EmailFlowView; error?: string };
      if (response.ok && body.flow) {
        setFlow(body.flow);
        setDrafts(body.flow.steps.map((step) => ({ ...step })));
      } else {
        setError(body.error ?? "That flow couldn\'t load.");
      }
    } catch {
      setError("That flow couldn\'t load.");
    }
  }, [flowId]);

  // Only needed when the modal was opened without the flow already in hand.
  useEffect(() => {
    if (initial) return;
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [initial, load]);

  async function patch(payload: unknown, successNotice?: (body: Record<string, unknown>) => string) {
    setError("");
    setNotice("");
    setBusy(true);
    try {
      const response = await fetch(`/api/voom/email-flows/${encodeURIComponent(flowId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = await response.json() as Record<string, unknown> & { flow?: EmailFlowView; error?: string; message?: string };
      if (!response.ok) {
        setError(body.error ?? "Voom couldn't apply that change.");
        setBusy(false);
        return;
      }
      if (body.flow) {
        setFlow(body.flow);
        setDrafts(body.flow.steps.map((step) => ({ ...step })));
      }
      setNotice(successNotice ? successNotice(body) : (body.message ?? "Saved."));
      setEditing(false);
      onChanged?.();
    } catch {
      setError("Voom couldn't reach the server. Nothing changed.");
    }
    setBusy(false);
  }

  if (!flow) {
    return (
      <ModalShell wide maxWidth={680}>
        <ModalHead title="Email automation" onClose={close} />
        <ModalBody>
          <p className="text-sm text-text-2">{error || "Loading…"}</p>
        </ModalBody>
        <ModalFoot><Btn variant="ghost" onClick={close}>Close</Btn></ModalFoot>
      </ModalShell>
    );
  }

  const canActivate = flow.status === "draft" || flow.status === "paused";

  return (
    <ModalShell wide maxWidth={720}>
      <ModalHead
        title={flow.name}
        sub={`${flow.trigger.label} · revision ${flow.revision} · ${flow.generationSource === "mara" ? "written by MARA" : "Voom's own copy"}`}
        onClose={close}
      />
      <ModalBody>
        <div className="flex flex-wrap items-center gap-2">
          <Tag tone={STATUS_TONE[flow.status] ?? "t-grey"}>{flow.statusLabel}</Tag>
          {flow.createdBy === "coordinator" && flow.status === "draft" && <Tag tone="t-blue">MARA proposed this</Tag>}
          {flow.needsAttention && flow.attentionReason && <Tag tone="t-amber">Needs attention</Tag>}
          {flow.audience && <Tag tone="t-grey">{flow.audience.name}</Tag>}
        </div>

        {flow.needsAttention && flow.attentionReason && (
          <p className="mt-3 rounded-xl border border-amber/35 bg-amber/10 px-3 py-2 text-xs leading-relaxed text-amber">
            {flow.attentionReason}
          </p>
        )}
        {notice && <p className="mt-3 rounded-xl border border-line bg-surface-2 px-3 py-2 text-xs leading-relaxed text-text-2">{notice}</p>}
        {error && <p role="alert" className="mt-3 text-xs text-red">{error}</p>}

        <div className="mt-4 grid gap-2.5 rounded-xl border border-line bg-surface-2 p-3.5 text-xs leading-relaxed sm:grid-cols-2">
          <Line label="Objective" value={flow.objective} />
          <Line label="Trigger" value={flow.trigger.description} />
          <Line label="Who gets this" value={flow.eligibilityNote} />
          <Line label="Re-entry" value={flow.reentry.label} />
          <Line
            label="Next activity"
            value={flow.nextScheduledAt ? formatLocalDateTime(flow.nextScheduledAt, timeZone) : "Nothing scheduled right now."}
          />
          <Line
            label="Sending window"
            value="Business-hours only, in your business timezone. A wait that lands outside it moves to the next window."
          />
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
          <Count label="Enrolled" value={flow.counts.enrolled} />
          <Count label="In the flow now" value={flow.counts.active} />
          <Count label="Completed" value={flow.counts.completed} />
          <Count label="Scheduled" value={flow.counts.scheduled} />
          <Count label="Provider accepted" value={flow.counts.accepted} />
          <Count label="Delivered" value={flow.counts.delivered} hint="webhook-confirmed" />
          <Count label="Failed" value={flow.counts.failed} />
          <Count label="Skipped" value={flow.counts.skipped} hint="consent or suppression" />
        </div>

        {flow.strategySummary && (
          <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">MARA&apos;s approach</p>
            <p className="mt-1 text-xs leading-relaxed text-text-2">{flow.strategySummary}</p>
          </div>
        )}

        <div className="mt-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-display text-base font-semibold">The sequence</h3>
            {!editing && flow.status !== "archived" && (
              <Btn size="sm" variant="outline" onClick={() => setEditing(true)}>
                <Icon name="edit" size={13} /> Edit content
              </Btn>
            )}
          </div>

          <ol className="mt-3 space-y-3">
            {flow.steps.map((step, index) => {
              const draft = drafts[index] ?? step;
              return (
                <li key={step.position} className="rounded-xl border border-line bg-surface p-3.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="grid h-6 w-6 place-items-center rounded-full border border-line text-[11px] font-semibold">{step.position + 1}</span>
                    <b className="text-sm">{step.title}</b>
                    <Tag tone="t-grey">{step.waitLabel}</Tag>
                    <Tag tone={step.contentSource === "mara" ? "t-blue" : "t-grey"}>
                      {step.contentSource === "mara" ? "MARA" : step.contentSource === "edited" ? "Edited" : "Voom copy"}
                    </Tag>
                  </div>

                  {editing ? (
                    <div className="mt-3 grid gap-2.5">
                      <Input
                        value={draft.subject}
                        maxLength={300}
                        aria-label={`Subject for email ${step.position + 1}`}
                        onChange={(event) => update(drafts, setDrafts, index, { subject: event.target.value })}
                      />
                      <Input
                        value={draft.previewText}
                        maxLength={500}
                        placeholder="Preview text"
                        aria-label={`Preview text for email ${step.position + 1}`}
                        onChange={(event) => update(drafts, setDrafts, index, { previewText: event.target.value })}
                      />
                      <Textarea
                        rows={6}
                        value={draft.body}
                        maxLength={12000}
                        aria-label={`Body for email ${step.position + 1}`}
                        onChange={(event) => update(drafts, setDrafts, index, { body: event.target.value })}
                      />
                      <Input
                        value={draft.cta}
                        maxLength={160}
                        placeholder="Call to action"
                        aria-label={`Call to action for email ${step.position + 1}`}
                        onChange={(event) => update(drafts, setDrafts, index, { cta: event.target.value })}
                      />
                    </div>
                  ) : (
                    <div className="mt-2.5 space-y-1.5 text-xs">
                      <p className="text-text-3">{step.purpose}</p>
                      <p><b className="font-semibold">Subject:</b> {step.subject}</p>
                      {step.previewText && <p className="text-text-3">Preview: {step.previewText}</p>}
                      <pre className={cx("mt-1.5 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg border border-line bg-surface-2 p-2.5 font-sans text-[11.5px] leading-relaxed text-text-2")}>
                        {step.body}
                      </pre>
                      {step.cta && <p><b className="font-semibold">CTA:</b> {step.cta}</p>}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>

          {editing && (
            <div className="mt-3 flex flex-wrap justify-end gap-2">
              <Btn size="sm" variant="ghost" onClick={() => { setEditing(false); setDrafts(flow.steps.map((step) => ({ ...step }))); }}>
                Cancel
              </Btn>
              <Btn
                size="sm"
                variant="primary"
                disabled={busy}
                onClick={() => void patch(
                  { steps: drafts.map((step) => ({
                      position: step.position,
                      subject: step.subject,
                      previewText: step.previewText,
                      body: step.body,
                      cta: step.cta,
                      waitMinutes: step.waitMinutes,
                      ctaUrl: step.ctaUrl,
                    })) },
                  (body) => String(body.message ?? "Saved."),
                )}
              >
                {busy ? "Saving…" : "Save as new revision"}
              </Btn>
            </div>
          )}

          <p className="mt-2.5 text-[11px] leading-relaxed text-text-3">
            Editing writes a new revision. Contacts already in the flow keep the version they enrolled on, and
            anything already sent keeps the copy Voom actually sent — history is never rewritten.
          </p>
        </div>

        {flow.recentActivity.length > 0 && (
          <div className="mt-5">
            <h3 className="font-display text-base font-semibold">Recent activity</h3>
            <ul className="mt-2.5 space-y-1.5">
              {flow.recentActivity.map((event) => (
                <li key={event.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <span className="text-text-2">{event.label}</span>
                  <span className="text-text-3">{formatLocalDateTime(event.at, timeZone)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </ModalBody>

      <ModalFoot>
        {flow.status !== "archived" && (
          <Btn variant="danger" disabled={busy} onClick={() => void patch({ status: "archived" })}>
            Archive
          </Btn>
        )}
        {flow.status === "active" && (
          <Btn variant="outline" disabled={busy} onClick={() => void patch({ status: "paused" })}>
            Pause flow
          </Btn>
        )}
        {canActivate && (
          <Btn
            variant="primary"
            disabled={busy}
            onClick={() => void patch({ status: "active" }, (body) => String(body.message ?? "Flow activated."))}
          >
            {flow.status === "paused" ? "Resume flow" : "Activate flow"}
          </Btn>
        )}
        <Btn variant="ghost" onClick={close}>Close</Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function update(
  drafts: EmailFlowStepView[],
  setDrafts: (value: EmailFlowStepView[]) => void,
  index: number,
  patch: Partial<EmailFlowStepView>,
) {
  const next = drafts.map((step, position) => (position === index ? { ...step, ...patch } : step));
  setDrafts(next);
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-[11px] font-semibold uppercase tracking-wide text-text-3">{label}</p>
      <p className="mt-0.5 text-text-2">{value}</p>
    </div>
  );
}

function Count({ label, value, hint }: { label: string; value: number; hint?: string }) {
  return (
    <div className="rounded-xl border border-line bg-surface-2 px-3 py-2">
      <div className="font-display text-xl leading-none">{value}</div>
      <span className="text-[11px] text-text-3">{label}</span>
      {hint && <span className="block text-[10px] text-text-3/80">{hint}</span>}
    </div>
  );
}
