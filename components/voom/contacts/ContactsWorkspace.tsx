"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useVoomActions } from "@/lib/voom/store";
import { useModal } from "@/lib/voom/modal";
import { Icon } from "@/components/voom/icons";
import { Btn, Tag } from "@/components/voom/ui/primitives";
import { BTN } from "@/components/voom/redesign/ui";
import { cx } from "@/lib/voom/cx";
import type { ContactRecord, AudienceRecord, AudienceType } from "@/lib/contacts/types";
import type { ContactsSummary } from "@/lib/contacts/load";
import { ConsentChip, ContactName, KpiCard, SourceLabel, TagsList, sourceLabel } from "./ContactBits";
import {
  AudienceEditorModal,
  ContactEditorModal,
  CsvImportModal,
} from "./Modals";

type Tab = "contacts" | "audiences";
type Filter = "all" | "email" | "unsubscribed" | "unknown";

type Sort = "added_desc" | "added_asc" | "name";
const PAGE_SIZE = 25;

/**
 * Contacts — redesign (Figma "Your audience in one place.", PDF page 83,
 * labelled "Channels · Connections").
 *
 * Every figure is computed from the owner's own contact rows: totals and
 * consent come from the server summary, "added this month" and the source and
 * consent breakdowns from the same rows on screen. Search, the consent
 * filters, sorting and paging run over the real list. Add, Import CSV, Edit
 * and the Audiences tab are the existing actions and modals. The reference's
 * bulk-select checkboxes, Segment / More filters menus, Sources tab, "Grow
 * your audience with MARA" suggestions, month-over-month percentages and
 * per-contact campaign counts are not shown: Voom has no backing for them.
 */
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
  const [sort, setSort] = useState<Sort>("added_desc");
  const [page, setPage] = useState(0);
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
    const list = contacts.filter((c) => {
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
        case "unsubscribed":
          return c.email_status === "unsubscribed";
        case "unknown":
          return c.email_status === "unknown";
        default:
          return true;
      }
    });
    const nameOf = (c: ContactRecord) => [c.first_name, c.last_name].filter(Boolean).join(" ").trim().toLowerCase() || (c.email ?? "");
    return [...list].sort((a, b) =>
      sort === "name" ? nameOf(a).localeCompare(nameOf(b))
        : sort === "added_asc" ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at));
  }, [contacts, search, filter, sort]);

  const pages = Math.max(1, Math.ceil(filteredContacts.length / PAGE_SIZE));
  const currentPage = Math.min(page, pages - 1);
  const pageContacts = filteredContacts.slice(currentPage * PAGE_SIZE, (currentPage + 1) * PAGE_SIZE);
  const monthPrefix = new Date().toISOString().slice(0, 7);
  const addedThisMonth = contacts.filter((c) => c.created_at.startsWith(monthPrefix)).length;
  const unsubscribedShare = summary.total ? Math.round((summary.unsubscribed / summary.total) * 1000) / 10 : 0;

  return (
    <div className="min-w-0">
      <div className="mb-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Total contacts" value={summary.total.toLocaleString("en-US")} hint={`${addedThisMonth} added this month`} icon={<Icon name="contacts" size={21} />} />
        <KpiCard label="Email subscribers" value={summary.emailSubscribers.toLocaleString("en-US")} hint="Consent: subscribed" tone="green" icon={<Icon name="mail" size={21} />} />
        <KpiCard label="Audiences" value={audiences.length} hint="Saved groups you can send to" icon={<Icon name="target" size={21} />} />
        <KpiCard label="Unsubscribed" value={summary.unsubscribed.toLocaleString("en-US")} hint={`${unsubscribedShare}% of contacts · ${summary.unknownConsent} with unknown consent`} tone="coral" icon={<Icon name="x" size={21} />} />
      </div>

      <div className="mb-4 flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2" role="tablist" aria-label="Contacts views">
          <TabButton active={tab === "contacts"} onClick={() => setTab("contacts")}>
            Contacts <span className="text-[12.5px] font-normal text-text-3">{contacts.length.toLocaleString("en-US")}</span>
          </TabButton>
          <TabButton active={tab === "audiences"} onClick={() => setTab("audiences")}>
            Audiences <span className="text-[12.5px] font-normal text-text-3">{audiences.length}</span>
          </TabButton>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={BTN.quiet}
            onClick={() =>
              open(
                <CsvImportModal
                  existingEmails={contacts.map((c) => c.email).filter(Boolean) as string[]}
                  existingPhones={contacts.map((c) => c.phone).filter(Boolean) as string[]}
                  onDone={refresh}
                />,
              )
            }
          >
            <Icon name="upload" size={16} /> Import CSV
          </button>
          {tab === "contacts"
            ? <button type="button" className={BTN.primary} onClick={() => open(<ContactEditorModal mode="create" onDone={refresh} />)}><Icon name="plus" size={16} /> Add contact</button>
            : <button type="button" className={BTN.primary} onClick={() => open(<AudienceEditorModal contacts={contacts} onDone={refresh} />)}><Icon name="plus" size={16} /> New audience</button>}
        </div>
      </div>

      {tab === "contacts" ? (
        <ContactsTab
          contacts={pageContacts}
          matching={filteredContacts.length}
          totalContacts={summary.total}
          search={search}
          onSearch={(value) => { setSearch(value); setPage(0); }}
          filter={filter}
          onFilter={(value) => { setFilter(value); setPage(0); }}
          sort={sort}
          onSort={setSort}
          page={currentPage}
          pages={pages}
          onPage={setPage}
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

      <Breakdowns contacts={contacts} summary={summary} audiences={audiences} audienceSizes={audienceSizes} />
    </div>
  );
}

// ─── Tab buttons ──────────────────────────────────────────────────────────

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cx(
        "inline-flex h-11 items-center gap-2.5 rounded-[14px] border px-4 text-[14.5px] font-semibold transition",
        active ? "border-line bg-surface text-text shadow-[var(--shadow-sm)]" : "border-transparent bg-surface-2 text-text-2 hover:text-text",
      )}
    >
      {children}
    </button>
  );
}

