import type { Metadata } from "next";
import Link from "next/link";
import {
  LegalEmailLink,
  LegalList,
  LegalNote,
  LegalPage,
  LegalSection,
} from "../components/legal";

export const metadata: Metadata = {
  title: "Privacy Policy — Voom",
  description:
    "How Voom collects, uses, shares, and protects data — including account and business data, Instagram connections, AI processing, email and SMS delivery, and your deletion rights.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lead="This Privacy Policy explains what data Voom collects when you use the Voom marketing platform (the Service), why we collect it, who we share it with, and the choices and rights you have. Voom is a marketing platform for small businesses, powered by MARA, an AI marketing manager that plans, drafts, and reports on your campaigns."
    >
      <LegalSection title="Account and business data">
        <p>
          When you create a Voom account we store your email address and the
          display name you choose. Your password is handled by our
          authentication provider (Supabase), which stores only a secure hash —
          Voom staff cannot see your password.
        </p>
        <p>
          As you set up and use the Service we also store your business
          profile, which may include your brand name, brand description,
          website, industry, target customers, marketing goals, brand
          personality, preferred channels, content frequency, monthly ad budget
          range, and automation preferences, together with your onboarding
          answers and product settings.
        </p>
      </LegalSection>

      <LegalSection title="Instagram connection data">
        <p>
          If you choose to connect an Instagram account, the connection is
          authorized through Instagram (Meta) using OAuth. The permissions
          requested are <b>instagram_business_basic</b>,{" "}
          <b>instagram_business_content_publish</b> and{" "}
          <b>instagram_business_manage_insights</b>. For a connected account we
          store the Instagram user ID, username, display name, account type,
          profile picture URL, the permissions granted, and the token expiry
          date. The Instagram access token is stored encrypted at rest
          (AES-256-GCM) with an encryption key held server-side.
        </p>
        <p>
          We use the connection to read basic account information, your
          Instagram media, and insights (reach, views, likes, comments, saves,
          shares and interactions) for content Voom published for you, so Voom
          can show your performance inside the Service and use it when planning
          future content. Voom never reads another business&apos;s data.
        </p>
        <LegalNote>
          Voom does not currently publish to Instagram on your behalf.
          Approving content in Voom approves a draft only — no post or Reel is
          published to Instagram by Voom today. You can disconnect Instagram at
          any time from Connections, which removes the stored token.
        </LegalNote>
      </LegalSection>

      <LegalSection title="Marketing plans and content you create">
        <p>
          We store the content you and MARA create in Voom so the Service can
          operate. This includes your MARA conversations and messages, drafts
          (such as Instagram captions, Reel concepts and scripts, emails, SMS
          messages, and campaign plans), weekly marketing plans and content
          calendars, approval decisions and pending actions, and campaign
          records with their delivery statuses.
        </p>
      </LegalSection>

      <LegalSection title="Media you provide or generate">
        <p>
          When you upload real-world assets for Reel production, those files
          are stored and associated with your account and the related draft. If
          you use MARA media generation, we also store the prompts you supply
          and the images or videos that are generated for you.
        </p>
      </LegalSection>

      <LegalSection title="Contacts and audiences">
        <p>
          If you use Voom to manage outreach, we store the contacts and
          audiences you add, including contact names, email addresses, phone
          numbers, subscription status, and audience membership. This includes
          contacts you import from a CSV file. Email and SMS campaigns are only
          offered for contacts marked as subscribed with a valid destination,
          and each send only happens after you explicitly approve and trigger
          it.
        </p>
      </LegalSection>

      <LegalSection title="Email and SMS delivery data">
        <p>
          Campaign emails are delivered through Resend and campaign SMS
          messages through ClickSend. When you send a campaign we pass the
          message content and the recipient destination to the relevant
          provider so it can be delivered, and we receive delivery status
          events back (such as delivered or bounced) to keep your campaign
          records accurate. Account emails (such as signup confirmation) are
          sent through our authentication provider.
        </p>
      </LegalSection>

      <LegalSection title="AI providers">
        <p>
          MARA is powered by third-party AI providers. The Service is
          configured with one provider at a time, which may be Groq, OpenAI,
          Google (Gemini), NVIDIA, or a compatible endpoint you supply. When
          you chat with MARA or generate media, your message, the relevant
          parts of your brand and business context, and any content you
          reference are sent to the configured provider in order to generate
          the response or media.
        </p>
        <p>
          AI providers process data under their own terms and privacy policies,
          which govern how they handle inputs. Voom does not train its own
          models on your data.
        </p>
      </LegalSection>

      <LegalSection title="Hosting and infrastructure">
        <LegalList
          items={[
            <>
              <b className="text-text">Supabase</b> — authentication and the
              primary database that stores your account and content data,
              protected by row-level security so accounts can only access
              their own data.
            </>,
            <>
              <b className="text-text">Vercel</b> — hosting, compute, and
              scheduled jobs (such as the weekly planning run) that keep the
              Service available.
            </>,
          ]}
        />
        <p>
          These providers and the delivery and AI providers listed above may
          process data in countries other than your own.
        </p>
      </LegalSection>

      <LegalSection title="How we use data and who we share it with">
        <p>
          We use your data to provide, operate, and secure the Service: to run
          your account, generate AI output you ask for, send the campaigns you
          explicitly approve, maintain accurate delivery records, prevent abuse,
          and respond to your requests. Where GDPR or similar laws apply, we
          rely on performance of our contract with you, compliance with legal
          obligations, legitimate interests in running and securing the
          Service, and — for outgoing marketing sends — the consent your
          business records for each contact.
        </p>
        <p>
          We share data only with the providers described in this Policy, to
          the extent needed to run the Service, or when required by law.{" "}
          <b className="text-text">
            We do not sell your personal data, and we do not share it for
            third-party advertising.
          </b>
        </p>
      </LegalSection>

      <LegalSection title="Cookies and local storage">
        <p>
          Voom sets session cookies that keep you logged in. We do not
          currently use analytics, advertising, or other third-party tracking
          cookies or pixels. Your light/dark interface preference is stored in
          your browser local storage and never leaves your device.
        </p>
      </LegalSection>

      <LegalSection title="Retention">
        <p>
          We keep your data while your account is active so the Service can
          function, until you delete it or ask us to. Instagram tokens are kept
          until you disconnect or they expire. When data is deleted at your
          request, residual copies may remain in backups for a limited period
          before being overwritten. We may retain de-identified, aggregate
          statistics that no longer identify you or your business.
        </p>
        <p>
          For how to have your data deleted, see the{" "}
          <Link
            href="/data-deletion"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Data Deletion
          </Link>{" "}
          page.
        </p>
      </LegalSection>

      <LegalSection title="Security">
        <p>
          We protect data in transit with HTTPS, scope database access with
          row-level security, encrypt Instagram tokens at rest, and keep
          provider secrets on the server side only. No method of transmission
          or storage is completely secure, and we cannot guarantee absolute
          security; if we become aware of a breach affecting your data we will
          notify you.
        </p>
      </LegalSection>

      <LegalSection title="Your rights and choices">
        <LegalList
          items={[
            "Access and correct your profile, business, and contact data in the app at any time.",
            "Disconnect Instagram at any time from Connections, which removes the stored token.",
            "Delete contacts and stop future sends from your contacts workspace.",
            "Request deletion of your account data — see the Data Deletion page for the process and timing.",
            "Depending on your location, you may also have rights to access, rectification, erasure, restriction, portability, and objection, and the right to lodge a complaint with a supervisory authority. If you are in California, you have the right to know and delete personal information and to opt out of its sale — Voom does not sell personal information.",
          ]}
        />
        <p>
          To exercise any right, contact us at <LegalEmailLink />. We may ask
          you to confirm information already on your account to verify the
          request.
        </p>
      </LegalSection>

      <LegalSection title="If you are a contact of a Voom customer">
        <p>
          If you received an email or SMS that was sent through Voom by a
          business, that business controls your contact record. You can ask
          them to remove you, or contact us at <LegalEmailLink /> and we will
          forward your request to the sending business and remove your
          destination from the delivery records we control where feasible.
        </p>
      </LegalSection>

      <LegalSection title="Children">
        <p>
          Voom is a business tool and is not intended for anyone under 16. We
          do not knowingly collect data from children under 16.
        </p>
      </LegalSection>

      <LegalSection title="Changes to this Policy">
        <p>
          We may update this Privacy Policy as the Service changes. The date at
          the top of this page shows when it was last updated, and we will
          notify you in the app or by email for material changes.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about this Policy or your data? Email us at{" "}
          <LegalEmailLink />.
        </p>
      </LegalSection>
    </LegalPage>
  );
}
