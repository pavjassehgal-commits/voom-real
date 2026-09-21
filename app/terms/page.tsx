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
  title: "Terms of Service — Voom",
  description:
    "The terms for using Voom and MARA — automated marketing platform, connected social channels, publishing authorization, AI content review, acceptable use, billing, and disclaimers.",
};

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      lead="These Terms of Service (Terms) govern your use of the Voom automated marketing platform, including the MARA AI marketing manager, the website, and all related tools and features (together, the Service). By creating an account or using the Service you agree to these Terms."
    >
      <LegalSection title="The Service">
        <p>
          Voom is an automated marketing platform designed for businesses.
          MARA, its AI marketing manager, helps you plan marketing strategies,
          draft and produce content (such as social posts, video concepts and
          scripts, and email messages), manage weekly content calendars, and
          publish marketing across connected channels.
        </p>
        <p>
          The Service supports different operational automation modes:
        </p>
        <LegalList
          items={[
            <>
              <b>Manual:</b> You directly create, schedule, approve, and
              trigger each marketing campaign and publication.
            </>,
            <>
              <b>Assisted:</b> MARA prepares marketing plans, content drafts,
              and schedules for you; nothing is published or dispatched without
              your explicit review and approval.
            </>,
            <>
              <b>Autopilot:</b> The Service automatically plans, schedules,
              and executes marketing actions according to the parameters,
              brand rules, cadence, and content preferences you configure and
              activate.
            </>,
          ]}
        />
        <LegalNote>
          Billing status: The Service is currently provided free of charge
          during our current product release stage. Pricing screens shown in the
          app are demonstrations of future plan tiers, and no payment or credit
          card is collected today.
        </LegalNote>
      </LegalSection>

      <LegalSection title="Your account">
        <p>
          You must be at least 16 years old (or the legal age of majority in
          your jurisdiction required to enter into binding agreements) to use
          the Service. You agree to provide accurate information for your
          account and business profile, keep your login credentials secure, and
          remain responsible for all activity under your account.
        </p>
      </LegalSection>

      <LegalSection title="Connected third-party accounts and publishing authorization">
        <p>
          The Service allows you to connect third-party platforms (such as
          Instagram, YouTube, and TikTok) via OAuth to schedule and publish
          content and view performance data.
        </p>
        <p>
          When you connect a third-party account, you represent and warrant that
          you own or are authorized to manage that account and have all rights
          necessary to authorize Voom to access it. By approving content,
          setting up automated schedules, or activating Autopilot publishing,
          you authorize Voom to publish your approved content, videos, media,
          and metadata to the designated platforms on your behalf.
        </p>
        <p>
          You can disconnect any integration at any time from Connections in the
          app, which disables Voom&apos;s access and deletes stored OAuth
          credentials locally. Disconnecting stops future publishing actions,
          but does not automatically delete content that has already been
          published to your social accounts.
        </p>
      </LegalSection>

      <LegalSection title="Third-party platform rules and API availability">
        <p>
          Your use of connected accounts is subject to the terms of service,
          developer policies, and community guidelines of each respective
          platform, including the Meta / Instagram Terms of Use, YouTube Terms
          of Service, Google Privacy Policy, and TikTok Terms of Service.
        </p>
        <p>
          <b>YouTube Terms:</b> By connecting or publishing to a YouTube
          channel through Voom, you agree to be bound by the{" "}
          <a
            href="https://www.youtube.com/t/terms"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            YouTube Terms of Service
          </a>{" "}
          and acknowledge the{" "}
          <a
            href="https://policies.google.com/privacy"
            target="_blank"
            rel="noopener noreferrer"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Google Privacy Policy
          </a>
          .
        </p>
        <p>
          Third-party platforms operate independently. They may review, reject,
          demote, restrict, or remove content at their discretion, change API
          rate limits or permissions, or modify feature availability. Voom is
          not responsible for platform enforcement actions, content removals,
          or third-party API downtime or modifications.
        </p>
      </LegalSection>

      <LegalSection title="Your responsibilities and content">
        <LegalList
          items={[
            "You retain full responsibility for all content, assets, and business information you upload, generate, approve, schedule, or publish through the Service, whether in Manual, Assisted, or Autopilot mode.",
            "You must hold all necessary rights, licenses, and permissions for any text, images, video, music, or other media you supply or publish.",
            "You must ensure your content complies with all applicable laws, regulations, and advertising disclosure standards (including FTC guidelines and consumer protection laws).",
            "You must have the right to market to the contacts you add or import, including any consent required under the anti-spam, marketing, and data protection laws that apply to you, and for honoring opt-out and unsubscribe requests from your contacts.",
          ]}
        />
      </LegalSection>

      <LegalSection title="AI content and human review">
        <p>
          Content produced by MARA and our media generation tools is created
          using artificial intelligence. Generative AI may produce inaccurate,
          incomplete, or unsuitable statements (including statements about your
          business, products, or competitors).
        </p>
        <p>
          You are responsible for reviewing, configuring, and verifying all
          AI-generated text, media, and campaign settings before approving or
          authorizing them for publication or dispatch. Voom does not warrant
          the accuracy, originality, or legal compliance of AI-generated
          content.
        </p>
      </LegalSection>

      <LegalSection title="No guaranteed marketing results">
        <p>
          Voom and MARA provide marketing planning, drafting, scheduling, and
          automation software, not guaranteed business outcomes. We do not
          guarantee any specific reach, impressions, views, engagement, follower
          growth, click-through rates, leads, sales, revenue, or return on
          spend. Marketing performance depends on your audience, industry,
          offerings, market dynamics, and third-party platform algorithms
          outside our control.
        </p>
      </LegalSection>

      <LegalSection title="Acceptable use">
        <p>You agree not to:</p>
        <LegalList
          items={[
            "use the Service for any unlawful, fraudulent, deceptive, or malicious purpose;",
            "send spam, unsolicited bulk email, or communicate with contacts without a lawful basis;",
            "upload, schedule, or publish content that is infringing, defamatory, harassing, sexually explicit, hateful, or otherwise prohibited by law or platform guidelines;",
            "impersonate another person, entity, or brand without authorization;",
            "attempt to probe, compromise, overload, disrupt, or circumvent security measures or rate limits of the Service or its providers;",
            "reverse engineer, decompile, scrape, or resell the Service or build a competing product from it;",
            "distribute malware, viruses, or harmful code through the Service.",
          ]}
        />
      </LegalSection>

      <LegalSection title="Your content and licenses">
        <p>
          You own your content — including your brand information, contact
          lists, uploaded media, and approved marketing materials. You grant
          Voom a limited, non-exclusive license to host, process, reproduce,
          format, and transmit your content solely to operate and provide the
          Service for you (such as transmitting content to connected social
          networks, email providers, and configured AI services). We do not
          train our own AI models on your proprietary content.
        </p>
      </LegalSection>

      <LegalSection title="Third-party services">
        <p>
          The Service depends on third-party providers, including Supabase,
          Vercel, Resend, Meta (Instagram), Google (YouTube), TikTok, and
          AI providers. SMS marketing is no longer part of Voom and no SMS
          delivery provider is used; historical SMS records remain stored as
          read-only data.
        </p>
        <p>
          Each provider operates under its own terms and service levels. Voom is
          not responsible for failures, interruptions, or actions of these
          third-party providers.
        </p>
      </LegalSection>

      <LegalSection title="Billing">
        <p>
          The Service is currently provided free of charge. If we introduce
          paid plans, we will present the pricing, what the plan includes, and
          any renewal and refund terms clearly before you commit, and any fees
          will be disclosed at the point of purchase. Prices may exclude taxes,
          which you are responsible for where applicable.
        </p>
      </LegalSection>

      <LegalSection title="Termination">
        <p>
          You may stop using the Service and ask us to delete your account data
          at any time — see the{" "}
          <Link
            href="/data-deletion"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Data Deletion
          </Link>{" "}
          page. We may suspend or terminate your access for breach of these
          Terms, abusive or unlawful use, non-compliance with third-party platform
          rules, or if we discontinue a feature or the Service. Where
          reasonable, we will provide notice. Sections that by their nature
          should survive (including content responsibilities, disclaimers, and
          liability limits) survive termination.
        </p>
      </LegalSection>

      <LegalSection title="Disclaimers">
        <p>
          The Service is provided &quot;as is&quot; and &quot;as available.&quot;
          Some features are early-stage and may change, pause, or be
          discontinued. To the maximum extent permitted by law, Voom disclaims
          all warranties, express or implied, including merchantability,
          fitness for a particular purpose, non-infringement, and uninterrupted
          operation.
        </p>
      </LegalSection>

      <LegalSection title="Limitation of liability">
        <p>
          To the maximum extent permitted by law, Voom will not be liable for
          indirect, incidental, special, consequential, or punitive damages, or
          for lost profits, revenues, data, or business opportunities. Our
          aggregate liability for claims relating to the Service is limited to
          the greater of the amount you paid us in the twelve months before the
          claim or USD 100.
        </p>
      </LegalSection>

      <LegalSection title="Changes to these Terms">
        <p>
          We may update these Terms as the Service evolves. The date at the top
          of this page shows when they were last updated, and material changes
          will be notified in the app or by email. Continuing to use the
          Service after a change means you accept the updated Terms.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Questions about these Terms? Email us at <LegalEmailLink />. You can
          also read our{" "}
          <Link
            href="/privacy"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Privacy Policy
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