// ─── Contacts tab ─────────────────────────────────────────────────────────

const FILTERS: Array<{ id: Filter; label: string }> = [
  { id: "all", label: "All contacts" },
  { id: "email", label: "Email subscribers" },
  { id: "unsubscribed", label: "Unsubscribed" },
  { id: "unknown", label: "Unknown consent" },
];

const SORT_LABEL: Record<Sort, string> = { added_desc: "Newest first", added_asc: "Oldest first", name: "Name A–Z" };

function ContactsTab({
  contacts,
  matching,
  totalContacts,
  search,
  onSearch,
  filter,
  onFilter,
  sort,
  onSort,
  page,
  pages,
  onPage,
  onEdit,
}: {
  contacts: ContactRecord[];
  matching: number;
  totalContacts: number;
  search: string;
  onSearch: (v: string) => void;
  filter: Filter;
  onFilter: (v: Filter) => void;
  sort: Sort;
  onSort: (v: Sort) => void;
  page: number;
  pages: number;
  onPage: (v: number) => void;
  onEdit: (c: ContactRecord) => void;
}) {
  return (
    <section className="voom-card min-w-0 overflow-hidden" aria-label="Contacts">
      <div className="flex min-w-0 flex-col gap-3 border-b border-line p-4 lg:flex-row lg:items-center">
        <div className="relative min-w-0 flex-1">
          <span className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-text-3"><Icon name="search" size={15} /></span>
          <input
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            placeholder="Search by name, email, phone or tag…"
            aria-label="Search contacts"
            className={cx(BTN.field, "w-full pl-10")}
          />
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <button key={f.id} type="button" aria-pressed={filter === f.id} onClick={() => onFilter(f.id)}
              className={cx("h-10 rounded-full border px-4 text-[13.5px] font-semibold transition", filter === f.id ? "voom-create-btn border-transparent text-white" : "border-line bg-surface text-text-2 hover:text-text")}>
              {f.label}
            </button>
          ))}
          <label className="sr-only" htmlFor="contacts-sort">Sort</label>
          <select id="contacts-sort" value={sort} onChange={(e) => onSort(e.target.value as Sort)} className={cx(BTN.field, "h-10 rounded-full")}>
            {(Object.keys(SORT_LABEL) as Sort[]).map((key) => <option key={key} value={key}>{SORT_LABEL[key]}</option>)}
          </select>
        </div>
      </div>

      {contacts.length === 0 ? (
        <div className="px-5 py-12 text-center">
          <b className="block text-[15px] font-semibold text-text">{totalContacts === 0 ? "No contacts yet" : "No contacts match this filter"}</b>
          <span className="mx-auto mt-1 block max-w-md text-[13px] leading-relaxed text-text-2">
            {totalContacts === 0
              ? "This is your audience workspace — the people who gave you consent to email them. Add one manually or import a CSV to get started."
              : "Try a different search or tag, or clear the filter to see everyone again."}
          </span>
        </div>
      ) : (
        <table className="w-full table-fixed border-collapse text-[13.5px]">
          <thead>
            <tr className="border-b border-line text-left text-[11.5px] font-semibold uppercase tracking-[0.1em] text-text-2">
              <th className="px-4 py-3 lg:w-[24%]">Contact</th>
              <th className="hidden px-3 py-3 lg:table-cell lg:w-[22%]">Email</th>
              <th className="hidden px-3 py-3 xl:table-cell xl:w-[14%]">Phone</th>
              <th className="hidden px-3 py-3 md:table-cell md:w-[18%]">Tags</th>
              <th className="hidden px-3 py-3 xl:table-cell xl:w-[10%]">Source</th>
              <th className="w-[104px] px-3 py-3 sm:w-[124px]">Email consent</th>
              <th className="hidden px-3 py-3 sm:table-cell sm:w-[104px]">Added</th>
              <th className="w-[52px] px-2 py-3"><span className="sr-only">Actions</span></th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {contacts.map((c) => (
              <tr key={c.id} className="align-middle transition hover:bg-surface-2/60">
                <td className="min-w-0 px-4 py-3"><ContactName first_name={c.first_name} last_name={c.last_name} email={c.email} /></td>
                <td className="hidden truncate px-3 py-3 text-text-2 lg:table-cell">{c.email ?? "—"}</td>
                <td className="hidden truncate px-3 py-3 text-text-2 xl:table-cell">{c.phone ?? "—"}</td>
                <td className="hidden px-3 py-3 md:table-cell"><TagsList tags={c.tags} /></td>
                <td className="hidden truncate px-3 py-3 text-[13px] xl:table-cell"><SourceLabel source={c.source} /></td>
                <td className="px-3 py-3"><ConsentChip status={c.email_status} /></td>
                <td className="hidden px-3 py-3 text-[13px] text-text-2 sm:table-cell">{formatDate(c.created_at)}</td>
                <td className="px-2 py-3 text-right">
                  <button type="button" onClick={() => onEdit(c)} aria-label={`Edit ${[c.first_name, c.last_name].filter(Boolean).join(" ") || c.email || "contact"}`}
                    className="grid h-9 w-9 place-items-center rounded-full text-text-2 transition hover:bg-surface-3 hover:text-text">
                    <Icon name="edit" size={15} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3 border-t border-line px-4 py-3">
        <span className="text-[13px] text-text-2">
          {matching === 0 ? "No contacts shown" : `Showing ${page * PAGE_SIZE + 1}–${Math.min((page + 1) * PAGE_SIZE, matching)} of ${matching.toLocaleString("en-US")} contacts`}
        </span>
        {pages > 1 && (
          <div className="flex items-center gap-1.5">
            <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} className="grid h-9 w-9 place-items-center rounded-full border border-line text-text-2 disabled:opacity-40"><Icon name="chevL" size={15} /></button>
            <span className="min-w-[64px] text-center text-[13px] font-semibold text-text">{page + 1} / {pages}</span>
            <button type="button" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} className="grid h-9 w-9 place-items-center rounded-full border border-line text-text-2 disabled:opacity-40"><Icon name="chevR" size={15} /></button>
          </div>
        )}
      </div>
      <p className="border-t border-line px-4 py-3 text-[12px] leading-relaxed text-text-3">
        All contacts are owner-scoped to your account. Voom never infers consent — Unknown is the default and the
        only way to set Subscribed is the explicit chip in the editor.
      </p>
    </section>
  );
}

// ─── Breakdowns: real counts from the rows on screen ─────────────────────

function Breakdowns({ contacts, summary, audiences, audienceSizes }: {
  contacts: ContactRecord[];
  summary: ContactsSummary;
  audiences: AudienceRecord[];
  audienceSizes: Record<string, number>;
}) {
  if (summary.total === 0) return null;
  const sources = Object.entries(contacts.reduce<Record<string, number>>((acc, c) => { acc[c.source] = (acc[c.source] ?? 0) + 1; return acc; }, {}))
    .sort((a, b) => b[1] - a[1]);
  const topAudiences = [...audiences].sort((a, b) => (audienceSizes[b.id] ?? 0) - (audienceSizes[a.id] ?? 0)).slice(0, 4);
  const consent: [string, number, string][] = [
    ["Subscribed", summary.emailSubscribers, "var(--green-dot)"],
    ["Unknown", summary.unknownConsent, "var(--line-strong)"],
    ["Unsubscribed", summary.unsubscribed, "var(--coral)"],
  ];
  return (
    <div className="mt-5 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-4 lg:grid-cols-3">
      <BreakdownCard title="Email consent" hint={`All ${summary.total.toLocaleString("en-US")} contacts by stored consent.`}>
        {consent.map(([label, count, color]) => <Bar key={label} label={label} count={count} total={summary.total} color={color} />)}
      </BreakdownCard>
      <BreakdownCard title="Top audiences" hint={audiences.length ? "Eligible contacts per saved audience." : "No audiences yet."}>
        {topAudiences.map((a) => <Bar key={a.id} label={a.name} count={audienceSizes[a.id] ?? 0} total={summary.total} color="var(--brand)" />)}
      </BreakdownCard>
      <BreakdownCard title="Where contacts come from" hint={`All ${summary.total.toLocaleString("en-US")} contacts by how they were added.`}>
        {sources.map(([source, count]) => <Bar key={source} label={sourceLabel(source)} count={count} total={summary.total} color="var(--brand)" />)}
      </BreakdownCard>
    </div>
  );
}

function BreakdownCard({ title, hint, children }: { title: string; hint: string; children: React.ReactNode }) {
  return (
    <section className="voom-card min-w-0 p-5" aria-label={title}>
      <h2 className="text-[16px] font-semibold text-text">{title}</h2>
      <p className="mt-0.5 text-[13px] text-text-2">{hint}</p>
      <div className="mt-4 space-y-3">{children}</div>
    </section>
  );
}

function Bar({ label, count, total, color }: { label: string; count: number; total: number; color: string }) {
  const share = total ? Math.round((count / total) * 100) : 0;
  return (
    <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_40px] items-center gap-3 text-[13px]">
      <span className="truncate text-text">{label}</span>
      <span className="tabular-nums text-text-2">{count.toLocaleString("en-US")}</span>
      <span className="h-1.5 overflow-hidden rounded-full bg-surface-3"><span className="block h-full rounded-full" style={{ width: `${share}%`, background: color }} /></span>
      <span className="text-right font-semibold tabular-nums text-text">{share}%</span>
    </div>
  );
}

// ─── Audiences tab ────────────────────────────────────────────────────────

const AUDIENCE_TYPE_LABEL: Record<AudienceType, string> = {
  all_email_subscribers: "All email subscribers",
  all_sms_subscribers: "Archived SMS subscribers",
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
      <section className="voom-card p-5" aria-label="Audiences">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-[17px] font-semibold text-text">
            Audiences
            <span className="ml-2 text-[13px] font-normal text-text-2">{audiences.length} defined</span>
          </h2>
          <button type="button" className={BTN.outline} onClick={onCreate}>
            <Icon name="plus" size={14} /> New audience
          </button>
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
                className="rounded-[16px] border border-line bg-surface p-4 text-left transition hover:border-[var(--brand-line)] hover:bg-[var(--brand-soft-2)]"
              >
                <div className="flex items-start justify-between gap-2">
                  <b className="text-[15px] font-semibold text-text">{a.name}</b>
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
      </section>

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
