"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { Btn, Card, Chip, Tag } from "@/components/voom/ui/primitives";
import type { ContactRecord, AudienceRecord, AudienceType } from "@/lib/contacts/types";
import type { ContactsSummary } from "@/lib/contacts/load";
import { ConsentChip, ContactName, KpiCard, SourceLabel, TagsList } from "./ContactBits";
import {
  AudienceEditorModal,
  ContactEditorModal,
  CsvImportModal,
} from "./Modals";

type Tab = "contacts" | "audiences";
type Filter = "all" | "email" | "sms" | "unsubscribed" | "unknown";

export function ContactsWorkspace({
  initialContacts,
  initialAudiences,
  initialAudienceSizes,
  initialSummary,
}: {
  initialContacts: ContactRecord[];
  initialAudiences: AudienceRecord[];
  initialAudienceSizes: Record<string, number>;
  initialSummary: ContactsSummary;
}) {
  const { open } = useModal();
  const { toast } = useVoomActions();

  const [tab, setTab] = useState<Tab>("contacts");
  const [contacts, setContacts] = useState<ContactRecord[]>(initialContacts);
  const [audiences, setAudiences] = useState<AudienceRecord[]>(initialAudiences);
  const [audienceSizes, setAudienceSizes] = useState<Record<string, number>>(initialAudienceSizes);
  const [summary, setSummary] = useState<ContactsSummary>(initialSummary);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [openAudience, setOpenAudience] = useState<AudienceRecord | null>(null);

  // Refresh on demand after mutations (server actions call revalidatePath,
  // but in a client workspace we also want an immediate re-pull for snappy UI).
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/voom/contacts/snapshot", { cache: "no-store" });
      if (!response.ok) return;
      const data = (await response.json()) as {
        contacts: ContactRecord[];
        audiences: AudienceRecord[];
        audienceSizes: Record<string, number>;
        summary: ContactsSummary;
      };
      setContacts(data.contacts ?? []);
      setAudiences(data.audiences ?? []);
      setAudienceSizes(data.audienceSizes ?? {});
      setSummary(data.summary ?? initialSummary);
    } catch {
      // Soft-fail; SSR data is still on screen.
    }
  }, [initialSummary]);

  useEffect(() => {
    const handler = () => void refresh();
    window.addEventListener("voom:data-changed", handler);
    return () => window.removeEventListener("voom:data-changed", handler);
  }, [refresh]);

  const filteredContacts = useMemo(() => {
    const q = search.trim().toLowerCase();
    return contacts.filter((c) => {
      if (q) {
        const hay = [c.first_name, c.last_name, c.email, c.phone, c.tags.join(" ")]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!hay.includes(q)) return false;
      }
      switch (filter) {
        case "email":
          return c.email_status === "subscribed";
        case "sms":
          return c.sms_status === "subscribed";
        case "unsubscribed":
          return c.email_status === "unsubscribed" || c.sms_status === "unsubscribed";
        case "unknown":
          return c.email_status === "unknown" || c.sms_status === "unknown";
        default:
          return true;
      }
    });
  }, [contacts, search, filter]);

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <TabButton active={tab === "contacts"} onClick={() => setTab("contacts")}>
          <Icon name="users" size={14} /> Contacts
          <span className="ml-1.5 text-[11.5px] font-normal text-text-3">({contacts.length})</span>
        </TabButton>
        <TabButton active={tab === "audiences"} onClick={() => setTab("audiences")}>
          <Icon name="target" size={14} /> Audiences
          <span className="ml-1.5 text-[11.5px] font-normal text-text-3">({audiences.length})</span>
        </TabButton>
      </div>

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <KpiCard label="Total contacts" value={summary.total} />
        <KpiCard label="Email subscribers" value={summary.emailSubscribers} hint="Consent: subscribed" tone="green" />
        <KpiCard label="SMS subscribers" value={summary.smsSubscribers} hint="Consent: subscribed" tone="brand" />
      </div>

      {tab === "contacts" ? (
        <ContactsTab
          contacts={filteredContacts}
          totalContacts={summary.total}
          search={search}
          onSearch={setSearch}
          filter={filter}
          onFilter={setFilter}
          onAdd={() => open(<ContactEditorModal mode="create" onDone={refresh} />)}
          onImport={() =>
            open(
              <CsvImportModal
                existingEmails={contacts.map((c) => c.email).filter(Boolean) as string[]}
                existingPhones={contacts.map((c) => c.phone).filter(Boolean) as string[]}
                onDone={refresh}
              />,
            )
          }
          onEdit={(c) => open(<ContactEditorModal mode="edit" contact={c} onDone={refresh} />)}
        />
      ) : (
        <AudiencesTab
          audiences={audiences}
          audienceSizes={audienceSizes}
          openAudience={openAudience}
          onOpenAudience={setOpenAudience}
          onCreate={() => open(<AudienceEditorModal contacts={contacts} onDone={refresh} />)}
          onEdit={(a) => open(<AudienceEditorModal audience={a} contacts={contacts} onDone={refresh} />)}
          toast={toast}
        />
      )}
    </div>
  );
}

