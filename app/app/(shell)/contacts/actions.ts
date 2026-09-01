"use server";

import { revalidatePath } from "next/cache";

import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";
import {
  createContact,
  updateContact,
  createAudience,
  updateAudience,
  addAudienceMembers,
  removeAudienceMember,
} from "@/lib/contacts/server-data";
import type {
  ConsentStatus,
  ContactRecord,
  CreateAudienceInput,
  CreateContactInput,
  UpdateContactInput,
  UpdateAudienceInput,
  AudienceType,
  AudienceRecord,
} from "@/lib/contacts/types";

// ─── Result types ──────────────────────────────────────────────────────────

export type ContactActionResult =
  | { ok: true; data: ContactRecord }
  | { ok: false; error: string };

export type AudienceActionResult =
  | { ok: true; data: AudienceRecord }
  | { ok: false; error: string };

export type ImportActionResult =
  | { ok: true; data: { created: number; skipped: number; errors: string[] } }
  | { ok: false; error: string };

export type DeleteResult = { ok: true } | { ok: false; error: string };

// ─── Helpers ───────────────────────────────────────────────────────────────

async function getOwner(): Promise<{ id: string; db: Awaited<ReturnType<typeof createClient>> } | null> {
  const user = await getCurrentUser();
  if (!user) return null;
  const db = await createClient();
  return { id: user.id, db };
}

function messageFor(error: { code?: string; message?: string } | null | undefined, fallback: string): string {
  if (!error) return fallback;
  return error.message?.trim() ? error.message : fallback;
}

const CONSENT_VALUES: ReadonlySet<ConsentStatus> = new Set(["subscribed", "unsubscribed", "unknown"]);
const AUDIENCE_TYPES: ReadonlySet<AudienceType> = new Set([
  "all_email_subscribers",
  "all_sms_subscribers",
  "tag",
  "manual",
]);

function asConsent(value: unknown): ConsentStatus | null {
  if (typeof value !== "string") return null;
  return CONSENT_VALUES.has(value as ConsentStatus) ? (value as ConsentStatus) : null;
}

function asAudienceType(value: unknown): AudienceType | null {
  if (typeof value !== "string") return null;
  return AUDIENCE_TYPES.has(value as AudienceType) ? (value as AudienceType) : null;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean);
}

function asOptionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// ─── Contacts: create / update / delete ────────────────────────────────────

export async function createContactAction(input: {
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  phone?: string | null;
  email_status?: ConsentStatus | "default";
  sms_status?: ConsentStatus | "default";
  tags?: string[];
}): Promise<ContactActionResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };

  // Defaults: never infer subscribed. Always "unknown" unless user explicitly chose.
  const emailStatus =
    input.email_status === "default" || input.email_status === undefined
      ? "unknown"
      : asConsent(input.email_status) ?? "unknown";
  const smsStatus =
    input.sms_status === "default" || input.sms_status === undefined
      ? "unknown"
      : asConsent(input.sms_status) ?? "unknown";

  const payload: CreateContactInput = {
    owner_id: owner.id,
    first_name: asOptionalString(input.first_name) ?? null,
    last_name: asOptionalString(input.last_name) ?? null,
    email: asOptionalString(input.email) ?? null,
    phone: asOptionalString(input.phone) ?? null,
    email_status: emailStatus,
    sms_status: smsStatus,
    tags: asStringArray(input.tags),
    source: "manual",
  };

  const result = await createContact(owner.db, payload);
  if (!result.ok) {
    if (result.error.code === "duplicate_email") {
      return {
        ok: false,
        error: "A contact with this email already exists in your workspace. Voom never overwrites — open the existing contact instead.",
      };
    }
    if (result.error.code === "duplicate_phone") {
      return {
        ok: false,
        error: "A contact with this phone already exists in your workspace. Voom never overwrites — open the existing contact instead.",
      };
    }
    return { ok: false, error: result.error.message };
  }
  revalidatePath("/app/contacts");
  return { ok: true, data: result.data };
}

export async function updateContactAction(
  contactId: string,
  input: {
    first_name?: string | null;
    last_name?: string | null;
    email?: string | null;
    phone?: string | null;
    email_status?: ConsentStatus;
    sms_status?: ConsentStatus;
    tags?: string[];
  },
): Promise<ContactActionResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };

  const update: UpdateContactInput = {};
  if ("first_name" in input) update.first_name = asOptionalString(input.first_name) ?? null;
  if ("last_name" in input) update.last_name = asOptionalString(input.last_name) ?? null;
  if ("email" in input) update.email = asOptionalString(input.email) ?? null;
  if ("phone" in input) update.phone = asOptionalString(input.phone) ?? null;
  if (input.email_status !== undefined) {
    const v = asConsent(input.email_status);
    if (v) update.email_status = v;
  }
  if (input.sms_status !== undefined) {
    const v = asConsent(input.sms_status);
    if (v) update.sms_status = v;
  }
  if (input.tags !== undefined) update.tags = asStringArray(input.tags);

  const result = await updateContact(owner.db, owner.id, contactId, update);
  if (!result.ok) {
    if (result.error.code === "duplicate_email") {
      return {
        ok: false,
        error: "Another contact already uses this email. Voom never overwrites — choose a different email or edit the existing contact.",
      };
    }
    if (result.error.code === "duplicate_phone") {
      return {
        ok: false,
        error: "Another contact already uses this phone. Voom never overwrites — choose a different phone or edit the existing contact.",
      };
    }
    if (result.error.code === "not_found") {
      return { ok: false, error: "This contact was not found in your workspace." };
    }
    return { ok: false, error: result.error.message };
  }
  revalidatePath("/app/contacts");
  return { ok: true, data: result.data };
}

