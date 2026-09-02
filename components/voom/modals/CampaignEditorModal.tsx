"use client";

import { useCallback, useEffect, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import type { AudienceEligibilityPreview, AudienceRecord } from "@/lib/contacts/types";
import type { AudienceSendResults, CampaignDeliveryState, CampaignDeliveryView, CampaignRecord, CampaignStatus } from "@/lib/voom/types";
import { Icon } from "../icons";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "../ui/Modal";
import { Btn, Card, Field, Input, Tag, Textarea } from "../ui/primitives";

type RecipientMode = "single" | "audience";

export function CampaignEditorModal({ kind, campaign }: { kind: "email" | "sms"; campaign?: CampaignRecord | null }) {
  const { close } = useModal();
  const em = kind === "email";
  const [id, setId] = useState<string | null>(campaign?.id ?? null);
  const [name, setName] = useState(campaign?.name ?? (em ? "Untitled email" : "Untitled SMS"));
  const [objective, setObjective] = useState(campaign?.objective ?? "");
  const [audience, setAudience] = useState(campaign?.audience ?? "");
  const [recipientMode, setRecipientMode] = useState<RecipientMode>(campaign?.audience_id ? "audience" : "single");
  const [audienceId, setAudienceId] = useState<string | null>(campaign?.audience_id ?? null);
  const [audienceOptions, setAudienceOptions] = useState<AudienceRecord[]>([]);
  const [audiencePreview, setAudiencePreview] = useState<AudienceEligibilityPreview | null>(null);
  const [lastResults, setLastResults] = useState<AudienceSendResults | null>(null);
  const [subject, setSubject] = useState(campaign?.subject ?? "");
  const [previewText, setPreviewText] = useState(campaign?.preview_text ?? "");
  const [content, setContent] = useState(campaign?.content ?? "");
  const [sendDate, setSendDate] = useState(campaign?.proposed_send_at ? toDateInput(campaign.proposed_send_at) : "");
  const [sendTime, setSendTime] = useState(campaign?.proposed_send_at ? toTimeInput(campaign.proposed_send_at) : "");
  const [status, setStatus] = useState<CampaignStatus>(campaign?.status ?? "draft");
  const [busy, setBusy] = useState(false);
  const [sendBusy, setSendBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [recipientContact, setRecipientContact] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [delivery, setDelivery] = useState<CampaignDeliveryView | null>(null);

  const smsLength = content.length;

  const loadDelivery = useCallback(async () => {
    if (!id) return;
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, { cache: "no-store" });
      const data = await response.json() as { delivery?: CampaignDeliveryView; error?: string };
      if (!response.ok || !data.delivery) return;
      setDelivery(data.delivery);
      setRecipientContact(data.delivery.recipient?.contact ?? "");
      setRecipientName(data.delivery.recipient?.contact_name ?? "");
    } catch {
      setDelivery(null);
    }
  }, [id]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;

    void (async () => {
      try {
        const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, { cache: "no-store" });
        const data = await response.json() as { delivery?: CampaignDeliveryView };
        if (cancelled || !response.ok || !data.delivery) return;
        setDelivery(data.delivery);
        setRecipientContact(data.delivery.recipient?.contact ?? "");
        setRecipientName(data.delivery.recipient?.contact_name ?? "");
      } catch {
        if (!cancelled) setDelivery(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  // The picker lists only the owner's own audiences (enforced server-side).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch("/api/voom/audiences", { cache: "no-store" });
        const data = await response.json() as { audiences?: AudienceRecord[] };
        if (!cancelled && response.ok && data.audiences) setAudienceOptions(data.audiences);
      } catch {
        // The picker stays empty; reopening the modal retries.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Server-computed eligibility preview for the chosen audience. The browser
  // only ever receives masked destinations. The preview is cleared in the
  // change handler (chooseAudience) so no synchronous setState runs here.
  useEffect(() => {
    if (recipientMode !== "audience" || !audienceId) return;
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`/api/voom/audiences/${encodeURIComponent(audienceId)}/eligibility?kind=${kind}`, { cache: "no-store" });
        const data = await response.json() as { preview?: AudienceEligibilityPreview };
        if (!cancelled) setAudiencePreview(response.ok ? data.preview ?? null : null);
      } catch {
        if (!cancelled) setAudiencePreview(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [recipientMode, audienceId, kind]);

  function chooseAudience(nextId: string | null) {
    setAudienceId(nextId);
    // Drop the previous preview immediately; the effect below refetches.
    setAudiencePreview(null);
    setLastResults(null);
    const chosen = audienceOptions.find((option) => option.id === nextId);
    if (chosen) setAudience(chosen.name);
  }

  function payload() {
    return {
      name: name.trim() || (em ? "Untitled email" : "Untitled SMS"),
      objective: objective.trim(),
      audience: audience.trim(),
      audienceId: recipientMode === "audience" ? audienceId : null,
      subject: em ? subject.trim() || null : null,
      previewText: em ? previewText.trim() || null : null,
      content: content.trim(),
      proposedSendAt: composeSendAt(sendDate, sendTime),
    };
  }

  async function saveDraft() {
    if (recipientMode === "audience" && !audienceId) {
      setError("Choose an audience (or switch back to a single recipient) before saving this draft.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      // The campaign kind is fixed at creation. PATCH only edits draft content,
      // so it must not send kind (PATCH rejects unknown keys); POST still needs it.
      const body = id ? payload() : { kind, ...payload() };
      const headers = { "Content-Type": "application/json" };
      const response = id
        ? await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}`, { method: "PATCH", headers, body: JSON.stringify(body) })
        : await fetch("/api/voom/campaigns", { method: "POST", headers, body: JSON.stringify(body) });
      const data = await response.json() as { campaign?: CampaignRecord; error?: string };
      if (!response.ok || !data.campaign) {
        setError(data.error ?? "Voom couldn't save that draft. Please retry.");
        return;
      }
      setId(data.campaign.id);
      setStatus(data.campaign.status);
      setRecipientMode(data.campaign.audience_id ? "audience" : "single");
      setAudienceId(data.campaign.audience_id ?? null);
      if (data.campaign.status !== "approved") {
        setDelivery(null);
      } else {
        await loadDelivery();
      }
      setMessage("Draft saved in Voom. Nothing has been sent.");
      window.dispatchEvent(new Event("voom:data-changed"));
    } catch {
      setError("Voom couldn't save that draft. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function markStatus(action: "approve" | "reject") {
    if (!id) {
      setError("Save the draft before approving or rejecting it.");
      return;
    }
    setBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const data = await response.json() as { campaign?: CampaignRecord; message?: string; error?: string };
      if (!response.ok || !data.campaign) {
        setError(data.error ?? "Voom couldn't update that campaign. Please retry.");
        return;
      }
      setStatus(data.campaign.status);
      setMessage(data.message ?? (action === "approve" ? "Campaign approved. Nothing has been sent." : "Campaign marked not approved."));
      window.dispatchEvent(new Event("voom:data-changed"));
      await loadDelivery();
    } catch {
      setError("Voom couldn't update that campaign. Please retry.");
    } finally {
      setBusy(false);
    }
  }

  async function sendApprovedCampaign() {
    if (!id) {
      setError("Save and approve the campaign before sending it.");
      return;
    }
    setSendBusy(true);
    setError("");
    setMessage("");
    try {
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contact: recipientContact, contactName: recipientName }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      if (!response.ok) {
        setError(data.error ?? "Voom couldn't send that campaign safely.");
        return;
      }
      setMessage(data.message ?? `${em ? "Email" : "SMS"} accepted by the provider.`);
      window.dispatchEvent(new Event("voom:data-changed"));
      await loadDelivery();
    } catch {
      setError("Voom couldn't send that campaign safely. Nothing was simulated.");
    } finally {
      setSendBusy(false);
    }
  }

  async function sendApprovedCampaignToAudience() {
    if (!id) {
      setError("Save and approve the campaign before sending it.");
      return;
    }
    if (!audienceId) {
      setError("Choose an audience before sending.");
      return;
    }
    setSendBusy(true);
    setError("");
    setMessage("");
    try {
      // Only an explicit confirmation is posted — the server re-resolves the
      // linked audience itself; no recipient list ever leaves the browser.
      const response = await fetch(`/api/voom/campaigns/${encodeURIComponent(id)}/delivery`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audienceSend: true }),
      });
      const data = await response.json() as { delivery?: CampaignDeliveryView; results?: AudienceSendResults; message?: string; error?: string };
      if (data.delivery) setDelivery(data.delivery);
      setLastResults(data.results ?? null);
      if (!response.ok) {
        setError(data.error ?? "Voom couldn't send that campaign safely.");
        return;
      }
      setMessage(data.message ?? "The audience send finished.");
      window.dispatchEvent(new Event("voom:data-changed"));
      await loadDelivery();
    } catch {
      setError("Voom couldn't send that campaign safely. Nothing was simulated.");
    } finally {
      setSendBusy(false);
    }
  }

  const deliveryState = delivery?.state ?? (status === "approved" ? "ready" : null);
  const selectClass = "h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]";

  return (
    <ModalShell wide>
      <ModalHead
        title={em ? "Email campaign" : "SMS campaign"}
        sub={id ? "Saved in Voom · refresh-safe" : "New draft — saved in Voom"}
        onClose={close}
      />
      <ModalBody>
        <div className="mb-4 flex flex-wrap items-center gap-2">
          <Tag tone={statusTone(status)}>{statusLabel(status)}</Tag>
          {status === "approved" && deliveryState && (
            <Tag tone={deliveryTone(deliveryState)}>
              <Icon name="send" size={12} /> {deliveryLabel(deliveryState)}
            </Tag>
          )}
        </div>

        {message && <div role="status" className="mb-3.5 rounded-xl border border-green/35 bg-green/10 px-3.5 py-2.5 text-sm text-green">{message}</div>}
        {error && <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">{error}</div>}

        <Field label="Campaign name">
          <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={160} placeholder={em ? "e.g. Tuesday newsletter" : "e.g. Restock heads-up"} />
        </Field>
        <Field label={em ? "Objective" : "Purpose"} hint="Why Voom prepared this for you.">
          <Textarea rows={2} maxLength={1000} value={objective} onChange={(e) => setObjective(e.target.value)} placeholder={em ? "Re-engage cold subscribers before the weekend." : "Tell regulars about the restock in one short message."} />
        </Field>

        <Field label="Send to">
          <div className="flex w-fit gap-1 rounded-[13px] border border-line bg-surface-2 p-1">
            <button
              type="button"
              onClick={() => setRecipientMode("single")}
              className={`rounded-[10px] px-4 py-2 text-[13.5px] font-semibold transition ${recipientMode === "single" ? "bg-surface text-text shadow-[var(--shadow)]" : "text-text-2"}`}
            >Single recipient</button>
            <button
              type="button"
              onClick={() => setRecipientMode("audience")}
              className={`rounded-[10px] px-4 py-2 text-[13.5px] font-semibold transition ${recipientMode === "audience" ? "bg-surface text-text shadow-[var(--shadow)]" : "text-text-2"}`}
            >Audience</button>
          </div>
        </Field>

        {recipientMode === "single" ? (
          <Field label="Audience">
            <Input value={audience} onChange={(e) => setAudience(e.target.value)} maxLength={1000} placeholder="e.g. All subscribers · segment not connected" />
          </Field>
        ) : (
          <>
            <Field label="Audience" hint="Sent only to eligible, subscribed contacts — the audience is re-resolved on the server at send time, never from this browser.">
              <select className={selectClass} value={audienceId ?? ""} onChange={(e) => chooseAudience(e.target.value || null)}>
                <option value="">Choose an audience…</option>
                {audienceOptions.map((option) => (
                  <option key={option.id} value={option.id}>{option.name}</option>
                ))}
              </select>
            </Field>

            {audienceId && (
              <Card className="mb-3.5 border-line-2 bg-surface-2 p-3.5">
                {!audiencePreview ? (
                  <p className="text-[13px] text-text-3">Checking eligibility on the server…</p>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2">
                      <Tag tone={audiencePreview.eligibleCount > 0 ? "t-green" : "t-amber"}>
                        {audiencePreview.eligibleCount} eligible {em ? "email" : "SMS"} destination{audiencePreview.eligibleCount === 1 ? "" : "s"}
                      </Tag>
                      <Tag>{audiencePreview.totalMembers} contacts in audience</Tag>
                    </div>
                    <p className="mt-2 text-[12.5px] leading-[1.55] text-text-2">
                      Excluded: {audiencePreview.excludedCount} unsubscribed, unknown or missing a valid {em ? "email address" : "phone number"}
                      {audiencePreview.duplicateCount > 0 ? ` · ${audiencePreview.duplicateCount} duplicate destination${audiencePreview.duplicateCount === 1 ? "" : "s"} removed` : ""}.
                    </p>
                    {audiencePreview.overLimitCount > 0 && (
                      <p className="mt-2 text-[12.5px] font-semibold text-amber">
                        Over the {audiencePreview.sendCap}-recipient limit per send — the send is refused entirely while this audience has more than {audiencePreview.sendCap} eligible destinations ({audiencePreview.overLimitCount} too many). Narrow the audience in Contacts, then try again.
                      </p>
                    )}
                    {audiencePreview.recipients.length > 0 && (
                      <ul className="mt-2 space-y-1 font-mono text-[11.5px] text-text-3">
                        {audiencePreview.recipients.slice(0, 8).map((r) => (
                          <li key={r.contactId}>{r.contactName ? `${r.contactName} · ` : ""}{r.destination}</li>
                        ))}
                        {audiencePreview.recipients.length > 8 && <li>+ {audiencePreview.recipients.length - 8} more…</li>}
                      </ul>
                    )}
                  </>
                )}
              </Card>
            )}
          </>
        )}

        {em ? (
          <>
            <Field label="Subject line">
              <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={300} placeholder="What shows up in the inbox" />
            </Field>
            <Field label="Preview text">
              <Input value={previewText} onChange={(e) => setPreviewText(e.target.value)} maxLength={500} placeholder="The line under the subject" />
            </Field>
            <Field label="Body / content">
              <Textarea rows={7} maxLength={12000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="Write the email content here, or review what MARA's weekly plan prepared." />
            </Field>
          </>
        ) : (
          <Field label="Message" hint={`${smsLength} characters · ${Math.max(1, Math.ceil(Math.max(1, smsLength) / 160))} SMS segment${Math.ceil(Math.max(1, smsLength) / 160) === 1 ? "" : "s"} (cost depends on the connected provider)`}>
            <Textarea rows={6} maxLength={12000} value={content} onChange={(e) => setContent(e.target.value)} placeholder="One short, useful message." />
          </Field>
        )}

        <div className="flex flex-wrap gap-2.5">
          <div className="min-w-[180px] flex-1">
            <Field label="Proposed date">
              <Input type="date" value={sendDate} onChange={(e) => setSendDate(e.target.value)} />
            </Field>
          </div>
          <div className="min-w-[150px] flex-1">
            <Field label="Proposed time">
              <Input type="time" value={sendTime} onChange={(e) => setSendTime(e.target.value)} />
            </Field>
          </div>
        </div>

        {status === "approved" && recipientMode === "single" && (
          <Card className="mb-3.5 border-line-2 bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={deliveryState ? deliveryTone(deliveryState) : "t-grey"}>{deliveryState ? deliveryLabel(deliveryState) : "Ready"}</Tag>
              <Tag tone={delivery?.provider.configured ? "t-green" : "t-amber"}>{delivery?.provider.label ?? (em ? "Resend" : "ClickSend")}</Tag>
            </div>
            <p className="mt-2 text-[13px] leading-[1.55] text-text-2">
              {delivery?.note ?? "This approved campaign can send to one real recipient when the provider is configured."}
            </p>
            <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
              <Field label={em ? "Recipient email" : "Recipient phone number"} hint={em ? "One recipient for this MVP." : "Use E.164 format like +971501234567. One recipient for this MVP."}>
                <Input value={recipientContact} onChange={(e) => setRecipientContact(e.target.value)} placeholder={em ? "customer@example.com" : "+971501234567"} />
              </Field>
              <Field label="Recipient name (optional)">
                <Input value={recipientName} onChange={(e) => setRecipientName(e.target.value)} maxLength={200} placeholder="e.g. Sara" />
              </Field>
            </div>
            {delivery?.send?.provider_message_id ? (
              <p className="mt-2 text-xs text-text-3">Provider message ID: {delivery.send.provider_message_id}</p>
            ) : null}
            {delivery?.send?.last_error_message ? (
              <p className="mt-2 text-xs text-red">Last provider error: {delivery.send.last_error_message}</p>
            ) : null}
          </Card>
        )}

        {status === "approved" && recipientMode === "audience" && (
          <Card className="mb-3.5 border-line-2 bg-surface-2 p-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <Tag tone={deliveryState ? deliveryTone(deliveryState) : "t-grey"}>{deliveryState ? deliveryLabel(deliveryState) : "Ready"}</Tag>
              <Tag tone={delivery?.provider.configured ? "t-green" : "t-amber"}>{delivery?.provider.label ?? (em ? "Resend" : "ClickSend")}</Tag>
            </div>
            <p className="mt-2 text-[13px] leading-[1.55] text-text-2">
              {delivery?.note ?? "This approved campaign can send to its linked audience when the provider is configured. The audience is re-resolved on the server at send time."}
            </p>
            {delivery?.audience && (
              <p className="mt-2 text-[12.5px] text-text-2">
                {delivery.audience.audience.name}: {delivery.audience.eligibleCount} eligible of {delivery.audience.totalMembers} contacts
                {delivery.audience.overLimitCount > 0 ? ` · ${delivery.audience.overLimitCount} over the ${delivery.audience.sendCap} per-send limit — send blocked until the audience is narrowed` : ""}.
              </p>
            )}
            {delivery && delivery.sendsSummary.total > 0 && (
              <p className="mt-2 text-[12.5px] text-text-2">
                Recorded sends: {delivery.sendsSummary.accepted} accepted · {delivery.sendsSummary.delivered} delivered · {delivery.sendsSummary.failed} failed · {delivery.sendsSummary.sending} in progress. Successful recipients are never resent.
              </p>
            )}
            {lastResults && (
              <div className="mt-2.5 rounded-xl border border-line p-2.5">
                <p className="text-[12.5px] font-semibold text-text-2">
                  Last run: {lastResults.accepted} accepted · {lastResults.failed} failed · {lastResults.skipped} skipped{lastResults.overLimit > 0 ? ` · ${lastResults.overLimit} over the per-send limit of ${lastResults.cap}` : ""}
                </p>
                <ul className="mt-1.5 max-h-40 space-y-1 overflow-y-auto font-mono text-[11.5px] text-text-3">
                  {lastResults.recipients.map((r, index) => (
                    <li key={`${r.destination}-${index}`}>{r.destination} — {r.status}{r.detail ? ` (${r.detail})` : ""}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        )}

        <Card className="border-amber bg-amber/[.08] p-3.5">
          <div className="flex items-start gap-2.5">
            <Icon name="warn" className="mt-0.5 flex-none text-amber" />
            <p className="text-[13px] leading-[1.55] text-text-2">
              Saving and approving stay inside Voom. Only the explicit Send action can contact a real recipient.
              Voom will never mark it <b>Delivered</b> until a verified provider callback confirms real delivery.
            </p>
          </div>
        </Card>
      </ModalBody>
      <ModalFoot className="justify-between">
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        <div className="flex flex-wrap gap-2.5">
          {status === "approved" ? (
            recipientMode === "audience" ? (
              <Btn
                variant="outline"
                // The server refuses an over-cap audience send entirely; the
                // button stays disabled so the UI blocks it too.
                disabled={busy || sendBusy || !id || !delivery?.canSend}
                onClick={() => void sendApprovedCampaignToAudience()}
                title={
                  delivery?.audience && delivery.audience.overLimitCount > 0
                    ? `Sending is refused while more than ${delivery.audience.sendCap} destinations are eligible — narrow the audience first`
                    : !delivery?.provider.configured
                      ? `${delivery?.provider.label ?? (em ? "Resend" : "ClickSend")} is not configured on the server yet`
                      : undefined
                }
              >
                <Icon name="send" size={14} /> {sendBusy ? "Sending…" : `Send approved ${em ? "email" : "SMS"} to audience`}
              </Btn>
            ) : (
              <Btn
                variant="outline"
                disabled={busy || sendBusy || !id || !recipientContact.trim() || !delivery?.canSend}
                onClick={() => void sendApprovedCampaign()}
                title={!delivery?.provider.configured ? `${delivery?.provider.label ?? (em ? "Resend" : "ClickSend")} is not configured on the server yet` : undefined}
              >
                <Icon name="send" size={14} /> {sendBusy ? "Sending…" : delivery?.send?.internal_status === "failed" ? `Retry ${em ? "email" : "SMS"}` : `Send approved ${em ? "email" : "SMS"}`}
              </Btn>
            )
          ) : (
            <Btn variant="outline" disabled={busy} onClick={() => void markStatus("approve")}>
              Approve for send
            </Btn>
          )}
          <Btn variant="primary" disabled={busy || sendBusy} onClick={() => void saveDraft()}>
            <Icon name="edit" size={14} /> {busy ? "Saving…" : "Save draft"}
          </Btn>
        </div>
      </ModalFoot>
    </ModalShell>
  );
}

function statusTone(status: CampaignStatus) {
  return status === "approved" ? "t-green" : status === "rejected" ? "t-red" : "t-grey";
}

function statusLabel(status: CampaignStatus) {
  if (status === "approved") return "Approved — ready to send";
  if (status === "rejected") return "Not approved";
  return "Draft";
}

function deliveryTone(status: CampaignDeliveryState) {
  return status === "delivered" ? "t-green" : status === "accepted" ? "t-blue" : status === "failed" ? "t-red" : status === "sending" ? "t-amber" : "t-grey";
}

function deliveryLabel(status: CampaignDeliveryState) {
  if (status === "delivered") return "Delivered";
  if (status === "accepted") return "Accepted by provider";
  if (status === "failed") return "Failed";
  if (status === "sending") return "Sending";
  return "Ready";
}

function toDateInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function toTimeInput(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function composeSendAt(date: string, time: string): string | null {
  if (!date) return null;
  const value = new Date(time ? `${date}T${time}` : `${date}T00:00`);
  if (Number.isNaN(value.getTime())) return null;
  return value.toISOString();
}
