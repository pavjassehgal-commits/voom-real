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
  title: "Data Deletion — Voom",
  description:
    "How to request deletion of your Voom account data — the request process, what gets deleted, how Instagram-connected data is handled, and the processing timeframe.",
};

export default function DataDeletionPage() {
  return (
    <LegalPage
      title="Data Deletion"
      lead="This page explains how to have your Voom account data deleted. Deletion requests are handled manually by the Voom team — there is currently no automated self-service deletion, so this page describes exactly how to ask us and what happens next."
    >
      <LegalSection title="What you can request">
        <LegalList
          items={[
            "Full account deletion — everything Voom stores about you and your business, described below.",
            "Partial deletion — a specific part of your data, such as your contacts and audiences, a set of drafts and plans, or your Instagram connection.",
            "Instagram disconnection alone — you can do this instantly yourself from Connections in the app, which removes the stored token.",
          ]}
        />
      </LegalSection>

      <LegalSection title="How to request deletion">
        <LegalNote>
          There is no automated deletion endpoint and no self-service delete
          button today. Requests are reviewed and carried out by a person.
        </LegalNote>
        <p>
          Email us at <LegalEmailLink /> from the email address associated with
          your Voom account, and include:
        </p>
        <LegalList
          items={[
            "the email address of your Voom account (sending from it is the simplest verification);",
            "the business or brand name on the account;",
            "what you want deleted — the whole account, or the specific data.",
          ]}
        />
        <p>
          If you cannot send from the account email, tell us the account email
          in your message; we may ask you to confirm details already on the
          account to verify that you own it. We do not ask for passwords or
          payment information.
        </p>
      </LegalSection>

      <LegalSection title="Processing timeframe">
        <p>
          Once a request is verified, we aim to complete it within{" "}
          <b className="text-text">30 days</b>, and we will email you at the
          account address to confirm what was deleted. If a request is unclear
          or needs verification, we will contact you first, and the 30-day
          clock starts once the request is verified.
        </p>
      </LegalSection>

      <LegalSection title="What gets deleted">
        <p>For a full account deletion, we delete:</p>
        <LegalList
          items={[
            "your account profile (email address and display name) and login;",
            "your business profile, onboarding answers, and settings;",
            "MARA conversations, drafts, marketing plans, weekly content calendars, and approval history;",
            "campaign records and their delivery statuses;",
            "your contacts, audiences, and imported contact data;",
            "assets you uploaded and media generated for you;",
            "your Instagram connection — see the next section.",
          ]}
        />
      </LegalSection>

      <LegalSection title="Instagram-connected data">
        <p>
          Deleting your account (or requesting deletion of the connection)
          removes the Instagram account record, the encrypted access token, and
          the Instagram media and insights data Voom read, from our systems.
        </p>
        <p>
          Voom cannot delete anything held by Instagram or Meta themselves. To
          end Voom access immediately, disconnect it in the app, and to review
          or revoke app permissions independently, use the apps and websites
          settings in your Instagram account. Content you posted on Instagram
          stays on Instagram until you delete it there.
        </p>
      </LegalSection>

      <LegalSection title="What we may keep">
        <p>
          A small amount of data may outlive deletion: backup copies may
          persist for a limited period until they are overwritten; we keep
          records where the law requires it (for example records needed to
          prevent fraud or abuse); and de-identified, aggregate statistics that
          no longer point to you or your business. Emails (and, for older accounts, historical SMS records)
          already delivered on your behalf cannot be recalled, and Resend and
          ClickSend retain their own delivery logs under their own policies.
        </p>
      </LegalSection>

      <LegalSection title="If you are a contact of a Voom customer">
        <p>
          If you received an email (or, from an older Voom account, an SMS) sent through Voom by a business and
          want your details removed, email us at <LegalEmailLink /> with the
          sending business and the address or number contacted. We will forward
          your request to that business and remove your destination from the
          delivery records we control where feasible.
        </p>
      </LegalSection>

      <LegalSection title="Contact">
        <p>
          Deletion requests and questions: <LegalEmailLink />. See also our{" "}
          <Link
            href="/privacy"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Privacy Policy
          </Link>{" "}
          and{" "}
          <Link
            href="/terms"
            className="font-medium text-brand underline underline-offset-2 transition hover:decoration-2"
          >
            Terms of Service
          </Link>
          .
        </p>
      </LegalSection>
    </LegalPage>
  );
}
