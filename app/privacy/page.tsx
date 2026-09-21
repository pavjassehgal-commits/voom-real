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
    "How Voom collects, uses, shares, and protects data — including account and business data, connected social channels, OAuth credentials, content publishing, AI processing, email delivery, and your deletion rights.",
};

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      lead="This Privacy Policy explains what data Voom collects when you use the Voom automated marketing platform (the Service), why we collect it, who we share it with, and the choices and rights you have. Voom helps businesses plan, create, schedule, and publish marketing content across connected channels, powered by MARA, an AI marketing manager."
    >
      <LegalSection title="Account and business data">
        <p>
          When you create a Voom account we store your email address and the
          display name you choose. Your password is handled by our
          authentication provider (Supabase), which stores only a secure
          hash — Voom staff cannot see your password.
        </p>
        <p>
          As you set up and use the Service we also store your business
          profile, which may include your brand name, brand description,
          website, industry, target customer profile, marketing goals, brand
          personality, preferred channels, content cadence and frequency,
          monthly ad budget range, and automation preferences (such as Manual,
          Assisted, or Autopilot), together with your onboarding answers and
          workspace settings.
        </p>
      </LegalSection>

      <LegalSection title="Connected social accounts and OAuth credentials">
        <p>
          Voom enables you to connect social media and content distribution
          channels so you can prepare, schedule, and publish marketing content
          and review performance analytics. Connecting a channel requires your
          explicit authorization through that provider&apos;s standard OAuth flow.
        </p>
        <p>
          <b>Meta / Instagram:</b> When you connect Instagram, authorization is
          granted through Meta OAuth. Permissions requested include{" "}
          <b>instagram_business_basic</b>,{" "}
          <b>instagram_business_content_publish</b>, and{" "}
          <b>instagram_business_manage_insights</b>. For connected Instagram
          accounts, we store the Instagram user ID, username, display name,
          account type, profile picture URL, granted permissions, and token
          expiry date. We use this connection to publish user-approved posts,
          Reels, and stories, and to retrieve performance insights (such as
          reach, impressions, views, likes, comments, saves, shares, and
          interactions) where permitted by Meta APIs.
        </p>
        <p>
          <b>Google / YouTube:</b> When you connect YouTube, authorization is
          granted through Google OAuth under least-privilege scopes:{" "}
          <b>https://www.googleapis.com/auth/youtube.upload</b> (to upload and
          publish approved videos) and{" "}
          <b>https://www.googleapis.com/auth/youtube.readonly</b> (to read
          authoritative channel identity, video processing status, and public
          statistics such as view, like, and comment counts). Voom deliberately
          does not request scopes to edit or delete existing videos on your
          channel, and does not request monetary or revenue analytics scopes.
        </p>
        <p>
          <b>TikTok:</b> Voom&apos;s TikTok integration is being configured and
          tested in the TikTok developer sandbox. When authorized via TikTok
          OAuth under minimal required scopes (including basic user profile and
          video publishing), Voom uses TikTok&apos;s official Content Posting API
          to prepare, schedule, and publish video content directly to your
          TikTok account while respecting your chosen privacy level and posting
          preferences.
        </p>
        <p>
          <b>OAuth Token Security:</b> All provider OAuth access tokens, refresh
          tokens, and credentials are encrypted at rest using AES-256-GCM with
          encryption keys maintained securely on the server side. Tokens and
          provider secrets are never intentionally exposed or transmitted to
          browser clients.
        </p>
      </LegalSection>

      <LegalSection title="Google API Services and Limited Use disclosure">
        <p>
          Voom&apos;s use and transfer to any other app of information received
          from Google APIs will adhere to the{" "}
          <a
            href="https://developers.google.com/terms/api-services-user-data-policy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Google API Services User Data Policy
          </a>
          , including the Limited Use requirements.
        </p>
        <p>
          By connecting or publishing to YouTube through Voom, you also
          acknowledge and agree to be bound by the{" "}
          <a
            href="https://www.youtube.com/t/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            YouTube Terms of Service
          </a>{" "}
          and the{" "}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Google Privacy Policy
          </a>
          . You can view or revoke Voom&apos;s access to your Google account at
          any time via the{" "}
          <a
            href="https://myaccount.google.com/permissions"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Google Security Settings
          </a>{" "}
          page.
        </p>
      </LegalSection>

      <LegalSection title="Scheduled and published content metadata">
        <p>
          To maintain your content calendar and deliver automated marketing, we
          store metadata about planned and published actions. This includes
          publishing queue items, scheduled publication dates and times,
          execution statuses (such as queued, submitted, processing, published,
          or failed), provider publication references (such as Instagram media
          IDs, YouTube video IDs, or TikTok publish identifiers), and delivery
          event logs.
        </p>
        <p>
          Where provider APIs permit and permissions are granted, we retrieve
          and store available performance metrics (such as impressions, reach,
          views, likes, comments, saves, and shares) for published items so you
          can track campaign results in Voom and MARA can reference historical
          performance when suggesting future marketing plans. Voom never reads or
          shares another business&apos;s performance data.
        </p>
      </LegalSection>

      <LegalSection title="Marketing plans and content you create">
        <p>
          We store the content you and MARA create in Voom so the Service can
          operate. This includes your MARA conversations and messages, drafts
          (such as social captions, video concepts and scripts, email copy, and
          campaign plans), weekly marketing plans and content calendars,
          approval decisions and pending actions, automation settings, and
          campaign execution records.
        </p>
      </LegalSection>

      <LegalSection title="Media you provide or generate">
        <p>
          When you upload real-world media assets (photos, videos, audio, logos,
          or brand collateral) for content production, those files are securely
          stored and associated with your account and the related draft. If you
          use MARA media generation, we also store the prompts you supply and
          the images or videos generated for you.
        </p>
      </LegalSection>

      <LegalSection title="Contacts and audiences">
        <p>
          If you use Voom to manage email outreach, we store the contacts and
          audiences you add, including contact names, email addresses,
          subscription status, and audience membership. This includes contacts
          you import from CSV files. Email campaigns are only offered for
          contacts marked as subscribed with a valid email destination, and each
          send only happens after explicit user approval or in accordance with
          automation flows you have configured and enabled.
        </p>
        <p>
          Voom no longer offers SMS marketing; phone numbers and SMS consent
          captured by older accounts remain stored on the contact record for
          historical reference only and cannot be messaged.
        </p>
      </LegalSection>

      <LegalSection title="Email delivery data">
        <p>
          Campaign and automation emails are delivered through Resend. When you
          send an email campaign we pass the message content and the recipient
          email address to Resend for delivery, and we receive delivery status
          events (such as delivered, opened, or bounced) to keep your campaign
          records accurate. Account transactional emails (such as signup
          confirmations) are sent through our authentication provider. SMS
          marketing was removed from Voom; historical SMS delivery records, where
          they exist, remain stored read-only and are never used for new sends.
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
              scheduled background jobs (such as publish queue processing and
              planning runs) that keep the Service available.
            </>,
          ]}
        />
        <p>
          These infrastructure providers, connected social networks (Meta,
          Google, TikTok), email delivery services, and AI providers may
          process data in countries other than your own.
        </p>
      </LegalSection>

      <LegalSection title="How we use data and who we share it with">
        <p>
          We use your data to provide, operate, and secure the Service: to run
          your account, generate AI marketing content you request, schedule and
          publish approved posts and videos to your connected channels, dispatch
          email campaigns you approve or configure, maintain accurate delivery
          and audit records, display performance metrics, prevent abuse, and
          respond to your support requests. Where GDPR or similar laws apply,
          we rely on performance of our contract with you, compliance with
          legal obligations, legitimate interests in running and securing the
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

      <LegalSection title="Disconnecting integrations and provider revocation">
        <p>
          You can disconnect any connected social platform (Instagram, YouTube,
          TikTok) at any time from the Connections page in Voom. Disconnecting
          an integration immediately deletes or disables Voom&apos;s stored OAuth
          credentials locally, stops all future publishing and data
          synchronization, and withdraws pending unpublished items from the queue.
        </p>
        <LegalNote>
          Disconnecting an integration disables Voom&apos;s future access to your
          account, but does not automatically delete or remove content that has
          already been published to your social channels. Content published to
          Instagram, YouTube, or TikTok remains on those platforms until you
          manage or remove it there directly.
        </LegalNote>
        <p>
          You can also independently revoke Voom&apos;s access at any time
          through each provider&apos;s account permissions settings: Google
          Security Settings for YouTube, Meta Apps and Websites settings for
          Instagram, and TikTok account security settings for TikTok.
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
          function, until you delete it or ask us to delete it. Stored social
          OAuth tokens are deleted or invalidated when you disconnect an
          integration or when they expire. When data is deleted at your
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
          row-level security, encrypt OAuth tokens and secrets at rest with
          AES-256-GCM, and keep all provider credentials server-side only. No
          method of transmission or storage is completely secure, and we cannot
          guarantee absolute security; if we become aware of a security incident
          affecting your data, we will notify you in accordance with applicable
          laws.
        </p>
      </LegalSection>

      <LegalSection title="Your rights and choices">
        <LegalList
          items={[
            "Access and correct your profile, business settings, and contact data in the app at any time.",
            "Disconnect social integrations (Instagram, YouTube, TikTok) at any time from Connections, which revokes future provider access and removes stored credentials locally.",
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
          If you received an email (or, from an older Voom account, an SMS) that
          was sent through Voom by a business, that business controls your
          contact record. You can use the unsubscribe link in the email, ask the
          business directly to remove you, or contact us at <LegalEmailLink />{" "}
          and we will forward your request to the sending business and remove
          your destination from the delivery records we control where feasible.
        </p>
      </LegalSection>

      <LegalSection title="Children's privacy and eligibility">
        <p>
          Voom is a business software-as-a-service (SaaS) marketing platform
          intended strictly for commercial use by businesses and authorized
          representatives who are at least 16 years old (or the legal age of
          majority in their jurisdiction). The Service is not intended for or
          directed toward children under 16, and we do not knowingly collect
          data from children under 16. If you believe a minor has provided us
          with personal information, please contact us at <LegalEmailLink />.
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