// ─── Tab buttons ──────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-1.5 rounded-[10px] border px-3.5 py-2 text-[13.5px] font-semibold transition ${
        active ? "border-brand bg-[var(--brand-soft)] text-brand" : "border-line bg-surface-2 text-text-2 hover:text-text"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Contacts tab ─────────────────────────────────────────────────────────

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All" },
  { id: "email", label: "Email subscribers" },
  { id: "sms", label: "SMS subscribers" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "unknown", label: "Unknown consent" },
];

function ContactsTab({
  contacts,
  totalContacts,
  search,
  onSearch,
  filter,
  onFilter,
  onAdd,
  onImport,
  onEdit,
}: {
  contacts: ContactRecord[];
  totalContacts: number;
  search: string;
  onSearch: (v: string) => void;
  filter: Filter;
  onFilter: (v: Filter) => void;
  onAdd: () => void;
  onImport: () => void;
  onEdit: (c: ContactRecord) => void;
}) {
  return (
    <Card className="p-4">
      <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-display text-lg font-semibold">
          Contacts
          <span className="ml-2 text-[12.5px] font-normal text-text-3">{contacts.length} matching</span>
        </h2>
        <div className="flex flex-wrap items-center gap-1.5">
          <Btn variant="outline" size="sm" onClick={onImport}>
            <Icon name="img" size={14} /> Import CSV
          </Btn>
          <Btn variant="primary" size="sm" onClick={onAdd}>
            <Icon name="plus" size={14} /> Add contact
          </Btn>
        </div>
      </div>

      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <div className="relative flex-1 min-w-[220px]">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-3">
            <Icon name="search" size={14} />
          </span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name, email, phone, tag…"
            className="h-[40px] w-full rounded-[11px] border border-line bg-surface-2 pl-9 pr-3.5 text-[13.5px] outline-none placeholder:text-text-3 focus:border-brand focus:bg-surface focus:ring-4 focus:ring-[var(--brand-soft)]"
          />
        </div>
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => (
            <Chip key={f.id} active={filter === f.id} onClick={() => onFilter(f.id)}>
              {f.label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13.5px]">
          <thead>
            <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
              <th className="pb-2.5">Name</th>
              <th className="pb-2.5">Email</th>
              <th className="pb-2.5">Phone</th>
              <th className="pb-2.5">Email</th>
              <th className="pb-2.5">SMS</th>
              <th className="pb-2.5">Tags</th>
              <th className="pb-2.5">Source</th>
              <th className="pb-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody>
            {contacts.length === 0 && (
              <tr className="border-t border-line">
                <td colSpan={8} className="py-10 text-center">
                  <b className="block text-sm text-text-2">{totalContacts === 0 ? "No contacts yet" : "No contacts match this filter"}</b>
                  <span className="mx-auto mt-1 block max-w-md text-[12.5px] leading-relaxed text-text-3">
                    {totalContacts === 0
                      ? "This is your audience workspace — the people who gave you consent to email or message them. Add one manually or import a CSV to get started."
                      : "Try a different search or tag, or clear the filter to see everyone again."}
                  </span>
                </td>
              </tr>
            )}
            {contacts.map((c) => (
              <tr key={c.id} className="border-t border-line align-top">
                <td className="py-3.5 pr-3">
                  <ContactName first_name={c.first_name} last_name={c.last_name} email={c.email} />
                </td>
                <td className="py-3.5 pr-3 text-text-2">
                  <span className="block max-w-[200px] truncate">{c.email ?? "—"}</span>
                </td>
                <td className="py-3.5 pr-3 text-text-2">
                  <span className="block max-w-[160px] truncate">{c.phone ?? "—"}</span>
                </td>
                <td className="py-3.5 pr-3">
                  <ConsentChip status={c.email_status} />
                </td>
                <td className="py-3.5 pr-3">
                  <ConsentChip status={c.sms_status} />
                </td>
                <td className="py-3.5 pr-3">
                  <TagsList tags={c.tags} />
                </td>
                <td className="py-3.5 pr-3 text-[12.5px]">
                  <SourceLabel source={c.source} />
                </td>
                <td className="py-3.5 text-right">
                  <Btn variant="outline" size="sm" onClick={() => onEdit(c)}>
                    <Icon name="edit" size={12} /> Edit
                  </Btn>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11.5px] leading-relaxed text-text-3">
        All contacts are owner-scoped to your account. Voom never infers consent — Unknown is the default and the
        only way to set Subscribed is the explicit chip in the editor.
      </p>
    </Card>
  );
}

// ─── Audiences tab ────────────────────────────────────────────────────────

const AUDIENCE_TYPE_LABEL: Record<AudienceType, string> = {
  all_email_subscribers: "All email subscribers",
  all_sms_subscribers: "All SMS subscribers",
  tag: "Tag audience",
  manual: "Manual audience",
};

function AudiencesTab({
  audiences,
  audienceSizes,
  openAudience,
  onOpenAudience,
  onCreate,
  onEdit,
  toast,
}: {
  audiences: AudienceRecord[];
  audienceSizes: Record<string, number>;
  openAudience: AudienceRecord | null;
  onOpenAudience: (a: AudienceRecord | null) => void;
  onCreate: () => void;
  onEdit: (a: AudienceRecord) => void;
  toast: (msg: string, kind?: "ok" | "err" | "info") => void;
}) {
  return (
    <div>
      <Card className="p-4">
        <div className="mb-3.5 flex flex-wrap items-center justify-between gap-3">
          <h2 className="font-display text-lg font-semibold">
            Audiences
            <span className="ml-2 text-[12.5px] font-normal text-text-3">{audiences.length} defined</span>
          </h2>
          <Btn variant="primary" size="sm" onClick={onCreate}>
            <Icon name="plus" size={14} /> New audience
          </Btn>
        </div>
        {audiences.length === 0 ? (
          <p className="py-8 text-center text-sm text-text-3">
            No audiences yet. Voom computes eligibility server-side — open one to see contacts that match.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {audiences.map((a) => (
              <button
                key={a.id}
                onClick={() => onOpenAudience(a)}
                className="rounded-[14px] border border-line bg-surface-2 p-4 text-left transition hover:border-brand hover:bg-[var(--brand-soft)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <b className="font-display text-[15px]">{a.name}</b>
                  <Tag tone="t-blue">{audienceSizes[a.id] ?? 0}</Tag>
                </div>
                <div className="mt-1.5 text-[12.5px] text-text-2">
                  {AUDIENCE_TYPE_LABEL[a.type]}
                  {a.type === "tag" && a.tag_filter ? ` · #${a.tag_filter}` : ""}
                </div>
                <div className="mt-1 text-[11.5px] text-text-3">Created {formatDate(a.created_at)}</div>
              </button>
            ))}
          </div>
        )}
      </Card>

      {openAudience && (
        <AudienceDetail
          audience={openAudience}
          size={audienceSizes[openAudience.id] ?? 0}
          onClose={() => onOpenAudience(null)}
          onEdit={() => onEdit(openAudience)}
          onToast={toast}
        />
      )}
    </div>
  );
}

function AudienceDetail({
  audience,
  size,
  onClose,
  onEdit,
  onToast,
}: {
  audience: AudienceRecord;
  size: number;
  onClose: () => void;
  onEdit: () => void;
  onToast: (msg: string, kind?: "ok" | "err" | "info") => void;
}) {
  const [eligible, setEligible] = useState<ContactRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    fetch(`/api/voom/audiences/${audience.id}/contacts`, { cache: "no-store" })
      .then((r) => r.json() as Promise<{ contacts?: ContactRecord[]; error?: string }>)
      .then((data) => {
        if (!active) return;
        if (data.error) {
          setError(data.error);
          onToast(data.error, "err");
        } else {
          setEligible(data.contacts ?? []);
        }
      })
      .catch((e) => {
        if (!active) return;
        setError(e instanceof Error ? e.message : "Couldn't load eligible contacts.");
      });
    return () => { active = false; };
  }, [audience.id, onToast]);

  const loading = eligible === null && !error;

  return (
    <div className="fixed inset-0 z-[95] grid place-items-center bg-[rgba(7,9,18,.55)] p-5 backdrop-blur-[5px]" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="max-h-[88dvh] w-full max-w-[760px] overflow-y-auto rounded-[22px] border border-line bg-surface shadow-[var(--shadow-lg)]">
        <div className="flex items-start justify-between gap-3.5 px-[22px] pt-5">
          <div>
            <h2 className="font-display text-lg font-semibold tracking-tight">{audience.name}</h2>
            <p className="mt-1 text-[13px] text-text-3">
              {AUDIENCE_TYPE_LABEL[audience.type]}
              {audience.type === "tag" && audience.tag_filter ? ` · #${audience.tag_filter}` : ""}
              {" · "}
              {size} eligible contact{size === 1 ? "" : "s"}
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <Btn variant="outline" size="sm" onClick={onEdit}>
              <Icon name="edit" size={12} /> Edit
            </Btn>
            <button
              className="grid h-[38px] w-[38px] place-items-center rounded-[11px] text-text-2 transition hover:bg-surface-2 hover:text-text"
              onClick={onClose}
            >
              <Icon name="x" />
            </button>
          </div>
        </div>
        <div className="px-[22px] py-4">
          {loading ? (
            <p className="py-6 text-center text-sm text-text-3">Loading eligible contacts…</p>
          ) : error ? (
            <p className="py-6 text-center text-sm text-red">{error}</p>
          ) : !eligible || eligible.length === 0 ? (
            <p className="py-6 text-center text-sm text-text-3">
              No contacts match this audience yet. {audience.type === "manual" ? "Edit it to add members." : "Add contacts that match the rule first."}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-collapse text-[13.5px]">
                <thead>
                  <tr className="text-left font-mono text-[10.5px] uppercase tracking-[.07em] text-text-3">
                    <th className="pb-2.5">Name</th>
                    <th className="pb-2.5">Email</th>
                    <th className="pb-2.5">Phone</th>
                    <th className="pb-2.5">Tags</th>
                  </tr>
                </thead>
                <tbody>
                  {eligible.map((c) => (
                    <tr key={c.id} className="border-t border-line">
                      <td className="py-3 pr-3">
                        <ContactName first_name={c.first_name} last_name={c.last_name} email={c.email} />
                      </td>
                      <td className="py-3 pr-3 text-text-2">{c.email ?? "—"}</td>
                      <td className="py-3 pr-3 text-text-2">{c.phone ?? "—"}</td>
                      <td className="py-3 pr-3">
                        <TagsList tags={c.tags} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div className="px-[22px] pb-5 pt-2 text-[11.5px] text-text-3">
          Eligibility is computed by Voom using the same <code>resolveAudienceContacts</code> the server uses — never duplicated in the UI.
        </div>
      </div>
    </div>
  );
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-AE", {
    timeZone: "Asia/Dubai",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}
