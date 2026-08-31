// Shared types for the Contacts + Audiences foundation.
// No UI. No sending. No import. Foundation only.

export type ConsentStatus = "subscribed" | "unsubscribed" | "unknown";
export type ContactSource = "manual" | "csv" | "import";
export type AudienceType =
  | "all_email_subscribers"
  | "all_sms_subscribers"
  | "tag"
  | "manual";

export interface ContactRecord {
  id: string;
  owner_id: string;
  first_name: string | null;
  last_name: string | null;
  /** Always lowercase + trimmed. Never null when present. */
  email: string | null;
  /** E.164 format, e.g. +14155551234 */
  phone: string | null;
  email_status: ConsentStatus;
  sms_status: ConsentStatus;
  tags: string[];
  source: ContactSource;
  created_at: string;
  updated_at: string;
}

export interface AudienceRecord {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  type: AudienceType;
  /** Only set when type === 'tag' */
  tag_filter: string | null;
  created_at: string;
  updated_at: string;
}

export interface AudienceMemberRecord {
  audience_id: string;
  contact_id: string;
  owner_id: string;
  created_at: string;
}

// ─── Input shapes ──────────────────────────────────────────────────────────

export interface CreateContactInput {
  owner_id: string;
  first_name?: string | null;
  last_name?: string | null;
  /** Will be lowercased + trimmed before persistence. */
  email?: string | null;
  /** Must be E.164 (starts with +). */
  phone?: string | null;
  email_status?: ConsentStatus;
  sms_status?: ConsentStatus;
  tags?: string[];
  source?: ContactSource;
}

export interface UpdateContactInput {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  email_status?: ConsentStatus;
  sms_status?: ConsentStatus;
  tags?: string[];
}

export interface ListContactsOptions {
  owner_id: string;
  limit?: number;
  offset?: number;
}

export interface CreateAudienceInput {
  owner_id: string;
  name: string;
  description?: string | null;
  type: AudienceType;
  /** Required when type === 'tag'. */
  tag_filter?: string | null;
}

export interface UpdateAudienceInput {
  name?: string;
  description?: string | null;
  tag_filter?: string | null;
}

export interface ListAudiencesOptions {
  owner_id: string;
  limit?: number;
  offset?: number;
}

// ─── Result types ──────────────────────────────────────────────────────────

export type ContactsResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ContactsError };

export type ContactsError =
  | { code: "validation_error"; message: string }
  | { code: "duplicate_email"; message: string }
  | { code: "duplicate_phone"; message: string }
  | { code: "not_found"; message: string }
  | { code: "db_error"; message: string };
