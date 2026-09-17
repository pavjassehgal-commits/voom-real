"use client";

import { useEffect, useState } from "react";

import { useModal } from "@/lib/voom/modal";
import type { AudienceRecord } from "@/lib/contacts/types";
import type { EmailFlowType } from "@/lib/email-flows/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Field, Input, Tag, cx } from "../ui/primitives";

interface FlowChoice {
  type: EmailFlowType;
  label: string;
  description: string;
  trigger: string;
}

/**
 * "What should Voom automate?" — the whole builder.
 *
 * Two choices and a handful of controls. Step counts, delays, consent rules and
 * re-entry behaviour all come from Voom's deterministic policy layer, so there
 * is no node graph and no way to build an unsafe sequence here.
 */
const CHOICES: FlowChoice[] = [
  {
    type: "welcome",
    label: "Welcome new customers",
    description: "A short sequence for people who have just subscribed to your email.",
    trigger: "When a contact becomes newly eligible",
  },
  {
    type: "re_engagement",
    label: "Re-engage inactive customers",
    description: "A short sequence for subscribers Voom has not emailed in a while.",
    trigger: "When an eligible contact has been inactive",
  },
];

const WELCOME_COUNTS = [2, 3, 4, 5];
const INACTIVITY_OPTIONS = [14, 30, 45, 60, 90];
const COOLDOWN_OPTIONS = [30, 60, 90, 180];

