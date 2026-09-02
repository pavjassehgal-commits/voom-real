import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  validateCreateContact,
  validateUpdateContact,
  validateCreateAudience,
  normalizeContactInput,
  isDuplicateConstraint,
  computeChannelEligibility,
  maskDestination,
} from "./core";
import type {
  ContactRecord,
  AudienceRecord,
  AudienceMemberRecord,
  CreateContactInput,
  UpdateContactInput,
  ListContactsOptions,
  CreateAudienceInput,
  UpdateAudienceInput,
  ListAudiencesOptions,
  ContactsResult,
  ContactChannel,
  AudienceChannelEligibility,
} from "./types";

// ─── Contacts ──────────────────────────────────────────────────────────────

export async function createContact(
  db: SupabaseClient,
  input: CreateContactInput
): Promise<ContactsResult<ContactRecord>> {
  const validationError = validateCreateContact(input);
  if (validationError) return { ok: false, error: validationError };

  const { email, phone } = normalizeContactInput(input);

  const row = {
    owner_id: input.owner_id,
    first_name: input.first_name ?? null,
    last_name: input.last_name ?? null,
    email,
    phone,
    email_status: input.email_status ?? "unknown",
    sms_status: input.sms_status ?? "unknown",
    tags: input.tags ?? [],
    source: input.source ?? "manual",
  };

  const { data, error } = await db
    .from("contacts")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    if (isDuplicateConstraint(error, "contacts_unique_email_per_owner")) {
      return {
        ok: false,
        error: {
          code: "duplicate_email",
          message: "A contact with this email already exists for this owner.",
        },
      };
    }
    if (isDuplicateConstraint(error, "contacts_unique_phone_per_owner")) {
      return {
        ok: false,
        error: {
          code: "duplicate_phone",
          message: "A contact with this phone already exists for this owner.",
        },
      };
    }
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: data as ContactRecord };
}

export async function updateContact(
  db: SupabaseClient,
  ownerId: string,
  contactId: string,
  input: UpdateContactInput
): Promise<ContactsResult<ContactRecord>> {
  const validationError = validateUpdateContact(input);
  if (validationError) return { ok: false, error: validationError };

  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("first_name" in input) updates.first_name = input.first_name ?? null;
  if ("last_name" in input) updates.last_name = input.last_name ?? null;
  if ("email" in input) {
    updates.email = input.email
      ? input.email.toLowerCase().trim()
      : null;
  }
  if ("phone" in input) updates.phone = input.phone?.trim() ?? null;
  if ("email_status" in input) updates.email_status = input.email_status;
  if ("sms_status" in input) updates.sms_status = input.sms_status;
  if ("tags" in input) updates.tags = input.tags;

  const { data, error } = await db
    .from("contacts")
    .update(updates)
    .eq("owner_id", ownerId)
    .eq("id", contactId)
    .select("*")
    .single();

  if (error) {
    if (isDuplicateConstraint(error, "contacts_unique_email_per_owner")) {
      return {
        ok: false,
        error: {
          code: "duplicate_email",
          message: "A contact with this email already exists for this owner.",
        },
      };
    }
    if (isDuplicateConstraint(error, "contacts_unique_phone_per_owner")) {
      return {
        ok: false,
        error: {
          code: "duplicate_phone",
          message: "A contact with this phone already exists for this owner.",
        },
      };
    }
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  if (!data) {
    return {
      ok: false,
      error: { code: "not_found", message: "Contact not found." },
    };
  }

  return { ok: true, data: data as ContactRecord };
}

export async function listContacts(
  db: SupabaseClient,
  options: ListContactsOptions
): Promise<ContactsResult<ContactRecord[]>> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const { data, error } = await db
    .from("contacts")
    .select("*")
    .eq("owner_id", options.owner_id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: (data ?? []) as ContactRecord[] };
}

// ─── Audiences ─────────────────────────────────────────────────────────────