export async function deleteContactAction(contactId: string): Promise<DeleteResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };
  const { error } = await owner.db
    .from("contacts")
    .delete()
    .eq("owner_id", owner.id)
    .eq("id", contactId);
  if (error) {
    return { ok: false, error: messageFor(error, "Voom couldn't delete that contact. Please try again.") };
  }
  revalidatePath("/app/contacts");
  return { ok: true };
}

// ─── CSV import ────────────────────────────────────────────────────────────

export async function importContactsAction(input: {
  rows: Array<{
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    tags: string[];
  }>;
  /** If true, the user explicitly confirmed that consent is "subscribed" for
   *  BOTH channels. Otherwise both stay "unknown". */
  confirmedSubscribed: boolean;
}): Promise<ImportActionResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };

  if (!Array.isArray(input.rows) || input.rows.length === 0) {
    return { ok: false, error: "No rows to import." };
  }

  const defaultStatus: ConsentStatus = input.confirmedSubscribed ? "subscribed" : "unknown";
  const created: ContactRecord[] = [];
  const errors: string[] = [];

  for (const [i, row] of input.rows.entries()) {
    const payload: CreateContactInput = {
      owner_id: owner.id,
      first_name: row.first_name ?? null,
      last_name: row.last_name ?? null,
      email: row.email ?? null,
      phone: row.phone ?? null,
      email_status: row.email ? defaultStatus : "unknown",
      sms_status: row.phone ? defaultStatus : "unknown",
      tags: Array.isArray(row.tags) ? row.tags.map((t) => String(t).trim()).filter(Boolean) : [],
      source: "csv",
    };

    const result = await createContact(owner.db, payload);
    if (result.ok) {
      created.push(result.data);
      continue;
    }
    // duplicate_* is a successful "skip" — never overwrite
    if (result.error.code === "duplicate_email" || result.error.code === "duplicate_phone") {
      continue;
    }
    errors.push(`Row ${i + 1}: ${result.error.message}`);
  }

  revalidatePath("/app/contacts");
  return {
    ok: true,
    data: { created: created.length, skipped: input.rows.length - created.length - errors.length, errors },
  };
}

// ─── Audiences ─────────────────────────────────────────────────────────────

export async function createAudienceAction(input: {
  name: string;
  description?: string | null;
  type: AudienceType;
  tag_filter?: string | null;
  /** When type=manual, the list of contact ids to attach. */
  contact_ids?: string[];
}): Promise<AudienceActionResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };

  const type = asAudienceType(input.type);
  if (!type) return { ok: false, error: "Pick a valid audience type." };

  const payload: CreateAudienceInput = {
    owner_id: owner.id,
    name: input.name?.trim() ?? "",
    description: asOptionalString(input.description) ?? null,
    type,
    tag_filter: type === "tag" ? asOptionalString(input.tag_filter) ?? null : null,
  };
  if (!payload.name) return { ok: false, error: "Audience name is required." };

  const result = await createAudience(owner.db, payload);
  if (!result.ok) return { ok: false, error: result.error.message };
  if (type === "manual" && Array.isArray(input.contact_ids) && input.contact_ids.length > 0) {
    const members = await addAudienceMembers(owner.db, owner.id, result.data.id, input.contact_ids);
    if (!members.ok) {
      // Roll back the audience we just created so we never leave a half-built one.
      await owner.db.from("audiences").delete().eq("id", result.data.id).eq("owner_id", owner.id);
      return { ok: false, error: members.error.message };
    }
  }
  revalidatePath("/app/contacts");
  return { ok: true, data: result.data };
}

export async function updateAudienceAction(
  audienceId: string,
  input: UpdateAudienceInput,
): Promise<AudienceActionResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };
  const result = await updateAudience(owner.db, owner.id, audienceId, input);
  if (!result.ok) return { ok: false, error: result.error.message };
  revalidatePath("/app/contacts");
  return { ok: true, data: result.data };
}

export async function deleteAudienceAction(audienceId: string): Promise<DeleteResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };
  const { error } = await owner.db
    .from("audiences")
    .delete()
    .eq("owner_id", owner.id)
    .eq("id", audienceId);
  if (error) return { ok: false, error: messageFor(error, "Voom couldn't delete that audience.") };
  revalidatePath("/app/contacts");
  return { ok: true };
}

export async function addAudienceMembersAction(
  audienceId: string,
  contactIds: string[],
): Promise<DeleteResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };
  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return { ok: false, error: "No contacts selected." };
  }
  const result = await addAudienceMembers(owner.db, owner.id, audienceId, contactIds);
  if (!result.ok) return { ok: false, error: result.error.message };
  revalidatePath("/app/contacts");
  return { ok: true };
}

export async function removeAudienceMemberAction(
  audienceId: string,
  contactId: string,
): Promise<DeleteResult> {
  const owner = await getOwner();
  if (!owner) return { ok: false, error: "Your session has expired. Please log in again." };
  const result = await removeAudienceMember(owner.db, owner.id, audienceId, contactId);
  if (!result.ok) return { ok: false, error: result.error.message };
  revalidatePath("/app/contacts");
  return { ok: true };
}
