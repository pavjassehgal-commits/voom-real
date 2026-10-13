import "server-only";

/**
 * Provider-independent boundary for outbound marketing email.
 *
 * Campaign composition, approval, branding, consent and suppression all live
 * above this interface. A delivery provider only receives a fully prepared
 * message and returns an honest acceptance outcome. Providers are never
 * selected as a fallback after a failed or ambiguous send.
 */
export type EmailDeliveryProviderId = "resend";

export interface EmailProviderSendInput {
  from: string;
  to: string;
  replyTo: string | null;
  subject: string;
  preheader: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

export type EmailProviderErrorKind =
  | "configuration"
  | "rejected"
  | "ambiguous"
  | "network";

export interface EmailProviderSendResult {
  ok: boolean;
  provider: EmailDeliveryProviderId;
  providerMessageId: string | null;
  providerStatus: string | null;
  /** Provider-compatible code retained for current campaign records. */
  errorCode: string | null;
  errorKind: EmailProviderErrorKind | null;
  errorMessage: string | null;
  ambiguous: boolean;
}

export interface EmailDeliveryProvider {
  readonly id: EmailDeliveryProviderId;
  send(input: EmailProviderSendInput): Promise<EmailProviderSendResult>;
}

export type NormalizedEmailEventStatus =
  | "accepted"
  | "delivered"
  | "opened"
  | "clicked"
  | "bounced"
  | "complained"
  | "failed"
  | "canceled"
  /** A temporary delay: Resend is still trying. Never a failure. */
  | "delayed"
  | "unknown";

export interface NormalizedEmailDeliveryEvent {
  provider: EmailDeliveryProviderId;
  providerMessageId: string | null;
  eventId: string;
  /** Provider's original event name, retained for audit and suppression. */
  eventType: string;
  status: NormalizedEmailEventStatus;
  receivedAt: string;
}

