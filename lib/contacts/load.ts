import "server-only";

import { createClient } from "@/utils/supabase/server";
import { getCurrentUser } from "@/lib/voom/server-data";
import { resolveAudienceContacts } from "./server-data";
import type { AudienceRecord, ContactRecord } from "./types";

export interface ContactsSummary {
  total: number;
  emailSubscribers: number;
  smsSubscribers: number;
  unsubscribed: number;
  unknownConsent: number;
}

export interface ContactsLoadResult {
  userId: string;
  contacts: ContactRecord[];
  audiences: AudienceRecord[];
  audienceSizes: Record<string, number>;
  summary: ContactsSummary;
}

const EMPTY_SUMMARY: ContactsSummary = {
  total: 0,
  emailSubscribers: 0,
  smsSubscribers: 0,
  unsubscribed: 0,
  unknownConsent: 0,
};

/**
 * Load all data the /app/contacts page needs in one server-side round trip.
 * Owner-scoped via auth.uid(). Returns null if there is no session.
 */
export async function loadContactsPage(): Promise<ContactsLoadResult | null> {
  const user = await getCurrentUser();
  if (!user) return null;

  const db = await createClient();

  // Pull up to 500 contacts and 200 audiences for the workspace.
  // The owner-scoping here is the same predicate that RLS uses; doing it
  // explicitly in the query keeps the payload small and predictable.
  const [contactsRes, audiencesRes] = await Promise.all([
    db
      .from("contacts")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false })
      .limit(500),
    db
      .from("audiences")
      .select("*")
      .eq("owner_id", user.id)
      .order("created_at", { ascending: false })
      .limit(200),
  ]);

  const contacts = (contactsRes.data ?? []) as ContactRecord[];
  const audiences = (audiencesRes.data ?? []) as AudienceRecord[];

  const summary = computeSummary(contacts);

  // Audience sizes — reuse resolveAudienceContacts so we never duplicate
  // the eligibility rules in UI code. We run them in parallel for speed.
  const audienceSizes: Record<string, number> = {};
  await Promise.all(
    audiences.map(async (audience) => {
      const result = await resolveAudienceContacts(db, user.id, audience.id);
      audienceSizes[audience.id] = result.ok ? result.data.length : 0;
    }),
  );

  return { userId: user.id, contacts, audiences, audienceSizes, summary };
}

function computeSummary(contacts: ContactRecord[]): ContactsSummary {
  if (contacts.length === 0) return EMPTY_SUMMARY;
  const s: ContactsSummary = {
    total: contacts.length,
    emailSubscribers: 0,
    smsSubscribers: 0,
    unsubscribed: 0,
    unknownConsent: 0,
  };
  for (const c of contacts) {
    // SMS marketing was removed from the active product; the workspace KPIs
    // describe the active email channel only. sms_status is still stored on
    // historical contact rows and never deleted here.
    if (c.email_status === "subscribed") s.emailSubscribers++;
    if (c.sms_status === "subscribed") s.smsSubscribers++;
    if (c.email_status === "unsubscribed") s.unsubscribed++;
    if (c.email_status === "unknown") s.unknownConsent++;
  }
  return s;
}