export function CreateEmailFlowModal({ onCreated }: { onCreated?: (flowId: string) => void }) {
  const { close } = useModal();
  const [flowType, setFlowType] = useState<EmailFlowType | null>(null);
  const [name, setName] = useState("");
  const [audienceId, setAudienceId] = useState("");
  const [audiences, setAudiences] = useState<AudienceRecord[]>([]);
  const [stepCount, setStepCount] = useState(3);
  const [inactivityDays, setInactivityDays] = useState(45);
  const [cooldownDays, setCooldownDays] = useState(90);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/voom/audiences", { cache: "no-store" });
        const data = await response.json() as { audiences?: AudienceRecord[] };
        if (!cancelled && response.ok && data.audiences) setAudiences(data.audiences);
      } catch {
        // The audience picker stays optional and empty.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const choice = CHOICES.find((item) => item.type === flowType);

  async function create() {
    if (!flowType) return;
    setError("");
    setBusy(true);
    try {
      const response = await fetch("/api/voom/email-flows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          flowType,
          name: name.trim() || undefined,
          audienceId: audienceId || null,
          stepCount: flowType === "welcome" ? stepCount : null,
          inactivityDays: flowType === "re_engagement" ? inactivityDays : null,
          cooldownDays: flowType === "re_engagement" ? cooldownDays : null,
          // A double-clicked Create cannot build two flows.
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await response.json() as { flowId?: string; error?: string };
      if (!response.ok || !body.flowId) {
        setError(body.error ?? "Voom couldn't create that flow.");
        setBusy(false);
        return;
      }
      onCreated?.(body.flowId);
      close();
    } catch {
      setError("Voom couldn't reach the server. Nothing was created.");
      setBusy(false);
    }
  }

  return (
    <ModalShell wide maxWidth={620}>
      <ModalHead
        title="Create an email automation"
        sub="An ongoing rule, not a campaign: it keeps running for as long as it is active."
        onClose={close}
      />
      <ModalBody>
        {!choice && (
          <>
            <p className="text-sm font-semibold">What should Voom automate?</p>
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {CHOICES.map((item) => (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => setFlowType(item.type)}
                  className="rounded-xl border border-line bg-surface-2 p-4 text-left transition hover:border-brand"
                >
                  <span className="font-display text-[15px] font-semibold">{item.label}</span>
                  <p className="mt-1 text-xs leading-relaxed text-text-2">{item.description}</p>
                  <p className="mt-2 inline-flex items-center gap-1.5 text-[11.5px] text-text-3">
                    <Icon name="bolt" size={12} /> {item.trigger}
                  </p>
                </button>
              ))}
            </div>
            <p className="mt-4 text-xs leading-relaxed text-text-3">
              Voom only automates what it can actually observe. Cart and purchase flows are not offered
              because Voom has no commerce events to react to.
            </p>
          </>
        )}

        {choice && (
          <>
            <button
              type="button"
              onClick={() => setFlowType(null)}
              className="inline-flex items-center gap-1.5 text-xs font-semibold text-text-3 hover:text-text"
            >
              <Icon name="arrow" size={12} /> Change what to automate
            </button>

            <div className="mt-3 rounded-xl border border-line bg-surface-2 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <b className="font-display text-[15px]">{choice.label}</b>
                <Tag tone="t-blue">{choice.trigger}</Tag>
              </div>
              <p className="mt-1.5 text-xs leading-relaxed text-text-2">{choice.description}</p>
            </div>

            <div className="mt-4 grid gap-3.5">
              <Field label="Flow name" hint="Optional — Voom suggests one.">
                <Input
                  value={name}
                  maxLength={160}
                  placeholder={choice.type === "welcome" ? "Welcome flow" : "Re-engagement flow"}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>

              <Field label="Who is eligible" hint="Leave on all subscribers unless you want a narrower group.">
                <select
                  value={audienceId}
                  onChange={(event) => setAudienceId(event.target.value)}
                  className="h-[42px] w-full rounded-[11px] border border-line bg-surface px-3 text-sm"
                >
                  <option value="">Everyone subscribed to marketing email</option>
                  {audiences.map((audience) => (
                    <option key={audience.id} value={audience.id}>{audience.name}</option>
                  ))}
                </select>
              </Field>

              {choice.type === "welcome" && (
                <Field label="How many emails" hint="Between 2 and 5. Voom sets the delays.">
                  <Segmented
                    options={WELCOME_COUNTS.map((value) => ({ value: String(value), label: String(value) }))}
                    value={String(stepCount)}
                    onChange={(value) => setStepCount(Number(value))}
                  />
                </Field>
              )}

              {choice.type === "re_engagement" && (
                <>
                  <Field label="Inactive for" hint="How long Voom must not have emailed them.">
                    <Segmented
                      options={INACTIVITY_OPTIONS.map((value) => ({ value: String(value), label: `${value}d` }))}
                      value={String(inactivityDays)}
                      onChange={(value) => setInactivityDays(Number(value))}
                    />
                  </Field>
                  <Field label="Re-entry cooldown" hint="How long before the same contact can enter again.">
                    <Segmented
                      options={COOLDOWN_OPTIONS.map((value) => ({ value: String(value), label: `${value}d` }))}
                      value={String(cooldownDays)}
                      onChange={(value) => setCooldownDays(Number(value))}
                    />
                  </Field>
                </>
              )}
            </div>

            <div className="mt-4 rounded-xl border border-line bg-surface-2 p-3.5 text-xs leading-relaxed text-text-2">
              <p>
                MARA writes the emails inside Voom&apos;s limits — how many, how long the waits are and what
                may be claimed are fixed by Voom, not by the model.
              </p>
              <p className="mt-1.5">
                <b className="font-semibold">Nothing is sent now.</b> The flow is created as a draft, and
                contacts only enroll once you activate it. Consent is checked again before every send.
              </p>
            </div>

            {error && <p role="alert" className="mt-3 text-xs text-red">{error}</p>}
          </>
        )}
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>Cancel</Btn>
        <Btn variant="primary" disabled={!choice || busy} onClick={() => void create()}>
          {busy ? "MARA is writing…" : "Create draft flow"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function Segmented({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: string; label: string }>;
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <div role="group" className="flex flex-wrap gap-1 rounded-xl border border-line bg-surface-2 p-1">
      {options.map((option) => (
        <Btn
          key={option.value}
          size="sm"
          variant={value === option.value ? "primary" : "plain"}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cx("px-2.5", value !== option.value && "text-text-2")}
        >
          {option.label}
        </Btn>
      ))}
    </div>
  );
}
