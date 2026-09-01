"use client";

import type { ConsentStatus } from "@/lib/contacts/types";
import { Tag } from "@/components/voom/ui/primitives";

const CONSENT_TONE: Record<ConsentStatus, { tone: string; label: string }> = {
  subscribed: { tone: "t-green", label: "Subscribed" },
  unsubscribed: { tone: "t-red", label: "Unsubscribed" },
  unknown: { tone: "t-grey", label: "Unknown" },
};

const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  csv: "CSV import",
  import: "Import",
};

export function ConsentChip({ status }: { status: ConsentStatus }) {
  const meta = CONSENT_TONE[status];
  return <Tag tone={meta.tone}>{meta.label}</Tag>;
}

export function SourceLabel({ source }: { source: string }) {
  return <span className="text-text-2">{SOURCE_LABEL[source] ?? source}</span>;
}

export function TagsList({ tags }: { tags: string[] }) {
  if (!tags || tags.length === 0) {
    return <span className="text-text-3">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((tag) => (
        <Tag key={tag} tone="t-brand">
          {tag}
        </Tag>
      ))}
    </div>
  );
}

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
  if (name) return <span className="font-medium text-text">{name}</span>;
  return <span className="text-text-3">{email ?? "—"}</span>;
}

export function KpiCard({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "brand" | "green" | "amber";
}) {
  const accent = tone === "brand" ? "text-brand" : tone === "green" ? "text-green" : tone === "amber" ? "text-amber" : "text-text";
  return (
    <div className="rounded-[14px] border border-line bg-surface p-4">
      <span className="block text-[12px] font-medium text-text-2">{label}</span>
      <b className={`mt-1 block font-display text-[26px] leading-none ${accent}`}>{value}</b>
      {hint && <span className="mt-1.5 block text-[11.5px] text-text-3">{hint}</span>}
    </div>
  );
}
