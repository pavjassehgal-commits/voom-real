"use client";

import { useMemo, useState } from "react";
import { useModal } from "@/lib/voom/modal";
import { useVoomActions } from "@/lib/voom/store";
import { Icon } from "@/components/voom/icons";
import { Btn, Field, Input, Textarea, Tag, Chip } from "@/components/voom/ui/primitives";
import { ModalBody, ModalFoot, ModalHead, ModalShell } from "@/components/voom/ui/Modal";
import type { ConsentStatus, ContactRecord, AudienceRecord } from "@/lib/contacts/types";
import {
  buildImportPlan,
  validateCsvUpload,
  MAX_CSV_BYTES,
} from "@/lib/contacts/csv";
import {
  createContactAction,
  updateContactAction,
  createAudienceAction,
  importContactsAction,
  deleteContactAction,
  deleteAudienceAction,
} from "@/app/app/(shell)/contacts/actions";

// ─── Add / Edit Contact Modal ──────────────────────────────────────────────

type Consent = ConsentStatus | "default";

export function ContactEditorModal({
  mode,
  contact,
  onDone,
}: {
  mode: "create" | "edit";
  contact?: ContactRecord;
  onDone: () => void;
}) {
  return (
    <ContactEditorBody
      key={contact?.id ?? "new"}
      mode={mode}
      contact={contact}
      onDone={onDone}
    />
  );
}

