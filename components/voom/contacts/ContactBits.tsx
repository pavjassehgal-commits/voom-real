"use client";

import type { ReactNode } from "react";
import type { ConsentStatus } from "@/lib/contacts/types";
import { cx } from "@/lib/voom/cx";

/** Consent chip — the ONE wording for a contact's stored email consent. */
const CONSENT_TONE: Record<ConsentStatus, { className: string; label: string }> = {
  subscribed: { className: "bg-[var(--green-soft)] text-[var(--green)]", label: "Subscribed" },
  unsubscribed: { className: "bg-[var(--coral-soft)] text-[var(--coral)]", label: "Unsubscribed" },
  unknown: { className: "bg-surface-3 text-text-2", label: "Unknown" },
};

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  csv: "CSV import",
  import: "Import",
};

export function sourceLabel(source: string) {
  return SOURCE_LABEL[source] ?? source;
}

export function ConsentChip({ status }: { status: ConsentStatus }) {
  const meta = CONSENT_TONE[status];
  return <span className={cx("inline-flex rounded-full px-2.5 py-0.5 text-[12px] font-semibold", meta.className)}>{meta.label}</span>;
}

export function SourceLabel({ source }: { source: string }) {
  return <span className="text-text-2">{sourceLabel(source)}</span>;
}

export function TagsList({ tags }: { tags: string[] }) {
  if (!tags || tags.length === 0) {
    return <span className="text-text-3">—</span>;
  }
  const shown = tags.slice(0, 2);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((tag) => (
        <span key={tag} className="rounded-[8px] border border-[var(--brand-line)] bg-[var(--brand-soft-2)] px-2 py-0.5 text-[12px] font-medium text-[var(--brand-ink)]">
          {tag}
        </span>
      ))}
      {tags.length > shown.length && <span className="rounded-[8px] bg-surface-3 px-2 py-0.5 text-[12px] font-medium text-text-2" title={tags.slice(2).join(", ")}>+{tags.length - shown.length}</span>}
    </div>
  );
}

const AVATAR_TONES = [
  "bg-[var(--brand-soft)] text-[var(--brand-ink)]",
  "bg-[var(--green-soft)] text-[var(--green)]",
  "bg-[var(--coral-soft)] text-[var(--coral)]",
  "bg-[var(--blue-soft)] text-[var(--blue)]",
];

export function ContactName({
  first_name,
  last_name,
  email,
}: {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}) {
  const name = [first_name, last_name].filter(Boolean).join(" ").trim();
  const initials = (name ? name.split(/\s+/).map((part) => part[0]).join("") : (email ?? "?")[0]).slice(0, 2).toUpperCase();
  const tone = AVATAR_TONES[(name || email || "").length % AVATAR_TONES.length];
  return (
    <span className="flex min-w-0 items-center gap-3">
      <span className={cx("grid h-9 w-9 shrink-0 place-items-center rounded-full text-[12.5px] font-bold", tone)} aria-hidden="true">{initials}</span>
      <span className="min-w-0">
        {name ? <span className="block truncate font-semibold text-text">{name}</span> : <span className="block truncate text-text-3">No name</span>}
        <span className="block truncate text-[12px] text-text-3 lg:hidden">{email ?? "No email"}</span>
      </span>
    </span>
  );
}

export function KpiCard({
  label,
  value,
  hint,
  icon,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "brand" | "green" | "amber" | "coral";
}) {
  const tile = tone === "green" ? "bg-[var(--green-soft)] text-[var(--green)]" : tone === "coral" || tone === "amber" ? "bg-[var(--coral-soft)] text-[var(--coral)]" : "bg-[var(--brand-soft)] text-[var(--brand-ink)]";
  return (
    <div className="voom-card flex min-w-0 items-center gap-4 p-5">
      {icon && <span className={cx("grid h-12 w-12 shrink-0 place-items-center rounded-[14px]", tile)}>{icon}</span>}
      <div className="min-w-0">
        <span className="block text-[13.5px] text-text-2">{label}</span>
        <b className="mt-0.5 block text-[26px] font-bold leading-none tracking-[-0.03em] text-text">{value}</b>
        {hint && <span className="mt-1.5 block text-[12px] text-text-2">{hint}</span>}
      </div>
    </div>
  );
}
