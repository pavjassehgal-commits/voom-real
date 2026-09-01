import { PageHead } from "@/components/voom/shell/AppShell";
import { ContactsWorkspace } from "@/components/voom/contacts/ContactsWorkspace";
import { loadContactsPage } from "@/lib/contacts/load";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const data = await loadContactsPage();
  if (!data) return null;

  return (
    <div>
      <PageHead
        title="Contacts"
        description="Your audience in one place — every contact owner-scoped, with explicit consent. No email or SMS is sent from this screen."
        tags={
          <span className="inline-flex items-center gap-1.5 rounded-[7px] bg-[var(--brand-soft)] px-2.5 py-[3px] text-[11.5px] font-semibold text-brand">
            Workspace only
          </span>
        }
      />
      <ContactsWorkspace
        initialContacts={data.contacts}
        initialAudiences={data.audiences}
        initialAudienceSizes={data.audienceSizes}
        initialSummary={data.summary}
      />
    </div>
  );
}
