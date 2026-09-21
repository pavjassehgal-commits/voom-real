/**
 * Single source of truth for the public contact address and dates shown on
 * Voom's legal pages (Privacy Policy, Terms of Service, Data Deletion).
 *
 * IMPORTANT: this must be a real, monitored mailbox before the legal pages
 * are linked publicly — every legal page imports SUPPORT_EMAIL from here, so
 * the address only ever needs to be changed in this one file.
 *
 * Confirmed as the Voom support address on 2026-09-05.
 */
export const SUPPORT_EMAIL = "support@voom.app";

/** Date the legal pages were last materially updated (shown on every page). */
export const LEGAL_LAST_UPDATED = "September 21, 2026";
