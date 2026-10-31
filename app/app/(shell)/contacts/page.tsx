import { PageHeader } from "@/components/voom/redesign/ui";
import { Icon } from "@/components/voom/icons";
import { ContactsWorkspace } from "@/components/voom/contacts/ContactsWorkspace";
import { loadContactsPage } from "@/lib/contacts/load";

export const dynamic = "force-dynamic";

export default async function ContactsPage() {
  const data = await loadContactsPage();
  if (!data) return null;

  return (
    <div className="min-w-0">
      <PageHeader
        eyebrow={<span className="text-[12px] font-semibold uppercase tracking-[0.16em]">Contacts</span>}
        title="Your audience in one place."
        subtitle={<>
          Every contact is owner-scoped, with explicit consent. Voom never emails them unless you send a campaign — no email is sent from this screen.
          <span className="mt-3 flex">
            <span className="inline-flex items-center gap-1.5 rounded-full bg-[var(--brand-soft)] px-3 py-1 text-[12.5px] font-semibold text-[var(--brand-ink)]">
              <Icon name="lock" size={13} /> Private to this workspace
            </span>
          </span>
        </>}
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
