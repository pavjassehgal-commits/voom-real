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
            "Partial deletion — a specific part of your data, such as your contacts and audiences, a set of drafts and plans, or your connected social accounts.",
            "Social account disconnection alone — you can do this instantly yourself from Connections in the app, which removes the stored tokens.",
          ]}
        />
      </LegalSection>

      <LegalSection title="How to request deletion">
        <LegalNote>
          Full-account deletion requests are reviewed and carried out by a
          person. YouTube disconnection removes the related YouTube API data
          automatically; it is not a full Voom account deletion.
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
          <b>YouTube API data:</b> We handle deletion requests as soon as
          possible and within seven calendar days of the request, including when you request
          account deletion; ownership verification does not restart that deadline.
          We promptly verify ownership without asking for
          passwords or tokens. Disconnecting YouTube in Voom blocks further
          access and initiates removal of its stored API data. If removal fails,
          access remains blocked while maintenance retries it. Confirmed
          invalid Google authorization also triggers removal, with continued
          authorization checked by the existing YouTube maintenance worker.
        </p>
        <p>
          For other Voom account data, once a request is verified, we aim to complete it within{" "}
          <b className="text-text">30 days</b>, and we will email you at the
          account address to confirm what was deleted. If a request is unclear
          or needs verification, we will contact you first, and the 30-day
          clock starts once the request is verified.
        </p>
      </LegalSection>

      <LegalSection title="YouTube data and original content">
        <p>
          YouTube data deletion removes stored channel details, encrypted
          publishing credentials, OAuth state, upload sessions and publishing
          history, returned YouTube video references and performance snapshots.
          Your own Voom drafts, captions, schedules and original uploaded or
          generated media are preserved unless you request their deletion too.
          Previous YouTube approvals are withdrawn so unsent drafts need fresh
          review after reconnection. Other platforms and other customers are not affected.
        </p>
        <p>
          A minimal Voom-only draft/action identifier may remain to prevent a
          previously submitted or uncertain video from being uploaded again;
          it contains no YouTube video ID, channel ID or analytics. Reconnecting
          does not restore erased history or automatically resubmit old jobs.
          A video already sent to YouTube may finish processing there. To delete
          videos on YouTube itself, use YouTube directly.
        </p>
        <p>
          If Google revocation temporarily fails, a server-only encrypted
          revocation task is retried without allowing publishing. Its retry
          credential expires after six days and is cleared by maintenance; unconfirmed
          revocation is flagged for operator attention. You can also revoke
          access directly in your Google Account permissions settings.
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
            "your connected social accounts — see the next section.",
          ]}
        />
      </LegalSection>

      <LegalSection title="Instagram-connected data">
        <p>
          Deleting your account (or requesting deletion of a connection)
          removes the Instagram account record, the encrypted access token, and
          the Instagram media and insights data Voom read, from our systems. The
          same applies to other connected social channels (such as YouTube and
          TikTok): deleting your account removes stored credentials and channel
          records.
        </p>
        <p>
          Voom cannot delete anything held by Instagram or Meta themselves (or
          Google or TikTok). To end Voom access immediately, disconnect it in
          the app, and to review or revoke app permissions independently, use
          the apps and websites settings in your Instagram account, Google
          Security Settings, or TikTok privacy settings. Content you posted on
          Instagram stays on Instagram until you delete it there.
        </p>
      </LegalSection>

      <LegalSection title="What we may keep">
        <p>
          A small amount of data may outlive deletion: backup copies may
          persist for a limited period until they are overwritten; we keep
          records where the law requires it (for example records needed to
          prevent fraud or abuse); and de-identified, aggregate statistics that
          no longer point to you or your business. Emails (and, for older
          accounts, historical SMS records) already delivered on your behalf
          cannot be recalled, and Resend retains its own delivery logs under
          its own policies.
        </p>
      </LegalSection>

      <LegalSection title="If you are a contact of a Voom customer">
        <p>
          If you received an email (or, from an older Voom account, an SMS) sent
          through Voom by a business and want your details removed, email us at{" "}
          <LegalEmailLink /> with the sending business and the address or number
          contacted. We will forward your request to that business and remove
          your destination from the delivery records we control where feasible.
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
