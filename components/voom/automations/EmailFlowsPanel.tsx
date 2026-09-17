"use client";

import { useCallback, useEffect, useState } from "react";

import { useModal } from "@/lib/voom/modal";
import type { EmailFlowSummary, EmailFlowView } from "@/lib/email-flows/types";
import { formatLocalDateTime } from "@/lib/voom/timezone";
import { CreateEmailFlowModal } from "../modals/CreateEmailFlowModal";
import { EmailFlowModal } from "../modals/EmailFlowModal";
import { Icon } from "../icons";
import { Btn, Card, EmptyState, Tag } from "../ui/primitives";

const STATUS_TONE: Record<string, string> = {
  active: "t-green",
  paused: "t-amber",
  draft: "t-blue",
  archived: "t-grey",
};

const FLOW_LABEL: Record<string, string> = {
  welcome: "Welcome",
  re_engagement: "Re-engagement",
};

interface FlowsResponse {
  flows?: EmailFlowView[];
  summary?: EmailFlowSummary;
  schemaReady?: boolean;
  error?: string;
}

/**
 * The Automations page's "active automations" section.
 *
 * This is ongoing lifecycle behaviour, and it is kept visibly separate from
 * both the automation mode above it and from Campaigns: a campaign is a finite
 * mission with an end date, a flow is a rule that keeps running.
 */
export function EmailFlowsPanel({ timeZone = "Asia/Dubai" }: { timeZone?: string }) {
  const { open } = useModal();
  const [flows, setFlows] = useState<EmailFlowView[]>([]);
  const [summary, setSummary] = useState<EmailFlowSummary | null>(null);
  const [schemaReady, setSchemaReady] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/email-flows", { cache: "no-store" });
      const body = await response.json() as FlowsResponse;
      if (!response.ok) throw new Error(body.error ?? "Your email automations couldn't load.");
      setFlows(body.flows ?? []);
      setSummary(body.summary ?? null);
      setSchemaReady(body.schemaReady !== false);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Your email automations couldn't load.");
    }
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(), 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  function openCreator() {
    open(<CreateEmailFlowModal onCreated={(flowId) => {
      void (async () => {
        await load();
        open(<EmailFlowModal flowId={flowId} timeZone={timeZone} onChanged={() => void load()} />);
      })();
    }} />);
  }

  function openFlow(flow: EmailFlowView) {
    open(<EmailFlowModal flowId={flow.id} initial={flow} timeZone={timeZone} onChanged={() => void load()} />);
  }

  return (
    <Card className="mt-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="font-display text-lg font-semibold">Active automations</h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-text-2">
            Ongoing lifecycle email. A flow keeps running for as long as it is active — unlike a campaign, it has
            no end date.
          </p>
        </div>
        <Btn variant="primary" size="sm" onClick={openCreator}>
          <Icon name="plus" size={14} /> Create flow
        </Btn>
      </div>

      {summary && summary.total > 0 && (
        <div className="mt-3 flex flex-wrap gap-2 text-[11.5px] text-text-3">
          <span className="rounded-[7px] border border-line bg-surface-2 px-2.5 py-[3px]">{summary.active} active</span>
          <span className="rounded-[7px] border border-line bg-surface-2 px-2.5 py-[3px]">{summary.paused} paused</span>
          <span className="rounded-[7px] border border-line bg-surface-2 px-2.5 py-[3px]">{summary.draft} draft</span>
          <span className="rounded-[7px] border border-line bg-surface-2 px-2.5 py-[3px]">{summary.enrolledContacts} contacts enrolled</span>
          <span className="rounded-[7px] border border-line bg-surface-2 px-2.5 py-[3px]">{summary.scheduledRuns} emails scheduled</span>
        </div>
      )}

      {error && <p role="alert" className="mt-3 text-xs text-red">{error}</p>}

      {!schemaReady && !error && (
        <p className="mt-3 text-xs leading-relaxed text-text-3">
          Email automation needs the 0040 migration to be applied before Voom can show your flows.
        </p>
      )}

      {flows.length === 0 && schemaReady && !error && (
        <div className="mt-4">
          <EmptyState
            icon="mail"
            title="No lifecycle flows yet"
            reason="Create a Welcome flow and every new subscriber is greeted automatically, or a Re-engagement flow for subscribers Voom has not emailed in a while. Consent is checked before every send, and nothing goes out until you activate the flow."
          />
        </div>
      )}

      {flows.length > 0 && (
        <ul className="mt-4 grid gap-3 md:grid-cols-2">
          {flows.map((flow) => (
            <li key={flow.id}>
              <button
                type="button"
                onClick={() => openFlow(flow)}
                className="w-full rounded-xl border border-line bg-surface-2 p-4 text-left transition hover:border-brand"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <b className="font-display text-[15px]">{flow.name}</b>
                  <Tag tone={STATUS_TONE[flow.status] ?? "t-grey"}>{flow.statusLabel}</Tag>
                  <Tag tone="t-grey">{FLOW_LABEL[flow.flowType] ?? flow.flowType}</Tag>
                </div>

                <p className="mt-1.5 text-xs leading-relaxed text-text-3">{flow.objective}</p>

                <dl className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1.5 text-[11.5px]">
                  <div>
                    <dt className="text-text-3">Contacts enrolled</dt>
                    <dd className="font-semibold">{flow.counts.enrolled}</dd>
                  </div>
                  <div>
                    <dt className="text-text-3">In the flow now</dt>
                    <dd className="font-semibold">{flow.counts.active}</dd>
                  </div>
                  <div>
                    <dt className="text-text-3">Next scheduled activity</dt>
                    <dd className="font-semibold">
                      {flow.nextScheduledAt ? formatLocalDateTime(flow.nextScheduledAt, timeZone) : "Nothing scheduled"}
                    </dd>
                  </div>
                  <div>
                    <dt className="text-text-3">Delivered</dt>
                    <dd className="font-semibold">{flow.counts.delivered}</dd>
                  </div>
                </dl>

                {flow.needsAttention && flow.attentionReason && (
                  <p className="mt-2.5 flex items-start gap-1.5 rounded-lg border border-amber/35 bg-amber/10 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-amber">
                    <Icon name="warn" size={12} className="mt-[2px] flex-none" />
                    <span>{flow.attentionReason}</span>
                  </p>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}

      <p className="mt-4 text-[11px] leading-relaxed text-text-3">
        Pausing a flow stops future sends without deleting anything that already happened. Voom never burst-sends a
        pile of overdue emails after a resume — due steps are recalculated into the next business-hours windows.
      </p>
    </Card>
  );
}
