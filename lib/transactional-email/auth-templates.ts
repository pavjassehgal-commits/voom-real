import { emailDocument } from "./core";

/**
 * The single source for Voom's Supabase Auth email templates.
 * `scripts/prepare-voom-auth-emails.mjs` writes them to supabase/templates/
 * voom-auth (Production) and voom-auth-staging, and the tests re-render them
 * here to prove the committed files never drift from this definition.
 *
 * Every template is sent from the existing no-reply sender
 * (no-reply@auth.voom.today). By owner decision (2026-11-21) there is no
 * support mailbox, so no template names a contact address or invites a reply.
 *
 * password-changed: an unauthorized change is fixed with the existing
 * forgot-password flow. The person still controls their email address, and a
 * completed reset signs out every session (app/forgot-password/actions.ts).
 *
 * email-changed: deliberately NOT provided, and that notification must stay
 * disabled in Supabase. It is sent to the OLD address after the change
 * completes. Supabase finds accounts for password recovery by their CURRENT
 * address only (internal/api/recover.go), so the old address cannot recover
 * the account, and Voom has no other proven recovery or contact path. A notice
 * that can't tell the person how to get their account back would mislead.
 * See docs/auth-security-hardening.md ("Step 5: email-changed notification: blocked").
 */

/** Images and the privacy link always come from Production, whatever the app origin. */
export const TEMPLATE_ASSET_SITE = "https://voom.today";

export type VoomAuthTemplate = {
  name: "confirmation" | "recovery" | "password-changed";
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
      message: "The password for your Voom account was just changed. If you made this change, you don't need to do anything. If you didn't, reset your password now with the button below; resetting signs you out on every device. Replies to this email aren't read.",
      label: "Reset your password",
      url: `${origin}/forgot-password`,
    },
  ];
}

/** The exact HTML committed for one template. */
export function renderVoomAuthTemplate(template: VoomAuthTemplate): string {
  return emailDocument(template.title, template.message, template.label, template.url, TEMPLATE_ASSET_SITE);
}
