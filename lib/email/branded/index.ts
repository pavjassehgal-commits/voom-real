/**
 * Branded Email Engine — public surface.
 *
 * The one branded email stack Voom ships: per-business sender identity with
 * provider-backed verification, the email brand profile, validated design
 * specs, the deterministic renderer (HTML + plain text), the quality guard,
 * real unsubscribe, email-safe assets — and the shared dispatch path both
 * campaigns and lifecycle flows use.
 */

import "server-only";

export {
  resolveBusinessSender,
  readBusinessSender,
  loadEmailIdentity,
  getProviderDomainStatuses,
  domainOf,
  type ResolvedSenderIdentity,
  type BusinessSenderRead,
  type ProviderDomainOptions,
  type ProviderDomainsResult,
} from "./identity";
export { loadEmailBrandProfile, toEmailAssetRefs } from "./brand";
export {
  EMAIL_LAYOUTS,
  emailDesignSpecSchema,
  validateEmailDesign,
  compileEmailDesign,
  acceptProposedDesign,
  selectEmailLayout,
  type EmailLayout,
  type EmailDesignSpec,
  type EmailDesignSection,
  type EmailAssetRef,
  type CompileEmailDesignInput,
  type CompiledEmailDesign,
  type LayoutSelectionInput,
} from "./design";
export {
  renderEmail,
  renderEmailHtml,
  renderEmailText,
  safeBrandColor,
  readableTextOn,
  type RenderedBrand,
  type RenderedIdentity,
  type RenderedUnsubscribe,
  type RenderEmailInput,
  type RenderedEmail,
} from "./renderer";
export {
  runEmailQualityChecks,
  type QualityCheckInput,
  type QualityFailure,
  type QualityResult,
} from "./quality";
export {
  applyPersonalization,
  findUnresolvedTokens,
  scrubUnresolvedTokens,
  EMAIL_PERSONALIZATION_TOKENS,
  type PersonalizationValues,
} from "./personalize";
export {
  mintUnsubscribeToken,
  verifyUnsubscribeToken,
  processEmailUnsubscribe,
  unsubscribeUrl,
  isUnsubscribeMintingConfigured,
  type UnsubscribeTokenCheck,
  type ProcessUnsubscribeResult,
} from "./unsubscribe";
export {
  publishEmailAsset,
  publishDraftAssetAsEmailAsset,
  removeEmailAsset,
  listEmailAssets,
  optimizeForEmail,
  EmailAssetError,
  EMAIL_ASSET_MAX_BYTES,
  type EmailAssetStorage,
  type PublishEmailAssetInput,
  type PublishedEmailAsset,
} from "./assets";
export {
  prepareBrandedSend,
  dispatchBrandedEmail,
  prepareEmailPreview,
  type BrandedSendDeps,
  type PrepareBrandedSendInput,
  type PrepareBrandedSendResult,
  type BrandedSendPayload,
  type EmailPreview,
  type EmailPreviewInput,
} from "./dispatch";
export type {
  EmailIdentityRow,
  EmailBrandRow,
  EmailAssetRow,
  EmailUnsubscribeRow,
  EmailBrandProfile as EmailBrandProfileView,
  ProviderDomainMap,
  ProviderDomainStatus,
} from "./types";