export async function createAudience(
  db: SupabaseClient,
  input: CreateAudienceInput
): Promise<ContactsResult<AudienceRecord>> {
  const validationError = validateCreateAudience(input);
  if (validationError) return { ok: false, error: validationError };

  const row = {
    owner_id: input.owner_id,
    name: input.name.trim(),
    description: input.description ?? null,
    type: input.type,
    tag_filter: input.type === "tag" ? (input.tag_filter ?? null) : null,
  };

  const { data, error } = await db
    .from("audiences")
    .insert(row)
    .select("*")
    .single();

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: data as AudienceRecord };
}

export async function updateAudience(
  db: SupabaseClient,
  ownerId: string,
  audienceId: string,
  input: UpdateAudienceInput
): Promise<ContactsResult<AudienceRecord>> {
  const updates: Record<string, unknown> = { updated_at: new Date().toISOString() };

  if ("name" in input && input.name !== undefined) {
    const name = input.name.trim();
    if (!name) {
      return {
        ok: false,
        error: { code: "validation_error", message: "Audience name cannot be empty." },
      };
    }
    updates.name = name;
  }
  if ("description" in input) updates.description = input.description ?? null;
  if ("tag_filter" in input) updates.tag_filter = input.tag_filter ?? null;

  const { data, error } = await db
    .from("audiences")
    .update(updates)
    .eq("owner_id", ownerId)
    .eq("id", audienceId)
    .select("*")
    .single();

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  if (!data) {
    return {
      ok: false,
      error: { code: "not_found", message: "Audience not found." },
    };
  }

  return { ok: true, data: data as AudienceRecord };
}

export async function listAudiences(
  db: SupabaseClient,
  options: ListAudiencesOptions
): Promise<ContactsResult<AudienceRecord[]>> {
  const limit = options.limit ?? 50;
  const offset = options.offset ?? 0;

  const { data, error } = await db
    .from("audiences")
    .select("*")
    .eq("owner_id", options.owner_id)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: (data ?? []) as AudienceRecord[] };
}

// ─── Audience members ──────────────────────────────────────────────────────

export async function addAudienceMembers(
  db: SupabaseClient,
  ownerId: string,
  audienceId: string,
  contactIds: string[]
): Promise<ContactsResult<AudienceMemberRecord[]>> {
  if (contactIds.length === 0) {
    return { ok: true, data: [] };
  }

  const rows = contactIds.map((contactId) => ({
    audience_id: audienceId,
    contact_id: contactId,
    owner_id: ownerId,
  }));

  const { data, error } = await db
    .from("audience_members")
    .insert(rows)
    .select("*");

  if (error) {
    // Duplicate membership is not a hard failure — skip silently when using upsert style.
    // But the spec says "prevent duplicate membership", so we treat it as a db_error
    // and let the caller handle if needed.
    if (isDuplicateConstraint(error)) {
      return {
        ok: false,
        error: {
          code: "db_error",
          message: "One or more contacts are already members of this audience.",
        },
      };
    }
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: (data ?? []) as AudienceMemberRecord[] };
}

export async function removeAudienceMember(
  db: SupabaseClient,
  ownerId: string,
  audienceId: string,
  contactId: string
): Promise<ContactsResult<void>> {
  const { error } = await db
    .from("audience_members")
    .delete()
    .eq("owner_id", ownerId)
    .eq("audience_id", audienceId)
    .eq("contact_id", contactId);

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  return { ok: true, data: undefined };
}

// ─── Resolution ────────────────────────────────────────────────────────────

/**
 * Resolve the effective contacts for an audience.
 *
 * Resolution rules (spec):
 * - all_email_subscribers → email IS NOT NULL AND email_status = 'subscribed'
 * - all_sms_subscribers   → phone IS NOT NULL AND sms_status = 'subscribed'
 * - tag                   → contact.tags contains audience.tag_filter
 *                           (later channel usage must still respect consent)
 * - manual                → contacts referenced in audience_members
 *
 * No sending is performed here.
 */
