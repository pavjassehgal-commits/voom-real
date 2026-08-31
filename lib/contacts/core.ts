// Pure, side-effect-free helpers for the Contacts + Audiences domain.
// No database calls. No sending. Safe to import anywhere.

import type {
  ConsentStatus,
  ContactSource,
  CreateContactInput,
  UpdateContactInput,
  CreateAudienceInput,
  ContactsError,
  AudienceType,
} from "./types";

// ─── Email normalization ────────────────────────────────────────────────────

/** Normalize an email address: lowercase + trim. Returns null if input is null/undefined. */
export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null;
  return email.toLowerCase().trim();
}

/** Basic E.164 check: starts with +, 8–15 digits total. */
export function isValidE164(phone: string): boolean {
  return /^\+[1-9][0-9]{7,14}$/.test(phone);
}

// ─── Validation ────────────────────────────────────────────────────────────

const VALID_CONSENT: ReadonlySet<ConsentStatus> = new Set([
  "subscribed",
  "unsubscribed",
  "unknown",
]);
const VALID_SOURCES: ReadonlySet<ContactSource> = new Set([
  "manual",
  "csv",
  "import",
]);
const VALID_AUDIENCE_TYPES: ReadonlySet<AudienceType> = new Set([
  "all_email_subscribers",
  "all_sms_subscribers",
  "tag",
  "manual",
]);

export function validateCreateContact(
  input: CreateContactInput
): ContactsError | null {
  const email = normalizeEmail(input.email);
  const phone = input.phone?.trim() ?? null;

  // At least one destination required
  if (!email && !phone) {
    return {
      code: "validation_error",
      message: "A contact must have at least an email address or a phone number.",
    };
  }

  // E.164 phone check
  if (phone && !isValidE164(phone)) {
    return {
      code: "validation_error",
      message: "Phone must be in E.164 format (e.g. +14155551234).",
    };
  }

  // Email format (basic)
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return {
      code: "validation_error",
      message: "Email address is not valid.",
    };
  }

  // Consent sanity: subscribed status requires the destination
  if (input.email_status === "subscribed" && !email) {
    return {
      code: "validation_error",
      message: "Cannot mark email as subscribed without an email address.",
    };
  }
  if (input.sms_status === "subscribed" && !phone) {
    return {
      code: "validation_error",
      message: "Cannot mark SMS as subscribed without a phone number.",
    };
  }

  if (
    input.email_status !== undefined &&
    !VALID_CONSENT.has(input.email_status)
  ) {
    return {
      code: "validation_error",
      message: `Invalid email_status: ${input.email_status}.`,
    };
  }
  if (
    input.sms_status !== undefined &&
    !VALID_CONSENT.has(input.sms_status)
  ) {
    return {
      code: "validation_error",
      message: `Invalid sms_status: ${input.sms_status}.`,
    };
  }

  if (input.source !== undefined && !VALID_SOURCES.has(input.source)) {
    return {
      code: "validation_error",
      message: `Invalid source: ${input.source}.`,
    };
  }

  if (!input.owner_id) {
    return { code: "validation_error", message: "owner_id is required." };
  }

  return null;
}

export function validateUpdateContact(
  input: UpdateContactInput
): ContactsError | null {
  if (input.phone !== undefined && input.phone !== null) {
    const phone = input.phone.trim();
    if (!isValidE164(phone)) {
      return {
        code: "validation_error",
        message: "Phone must be in E.164 format (e.g. +14155551234).",
      };
    }
  }

  if (input.email !== undefined && input.email !== null) {
    const email = normalizeEmail(input.email)!;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return {
        code: "validation_error",
        message: "Email address is not valid.",
      };
    }
  }

  if (
    input.email_status !== undefined &&
    !VALID_CONSENT.has(input.email_status)
  ) {
    return {
      code: "validation_error",
      message: `Invalid email_status: ${input.email_status}.`,
    };
  }
  if (
    input.sms_status !== undefined &&
    !VALID_CONSENT.has(input.sms_status)
  ) {
    return {
      code: "validation_error",
      message: `Invalid sms_status: ${input.sms_status}.`,
    };
  }

  return null;
}

export function validateCreateAudience(
  input: CreateAudienceInput
): ContactsError | null {
  if (!input.owner_id) {
    return { code: "validation_error", message: "owner_id is required." };
  }
  if (!input.name || input.name.trim().length === 0) {
    return { code: "validation_error", message: "Audience name is required." };
  }
  if (!VALID_AUDIENCE_TYPES.has(input.type)) {
    return {
      code: "validation_error",
      message: `Invalid audience type: ${input.type}.`,
    };
  }
  if (input.type === "tag" && !input.tag_filter) {
    return {
      code: "validation_error",
      message: "tag_filter is required for tag audiences.",
    };
  }
  if (input.type !== "tag" && input.tag_filter) {
    return {
      code: "validation_error",
      message: "tag_filter is only allowed for tag audiences.",
    };
  }
  return null;
}

// ─── Normalisation helper exposed for server-data ──────────────────────────

export function normalizeContactInput(input: CreateContactInput): {
  email: string | null;
  phone: string | null;
} {
  return {
    email: normalizeEmail(input.email),
    phone: input.phone?.trim() ?? null,
  };
}

// ─── isDuplicateConstraint ──────────────────────────────────────────────────

/** Detect Postgres unique-constraint violations from Supabase error objects. */
export function isDuplicateConstraint(
  error: { code?: string; message?: string } | null | undefined,
  constraintName?: string
): boolean {
  if (!error) return false;
  if (error.code !== "23505") return false;
  if (constraintName) {
    return (error.message ?? "").includes(constraintName);
  }
  return true;
}
