import { emailDocument } from "./core";

/**
 * The single source for Voom's four Supabase Auth email templates.
 * `scripts/prepare-voom-auth-emails.mjs` writes them to supabase/templates/
 * voom-auth (Production) and voom-auth-staging, and the tests re-render them
 * here to prove the committed files never drift from this definition.
 *
 * PLANNED_SUPPORT_EMAIL is NOT YET VERIFIED. As of 2026-11-21 no
 * support@voom.today mailbox has been confirmed to exist, receive mail or be
 * monitored. The password-changed and email-changed templates that name it
 * MUST NOT be installed in Supabase, and those notifications MUST NOT be
 * enabled, until the mailbox has been created and tested
 * (see docs/auth-security-hardening.md). The public legal contact
 * (lib/legal/contact.ts SUPPORT_EMAIL) is deliberately unchanged.
 */
export const PLANNED_SUPPORT_EMAIL = "support@voom.today";

/** Images and the privacy link always come from Production, whatever the app origin. */
export const TEMPLATE_ASSET_SITE = "https://voom.today";

export type VoomAuthTemplate = {
  name: "confirmation" | "recovery" | "password-changed" | "email-changed";
  title: string;
  message: string;
  label: string;
  url: string;
};

/** `app` is the exact origin of the environment's app, e.g. https://voom.today. */
export function voomAuthTemplates(app: string): VoomAuthTemplate[] {
  const origin = new URL(app).origin;
  return [
    {
      name: "confirmation",
      title: "Confirm your Voom account",
      message: "Confirm your email address to finish creating your Voom account. If you did not request this, ignore this email.",
      label: "Confirm email",
      url: `${origin}/auth/confirm?token_hash={{ .TokenHash }}`,
    },
    {
      name: "recovery",
      title: "Reset your Voom password",
      message: "You requested a password reset. Continue to choose a new password. If you did not request this, ignore this email; your password has not changed.",
      label: "Reset password",
      url: `${origin}/auth/recovery?token_hash={{ .TokenHash }}`,
    },
    {
      name: "password-changed",
      title: "Your Voom password was changed",
      message: `The password for your Voom account was just changed. If you made this change, you don't need to do anything. If you didn't, reset your password now and contact Voom support at ${PLANNED_SUPPORT_EMAIL}.`,
      label: "Reset your password",
      url: `${origin}/forgot-password`,
    },
    {
      name: "email-changed",
      title: "Your Voom email address was changed",
      message: `The email address for your Voom account was just changed. If you made this change, you don't need to do anything. If you didn't, contact Voom support right away at ${PLANNED_SUPPORT_EMAIL}.`,
      label: "Contact Voom support",
      url: `mailto:${PLANNED_SUPPORT_EMAIL}`,
    },
  ];
}

/** The exact HTML committed for one template. */
export function renderVoomAuthTemplate(template: VoomAuthTemplate): string {
  return emailDocument(template.title, template.message, template.label, template.url, TEMPLATE_ASSET_SITE);
}