export async function resolveAudienceContacts(
  db: SupabaseClient,
  ownerId: string,
  audienceId: string
): Promise<ContactsResult<ContactRecord[]>> {
  // Fetch the audience first
  const { data: audience, error: audienceError } = await db
    .from("audiences")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("id", audienceId)
    .single();

  if (audienceError || !audience) {
    return {
      ok: false,
      error: { code: "not_found", message: "Audience not found." },
    };
  }

  const aud = audience as AudienceRecord;

  if (aud.type === "all_email_subscribers") {
    const { data, error } = await db
      .from("contacts")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("email_status", "subscribed")
      .not("email", "is", null);

    if (error) {
      return { ok: false, error: { code: "db_error", message: error.message } };
    }
    return { ok: true, data: (data ?? []) as ContactRecord[] };
  }

  if (aud.type === "all_sms_subscribers") {
    const { data, error } = await db
      .from("contacts")
      .select("*")
      .eq("owner_id", ownerId)
      .eq("sms_status", "subscribed")
      .not("phone", "is", null);

    if (error) {
      return { ok: false, error: { code: "db_error", message: error.message } };
    }
    return { ok: true, data: (data ?? []) as ContactRecord[] };
  }

  if (aud.type === "tag") {
    if (!aud.tag_filter) {
      return {
        ok: false,
        error: {
          code: "validation_error",
          message: "Tag audience has no tag_filter.",
        },
      };
    }

    const { data, error } = await db
      .from("contacts")
      .select("*")
      .eq("owner_id", ownerId)
      .contains("tags", [aud.tag_filter]);

    if (error) {
      return { ok: false, error: { code: "db_error", message: error.message } };
    }
    return { ok: true, data: (data ?? []) as ContactRecord[] };
  }

  // manual
  const { data, error } = await db
    .from("audience_members")
    .select("contacts(*)")
    .eq("owner_id", ownerId)
    .eq("audience_id", audienceId);

  if (error) {
    return { ok: false, error: { code: "db_error", message: error.message } };
  }

  const contacts = (data ?? [])
    .map((row: Record<string, unknown>) => row["contacts"])
    .filter(Boolean) as ContactRecord[];

  return { ok: true, data: contacts };
}

// ─── Channel eligibility for campaign sends ────────────────────────────────

/**
 * Resolve an audience and compute channel-aware eligibility in one step.
 * Ownership is re-validated here (owner-scoped audience lookup), so the send
 * path can re-resolve the audience at send time without trusting the client.
 *
 * Eligibility rules: email requires subscribed + valid email; SMS requires
 * subscribed + valid E.164 phone. Unknown/unsubscribed are excluded and
 * duplicate destinations are deduped. No sending is performed here.
 *
 * The returned eligible destinations are raw and server-only — callers that
 * answer browser requests must only ever return the masked form.
 */
export async function resolveAudienceChannelEligibility(
  db: SupabaseClient,
  ownerId: string,
  audienceId: string,
  channel: ContactChannel
): Promise<ContactsResult<AudienceChannelEligibility>> {
  if (channel !== "email" && channel !== "sms") {
    return {
      ok: false,
      error: { code: "validation_error", message: "Channel must be email or sms." },
    };
  }

  // Fetch the audience first: owner-scoped, so this doubles as the ownership
  // check for both the preview and the send-time re-resolution.
  const { data: audience, error: audienceError } = await db
    .from("audiences")
    .select("*")
    .eq("owner_id", ownerId)
    .eq("id", audienceId)
    .maybeSingle();

  if (audienceError) {
    return { ok: false, error: { code: "db_error", message: audienceError.message } };
  }
  if (!audience) {
    return {
      ok: false,
      error: { code: "not_found", message: "Audience not found." },
    };
  }

  const resolved = await resolveAudienceContacts(db, ownerId, audienceId);
  if (!resolved.ok) return resolved;

  const summary = computeChannelEligibility(resolved.data, channel);
  const eligible = summary.eligible.map(({ contact, destination }) => ({
    contactId: contact.id,
    destination,
    masked: maskDestination(destination),
    contactName:
      [contact.first_name, contact.last_name].filter(Boolean).join(" ") || null,
  }));

  // Deterministic order by destination so the per-send cap and retries are
  // stable across requests.
  eligible.sort((a, b) => a.destination.localeCompare(b.destination));

  return {
    ok: true,
    data: {
      audience: audience as AudienceRecord,
      channel,
      totalMembers: resolved.data.length,
      eligibleCount: eligible.length,
      excludedCount: summary.excluded.length,
      duplicateCount: summary.duplicates.length,
      eligible,
    },
  };
}