function ContactEditorBody({
  mode,
  contact,
  onDone,
}: {
  mode: "create" | "edit";
  contact?: ContactRecord;
  onDone: () => void;
}) {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const isEdit = mode === "edit" && Boolean(contact);

  const [firstName, setFirstName] = useState(contact?.first_name ?? "");
  const [lastName, setLastName] = useState(contact?.last_name ?? "");
  const [email, setEmail] = useState(contact?.email ?? "");
  const [phone, setPhone] = useState(contact?.phone ?? "");
  const [tagsText, setTagsText] = useState((contact?.tags ?? []).join(", "));
  const [emailConsent, setEmailConsent] = useState<Consent>(contact?.email_status ?? "default");
  const [smsConsent, setSmsConsent] = useState<Consent>(contact?.sms_status ?? "default");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    if (!email.trim() && !phone.trim()) {
      setError("Add an email or a phone number.");
      return;
    }
    if (email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      setError("Email is not valid.");
      return;
    }
    if (phone.trim() && !/^\+[1-9][0-9]{7,14}$/.test(phone.trim())) {
      setError("Phone must be in E.164 format (e.g. +14155551234).");
      return;
    }

    const tags = tagsText
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    setBusy(true);
    const res = isEdit && contact
      ? await updateContactAction(contact.id, {
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          email_status: emailConsent === "default" ? undefined : emailConsent,
          sms_status: smsConsent === "default" ? undefined : smsConsent,
          tags,
        })
      : await createContactAction({
          first_name: firstName.trim() || null,
          last_name: lastName.trim() || null,
          email: email.trim().toLowerCase() || null,
          phone: phone.trim() || null,
          email_status: emailConsent,
          sms_status: smsConsent,
          tags,
        });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast(isEdit ? "Contact updated" : "Contact added to your workspace", "ok");
    onDone();
    close();
  }

  return (
    <ModalShell wide>
      <ModalHead
        title={isEdit ? "Edit contact" : "Add contact"}
        sub="Voom never infers consent — defaults to Unknown unless you confirm. Real email or SMS is never sent from here."
        onClose={close}
      />
      <ModalBody>
        {error && (
          <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
            {error}
          </div>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="First name">
            <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Alice" />
          </Field>
          <Field label="Last name">
            <Input value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Doe" />
          </Field>
          <Field label="Email" hint="Lowercased and trimmed on save.">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="alice@example.com"
            />
          </Field>
          <Field label="Phone" hint="E.164 with country code, e.g. +14155551234.">
            <Input
              type="tel"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="+14155551234"
            />
          </Field>
        </div>
        <Field label="Tags" hint="Comma-separated, e.g. vip, launch, dubai.">
          <Input value={tagsText} onChange={(e) => setTagsText(e.target.value)} placeholder="vip, launch" />
        </Field>

        <div className="mt-1 grid gap-3.5 sm:grid-cols-2">
          <ConsentField
            label="Email consent"
            value={emailConsent}
            disabled={!email.trim()}
            onChange={setEmailConsent}
          />
          <ConsentField
            label="SMS consent"
            value={smsConsent}
            disabled={!phone.trim()}
            onChange={setSmsConsent}
          />
        </div>
      </ModalBody>
      <ModalFoot>
        <Btn variant="ghost" onClick={close}>
          Cancel
        </Btn>
        {isEdit && contact && (
          <Btn
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Delete this contact? This cannot be undone.")) return;
              setBusy(true);
              const res = await deleteContactAction(contact.id);
              setBusy(false);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              toast("Contact removed", "info");
              onDone();
              close();
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </Btn>
        )}
        <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
          <Icon name="check" size={14} /> {busy ? "Saving…" : isEdit ? "Save changes" : "Add contact"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}

function ConsentField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: Consent;
  disabled: boolean;
  onChange: (v: Consent) => void;
}) {
  return (
    <div>
      <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {([
          ["default", "Unknown (default)"],
          ["subscribed", "Subscribed"],
          ["unsubscribed", "Unsubscribed"],
        ] as const).map(([id, label]) => (
          <Chip
            key={id}
            active={value === id}
            disabled={disabled && id === "subscribed"}
            onClick={() => onChange(id as Consent)}
          >
            {label}
          </Chip>
        ))}
      </div>
      {disabled && (
        <span className="mt-1.5 block text-[11.5px] text-text-3">
          Add a {label.toLowerCase().includes("email") ? "valid email" : "valid phone in E.164"} before marking subscribed.
        </span>
      )}
    </div>
  );
}

// ─── CSV Import Modal ──────────────────────────────────────────────────────

type ImportStep = "upload" | "review" | "confirm" | "done";

export function CsvImportModal({
  existingEmails,
  existingPhones,
  onDone,
}: {
  existingEmails: string[];
  existingPhones: string[];
  onDone: () => void;
}) {
  const { close } = useModal();
  const { toast } = useVoomActions();

  const [step, setStep] = useState<ImportStep>("upload");
  const [filename, setFilename] = useState<string>("");
  const [fileSize, setFileSize] = useState<number>(0);
  const [rawCsv, setRawCsv] = useState<string>("");
  const [consentConfirmed, setConsentConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importResult, setImportResult] = useState<{ created: number; skipped: number; errors: string[] } | null>(null);

  const plan = useMemo(() => {
    if (!rawCsv) return null;
    return buildImportPlan(rawCsv, existingEmails, existingPhones);
  }, [rawCsv, existingEmails, existingPhones]);

  async function readFile(file: File) {
    setImportError(null);
    const check = validateCsvUpload(file);
    if (!check.ok) {
      setImportError(check.error);
      return;
    }
    if (file.size > MAX_CSV_BYTES) {
      setImportError(`File is too large. Limit is ${(MAX_CSV_BYTES / 1024 / 1024).toFixed(0)} MB.`);
      return;
    }
    const text = await file.text();
    setFilename(file.name);
    setFileSize(file.size);
    setRawCsv(text);
    setStep("review");
  }

  async function performImport() {
    if (!plan) return;
    setBusy(true);
    setImportError(null);
    const toImport = plan.valid.filter(
      (r) => !plan.alreadyExisting.some(
        (a) => (a.email && a.email === r.email) || (a.phone && a.phone === r.phone),
      ),
    );
    const res = await importContactsAction({
      rows: toImport.map((r) => ({
        first_name: r.first_name,
        last_name: r.last_name,
        email: r.email,
        phone: r.phone,
        tags: r.tags,
      })),
      confirmedSubscribed: consentConfirmed,
    });
    setBusy(false);
    if (!res.ok) {
      setImportError(res.error);
      return;
    }
    setImportResult(res.data);
    setStep("done");
    toast(`Imported ${res.data.created} contact${res.data.created === 1 ? "" : "s"}`, "ok");
    onDone();
  }

  return (
    <ModalShell wide maxWidth={760}>
      <ModalHead
        title="Import contacts from CSV"
        sub="Voom never sends your file anywhere — parsing happens entirely in your browser before the review step."
        onClose={close}
      />
      <ModalBody>
        {importError && (
          <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
            {importError}
          </div>
        )}

        {step === "upload" && (
          <div>
            <CsvUploadZone onFile={readFile} />
            <p className="mt-3 text-[12px] text-text-3">
              Expected columns (header row required): First name, Last name, Email, Phone, Tags. Consent defaults to
              <b> Unknown</b> — the only way to set <b>Subscribed</b> is the explicit checkbox in the review step.
            </p>
          </div>
        )}

        {step === "review" && plan && (
          <div>
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div className="text-[12.5px] text-text-2">
                <b>{filename}</b> · {(fileSize / 1024).toFixed(1)} KB · {plan.detectedHeaders.length} columns detected
              </div>
              <Btn variant="ghost" size="sm" onClick={() => { setStep("upload"); setRawCsv(""); setConsentConfirmed(false); }}>
                <Icon name="back" size={14} /> Choose another file
              </Btn>
            </div>
            <MappingSummary plan={plan} />
            <CountsSummary plan={plan} />
            <div className="mt-4 rounded-[14px] border border-line bg-surface-2 p-3.5">
              <label className="flex items-start gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={consentConfirmed}
                  onChange={(e) => setConsentConfirmed(e.target.checked)}
                  className="mt-[3px] h-4 w-4 accent-[var(--brand)]"
                />
                <span>
                  I confirm the imported contacts have given <b>explicit consent</b> for both email and SMS where I
                  check the box above. Without this, Voom will set both consent states to <b>Unknown</b>.
                </span>
              </label>
            </div>
          </div>
        )}

        {step === "done" && importResult && (
          <div>
            <div className="mb-3 flex items-center gap-2 text-green">
              <Icon name="check" size={18} />
              <b className="text-[15px]">Import complete</b>
            </div>
            <ul className="ml-1 list-disc pl-5 text-[13.5px] text-text-2">
              <li><b>{importResult.created}</b> contact{importResult.created === 1 ? "" : "s"} created</li>
              <li><b>{importResult.skipped}</b> already existed in your workspace — Voom never overwrites</li>
              {importResult.errors.length > 0 && (
                <li><b>{importResult.errors.length}</b> row{importResult.errors.length === 1 ? "" : "s"} reported errors</li>
              )}
            </ul>
            {importResult.errors.length > 0 && (
              <details className="mt-3 text-[12.5px] text-text-3">
                <summary className="cursor-pointer">Show row errors</summary>
                <ul className="mt-2 list-disc pl-5">
                  {importResult.errors.map((e, i) => <li key={i}>{e}</li>)}
                </ul>
              </details>
            )}
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        {step === "upload" && (
          <Btn variant="ghost" onClick={close}>Cancel</Btn>
        )}
        {step === "review" && plan && (
          <>
            <Btn variant="ghost" onClick={() => setStep("upload")}>Back</Btn>
            <Btn
              variant="primary"
              disabled={busy || plan.toCreate === 0}
              onClick={() => setStep("confirm")}
            >
              <Icon name="check" size={14} /> Review {plan.toCreate} to import
            </Btn>
          </>
        )}
        {step === "confirm" && plan && (
          <>
            <Btn variant="ghost" onClick={() => setStep("review")}>Back</Btn>
            <Btn variant="primary" disabled={busy} onClick={() => void performImport()}>
              {busy ? "Importing…" : `Import ${plan.toCreate} contact${plan.toCreate === 1 ? "" : "s"}`}
            </Btn>
          </>
        )}
        {step === "done" && (
          <Btn variant="primary" onClick={close}>Done</Btn>
        )}
      </ModalFoot>
    </ModalShell>
  );
}

function CsvUploadZone({ onFile }: { onFile: (f: File) => void }) {
  const [hover, setHover] = useState(false);
  return (
    <label
      onDragOver={(e) => { e.preventDefault(); setHover(true); }}
      onDragLeave={() => setHover(false)}
      onDrop={(e) => {
        e.preventDefault();
        setHover(false);
        const file = e.dataTransfer.files?.[0];
        if (file) onFile(file);
      }}
      className={`flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[16px] border-2 border-dashed p-8 text-center transition ${
        hover ? "border-brand bg-[var(--brand-soft)]" : "border-line bg-surface-2"
      }`}
    >
      <input
        type="file"
        accept=".csv,text/csv"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onFile(file);
        }}
      />
      <span className="grid h-12 w-12 place-items-center rounded-full bg-[var(--brand-soft)] text-brand">
        <Icon name="img" size={22} />
      </span>
      <b className="text-[15px]">Drop a CSV here, or click to choose</b>
      <span className="text-[12.5px] text-text-3">Up to {MAX_CSV_BYTES / 1024 / 1024} MB — header row required</span>
    </label>
  );
}

function MappingSummary({ plan }: { plan: ReturnType<typeof buildImportPlan> }) {
  return (
    <div className="mb-3 rounded-[14px] border border-line bg-surface-2 p-3.5">
      <div className="mb-1.5 text-[12.5px] font-semibold text-text-2">Detected columns</div>
      <div className="flex flex-wrap gap-1.5">
        {(["first_name", "last_name", "email", "phone", "tags"] as const).map((f) => (
          <Tag key={f} tone={plan.mapping[f] ? "t-green" : "t-grey"}>
            {f.replace("_", " ")}: {plan.mapping[f] ?? "not found"}
          </Tag>
        ))}
      </div>
    </div>
  );
}

function CountsSummary({ plan }: { plan: ReturnType<typeof buildImportPlan> }) {
  return (
    <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-5">
      <CountBox label="Valid" value={plan.valid.length} tone="t-green" />
      <CountBox label="Invalid" value={plan.invalid.length} tone="t-red" />
      <CountBox label="Duplicate in file" value={plan.duplicate.length} tone="t-amber" />
      <CountBox label="Already in workspace" value={plan.alreadyExisting.length} tone="t-grey" />
      <CountBox label="To create" value={plan.toCreate} tone="t-blue" />
    </div>
  );
}

function CountBox({ label, value, tone }: { label: string; value: number; tone: string }) {
  return (
    <div className="rounded-[12px] border border-line bg-surface p-3 text-center">
      <b className="block font-display text-[20px]">{value}</b>
      <span className="mt-0.5 block text-[11px] text-text-3">{label}</span>
      <span className="mt-1 block">
        <Tag tone={tone}>{tone.replace("t-", "")}</Tag>
      </span>
    </div>
  );
}

// ─── Audience Editor Modal ─────────────────────────────────────────────────

export function AudienceEditorModal({
  contacts,
  audience,
  onDone,
}: {
  contacts: ContactRecord[];
  audience?: AudienceRecord;
  onDone: () => void;
}) {
  return (
    <AudienceEditorBody
      key={audience?.id ?? "new"}
      contacts={contacts}
      audience={audience}
      onDone={onDone}
    />
  );
}

function AudienceEditorBody({
  contacts,
  audience,
  onDone,
}: {
  contacts: ContactRecord[];
  audience?: AudienceRecord;
  onDone: () => void;
}) {
  const { close } = useModal();
  const { toast } = useVoomActions();
  const isEdit = Boolean(audience);
  const initialType = audience?.type ?? "all_email_subscribers";
  const [name, setName] = useState(audience?.name ?? "");
  const [description, setDescription] = useState(audience?.description ?? "");
  const [type, setType] = useState<string>(initialType);
  const [tagFilter, setTagFilter] = useState(audience?.tag_filter ?? "");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function toggleSelect(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function submit() {
    setError(null);
    if (!name.trim()) {
      setError("Give the audience a name.");
      return;
    }
    if (type === "tag" && !tagFilter.trim()) {
      setError("Pick a tag to filter by.");
      return;
    }
    if (type === "manual" && !isEdit && selected.size === 0) {
      setError("Pick at least one contact for a manual audience.");
      return;
    }
    setBusy(true);
    const res = await createAudienceAction({
      name: name.trim(),
      description: description.trim() || null,
      type: type as AudienceRecord["type"],
      tag_filter: type === "tag" ? tagFilter.trim() : null,
      contact_ids: type === "manual" ? Array.from(selected) : undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    toast(isEdit ? "Audience updated" : "Audience created", "ok");
    onDone();
    close();
  }

  return (
    <ModalShell wide>
      <ModalHead
        title={isEdit ? "Edit audience" : "New audience"}
        sub="Voom computes the eligible contact list server-side. No contacts are emailed or SMS'd from this screen."
        onClose={close}
      />
      <ModalBody>
        {error && (
          <div role="alert" className="mb-3.5 rounded-xl border border-red/35 bg-red/10 px-3.5 py-2.5 text-sm text-red">
            {error}
          </div>
        )}
        <div className="grid gap-3.5 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="VIP Dubai launch" />
          </Field>
          <Field label="Type">
            <select
              value={type}
              onChange={(e) => setType(e.target.value)}
              className="h-[46px] w-full rounded-xl border border-line bg-surface-2 px-3.5 text-[14.5px] text-text outline-none focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]"
              disabled={isEdit}
            >
              <option value="all_email_subscribers">All email subscribers</option>
              <option value="all_sms_subscribers">All SMS subscribers</option>
              <option value="tag">Tag audience</option>
              <option value="manual">Manual audience</option>
            </select>
          </Field>
        </div>
        <Field label="Description (optional)">
          <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
        </Field>
        {type === "tag" && (
          <Field label="Tag" hint="Contacts with this exact tag will be eligible.">
            <Input value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} placeholder="vip" />
          </Field>
        )}
        {type === "manual" && !isEdit && (
          <div>
            <span className="mb-1.5 block text-[12.5px] font-semibold text-text-2">
              Pick contacts ({selected.size} selected)
            </span>
            <div className="max-h-64 overflow-y-auto rounded-[12px] border border-line bg-surface-2 p-2.5">
              {contacts.length === 0 ? (
                <p className="px-2 py-3 text-center text-[12.5px] text-text-3">
                  No contacts in your workspace yet. Add a contact first.
                </p>
              ) : (
                contacts.map((c) => {
                  const label = [c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || c.phone || c.id;
                  return (
                    <label key={c.id} className="flex cursor-pointer items-center gap-2.5 rounded-[8px] px-2.5 py-1.5 text-[13px] hover:bg-surface">
                      <input
                        type="checkbox"
                        className="h-4 w-4 accent-[var(--brand)]"
                        checked={selected.has(c.id)}
                        onChange={() => toggleSelect(c.id)}
                      />
                      <span className="flex-1 truncate">
                        <b>{label}</b>{" "}
                        <span className="text-text-3">
                          {[c.email, c.phone].filter(Boolean).join(" · ")}
                        </span>
                      </span>
                    </label>
                  );
                })
              )}
            </div>
          </div>
        )}
      </ModalBody>
      <ModalFoot>
        {isEdit && audience && (
          <Btn
            variant="danger"
            disabled={busy}
            onClick={async () => {
              if (!confirm("Delete this audience? Members are removed automatically.")) return;
              setBusy(true);
              const res = await deleteAudienceAction(audience.id);
              setBusy(false);
              if (!res.ok) {
                setError(res.error);
                return;
              }
              toast("Audience removed", "info");
              onDone();
              close();
            }}
          >
            <Icon name="trash" size={14} /> Delete
          </Btn>
        )}
        <Btn variant="ghost" onClick={close}>Cancel</Btn>
        <Btn variant="primary" disabled={busy} onClick={() => void submit()}>
          <Icon name="check" size={14} /> {busy ? "Saving…" : isEdit ? "Save" : "Create audience"}
        </Btn>
      </ModalFoot>
    </ModalShell>
  );
}
