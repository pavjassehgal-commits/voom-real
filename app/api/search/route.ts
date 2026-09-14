import { getCurrentUser } from "@/lib/voom/server-data";
import { createClient } from "@/utils/supabase/server";

export const runtime = "nodejs";

/**
 * Real app search over the data that actually exists for the signed-in owner:
 * content drafts, calendar items, campaigns, contacts and audiences.
 *
 * Every query is owner-scoped explicitly AND runs through the user's RLS-
 * protected client, so a search can never surface another account's rows.
 * No invented results: sections only appear when they have matches.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SearchHit {
  id: string;
  title: string;
  subtitle: string;
  href: string;
}

const MAX_PER_GROUP = 5;

export async function GET(request: Request) {
  const user = await getCurrentUser();
  if (!user) return Response.json({ error: "Please log in again." }, { status: 401 });

  const url = new URL(request.url);
  const raw = (url.searchParams.get("q") ?? "").trim().slice(0, 80);
  if (raw.length < 2) return Response.json({ groups: [] });

  // Neutralise LIKE pattern characters so user input is always a literal.
  const term = raw.replace(/[%_\\]/g, (match) => `\\${match}`);
  const like = `%${term}%`;

  try {
    const db = await createClient();
    const [drafts, calendar, campaigns, contacts, audiences] = await Promise.all([
      db.from("mara_drafts")
        .select("id,title,content,updated_at")
        .eq("owner_user_id", user.id)
        .or(`title.ilike.${like},content.ilike.${like}`)
        .order("updated_at", { ascending: false })
        .limit(MAX_PER_GROUP),
      db.from("content_calendar_items")
        .select("id,title,content,publish_at,status")
        .eq("owner_user_id", user.id)
        .or(`title.ilike.${like},content.ilike.${like}`)
        .order("publish_at", { ascending: false })
        .limit(MAX_PER_GROUP),
      db.from("voom_campaigns")
        .select("id,name,subject,content,kind,is_automated,parent_campaign_id,updated_at")
        .eq("owner_user_id", user.id)
        // Automated child email campaigns appear on the campaign timeline,
        // not as standalone search results.
        .is("parent_campaign_id", null)
        .or(`name.ilike.${like},subject.ilike.${like},content.ilike.${like}`)
        .order("updated_at", { ascending: false })
        .limit(MAX_PER_GROUP),
      db.from("contacts")
        .select("id,first_name,last_name,email,phone,tags,created_at")
        .eq("owner_id", user.id)
        .or(`first_name.ilike.${like},last_name.ilike.${like},email.ilike.${like},phone.ilike.${like},tags.ilike.${like}`)
        .order("created_at", { ascending: false })
        .limit(MAX_PER_GROUP),
      db.from("audiences")
        .select("id,name,description,updated_at")
        .eq("owner_id", user.id)
        .or(`name.ilike.${like},description.ilike.${like}`)
        .order("updated_at", { ascending: false })
        .limit(MAX_PER_GROUP),
    ]);

    const groups: { label: string; href: string; items: SearchHit[] }[] = [];
    const trim = (value: unknown, max = 90): string => {
      const text = String(value ?? "").replace(/\s+/g, " ").trim();
      return text.length > max ? `${text.slice(0, max - 1)}…` : text;
    };

    const draftItems = (drafts.data ?? []).filter((row) => UUID_RE.test(String(row.id))).map((row) => ({
      id: String(row.id),
      title: trim(row.title) || "Untitled content",
      subtitle: trim(row.content, 70) || "Content draft",
      href: "/app/studio",
    }));
    if (draftItems.length) groups.push({ label: "Content", href: "/app/studio", items: draftItems });

    const calendarItems = (calendar.data ?? []).filter((row) => UUID_RE.test(String(row.id))).map((row) => ({
      id: String(row.id),
      title: trim(row.title) || "Calendar item",
      subtitle: `${row.status === "scheduled" ? "Scheduled" : "Planned"}${row.publish_at ? ` · ${new Date(String(row.publish_at)).toLocaleDateString("en-AE", { timeZone: "Asia/Dubai", day: "numeric", month: "short" })}` : ""}`,
      href: "/app/calendar",
    }));
    if (calendarItems.length) groups.push({ label: "Calendar", href: "/app/calendar", items: calendarItems });

    const campaignItems = (campaigns.data ?? []).filter((row) => UUID_RE.test(String(row.id))).map((row) => ({
      id: String(row.id),
      title: trim(row.name) || "Untitled campaign",
      subtitle: `${String(row.kind) === "sms" ? "Archived SMS" : String(row.kind) === "multi" ? "Campaign" : "Email"} · ${trim(row.subject || row.content, 60) || "No content yet"}`,
      href: "/app/campaigns",
    }));
    if (campaignItems.length) groups.push({ label: "Campaigns", href: "/app/campaigns", items: campaignItems });

    const contactItems = (contacts.data ?? []).filter((row) => UUID_RE.test(String(row.id))).map((row) => {
      const name = [row.first_name, row.last_name].filter(Boolean).join(" ");
      return {
        id: String(row.id),
        title: name || trim(row.email) || trim(row.phone) || "Contact",
        subtitle: trim(row.email || row.phone || (Array.isArray(row.tags) ? row.tags.join(", ") : ""), 70),
        href: "/app/contacts",
      };
    });
    if (contactItems.length) groups.push({ label: "Contacts", href: "/app/contacts", items: contactItems });

    const audienceItems = (audiences.data ?? []).filter((row) => UUID_RE.test(String(row.id))).map((row) => ({
      id: String(row.id),
      title: trim(row.name) || "Audience",
      subtitle: trim(row.description, 70),
      href: "/app/contacts",
    }));
    if (audienceItems.length) groups.push({ label: "Audiences", href: "/app/contacts", items: audienceItems });

    return Response.json({ groups, query: raw }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Search couldn't load right now. Please try again." }, { status: 503 });
  }
}
