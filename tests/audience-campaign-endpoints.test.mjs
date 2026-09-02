import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");

test("the audiences list route is auth-gated and owner-scoped", async () => {
  const route = await read("app/api/voom/audiences/route.ts");
  assert.match(route, /export async function GET/);
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /\{ status: 401 \}/);
  assert.match(route, /listAudiences\(db, \{ owner_id: user\.id/);
  assert.doesNotMatch(route, /export async function (POST|PUT|PATCH|DELETE)/);
});

test("the eligibility preview route is auth-gated, channel-validated and masked", async () => {
  const route = await read("app/api/voom/audiences/[id]/eligibility/route.ts");
  assert.match(route, /getCurrentUser\(\)/);
  assert.match(route, /\{ status: 401 \}/);
  // Channel must be explicitly email or sms — eligibility is never guessed.
  assert.match(route, /kind !== "email" && kind !== "sms"/);
  assert.match(route, /\{ status: 400 \}/);
  // Ownership is validated through the owner-scoped resolution helper.
  assert.match(route, /resolveAudienceChannelEligibility\(db, user\.id, id, kind\)/);
  assert.match(route, /Audience not found/);
  assert.match(route, /\{ status: 404 \}/);
  // Only the masked, browser-safe preview shape is returned.
  assert.match(route, /toAudienceEligibilityPreview\(result\.data\)/);
  assert.doesNotMatch(route, /\beligible\s*[,}]/);
});

test("the browser preview only ever carries masked destinations", async () => {
  const [helper, serverData, contactTypes] = await Promise.all([
    read("lib/voom/campaign-delivery.ts"),
    read("lib/contacts/server-data.ts"),
    read("lib/contacts/types.ts"),
  ]);
  // The preview mapper emits the masked form only.
  assert.match(helper, /export function toAudienceEligibilityPreview/);
  assert.match(helper, /destination: r\.masked/);
  assert.doesNotMatch(helper, /destination: r\.destination/);
  // Server-side resolution builds both forms but documents the raw one as
  // strictly server-only.
  assert.match(serverData, /masked: maskDestination\(destination\)/);
  assert.match(contactTypes, /Server-only — never expose to the browser/);
});

test("campaign POST links an owned audience and validates ownership server-side", async () => {
  const route = await read("app/api/voom/campaigns/route.ts");
  assert.match(route, /audienceId: z\.string\(\)\.trim\(\)\.regex\(UUID_VALUE_RE\)\.nullable\(\)\.optional\(\)/);
  // The schema stays strict: no client-supplied recipient list can slip in.
  assert.match(route, /\}\)\.strict\(\)/);
  assert.doesNotMatch(route, /recipients:|contactIds|contacts: z\./);
  // Ownership check happens before the campaign row is created.
  assert.match(route, /\.from\("audiences"\)[\s\S]+?\.eq\("owner_id", user\.id\)[\s\S]+?\.eq\("id", parsed\.data\.audienceId\)/);
  assert.match(route, /That audience was not found in your workspace/);
  assert.match(route, /audience_id: audienceId/);
});

test("campaign PATCH can link or unlink an audience, always ownership-validated", async () => {
  const route = await read("app/api/voom/campaigns/[id]/route.ts");
  assert.match(route, /audienceId: z\.string\(\)\.trim\(\)\.regex\(UUID_VALUE_RE\)\.nullable\(\)\.optional\(\)/);
  assert.match(route, /parsed\.data\.audienceId !== undefined/);
  assert.match(route, /\.from\("audiences"\)[\s\S]+?\.eq\("owner_id", user\.id\)[\s\S]+?\.eq\("id", parsed\.data\.audienceId\)/);
  assert.match(route, /That audience was not found in your workspace/);
  assert.match(route, /audience_id: audienceId/);
});

test("campaign reads return the linked audience id", async () => {
  const data = await read("lib/mara/internal-data.ts");
  assert.match(data, /audience_id/);
  const selects = data.match(/id,kind,name,objective,audience,audience_id,subject,preview_text,content,proposed_send_at,status,created_at,updated_at/g) ?? [];
  assert.ok(selects.length >= 6, `expected all campaign selects to include audience_id, got ${selects.length}`);
});

test("the send route distinguishes single-recipient and audience sends strictly", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  // Explicit confirmation payload: the client can only say "send to the
  // linked audience" — it can never supply the recipient list itself.
  assert.match(route, /audienceSend: z\.literal\(true\)/);
  assert.match(route, /z\.union\(\[singleRecipientPayload, audienceSendPayload\]\)/);
  const strictSchemas = route.match(/\}\)\.strict\(\)/g) ?? [];
  assert.ok(strictSchemas.length >= 2, "both send payload branches must be strict");
  assert.doesNotMatch(route, /recipients: z\.|contacts: z\.|destinations: z\./);
  // Audience campaigns reject single-recipient bodies and vice versa.
  assert.match(route, /campaign\.audience_id[\s\S]{0,400}?"audienceSend" in parsed\.data/);
  assert.match(route, /This campaign sends to its linked audience/);
  assert.match(route, /No audience is linked to this campaign/);
});

test("explicit approval is still required before any audience send", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  assert.match(route, /campaign\.status !== "approved"/);
  assert.match(route, /Approve the campaign before sending it\./);
  // The approval gate runs before either send mode branches off.
  const gateIndex = route.indexOf('campaign.status !== "approved"');
  const audienceIndex = route.indexOf("campaign.audience_id)");
  assert.ok(gateIndex > -1 && audienceIndex > -1 && gateIndex < audienceIndex, "approval gate must precede the audience branch");
});

test("the audience is re-resolved server-side at send time", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  assert.match(route, /resolveAudienceChannelEligibility\(db, ownerId, audienceId, campaign\.kind\)/);
  assert.match(route, /re-resolved server-side at send time/i);
  assert.match(route, /No contacts in .* are eligible for this/);
  assert.match(route, /Nothing was initiated/);
});

test("audience sends reuse the 0018 per-recipient claim lifecycle", async () => {
  const route = await read("app/api/voom/campaigns/[id]/delivery/route.ts");
  for (const rpc of ["add_campaign_recipient", "claim_campaign_send", "record_campaign_send_provider_result"]) {
    const occurrences = route.match(new RegExp(`rpc\\("${rpc}"`, "g")) ?? [];
    assert.ok(occurrences.length >= 2, `${rpc} must be reused by both send paths, saw ${occurrences.length}`);
  }
  assert.match(route, /createCampaignSendAttemptKey/);
  assert.match(route, /claimed\.idempotency_key !== attemptKey/);
  // Successful/active recipients are never resent.
  assert.match(route, /Already sent or in progress — not sent again/);
  assert.match(route, /successful recipients are never resent/i);
  // Failed or unsent recipients stay safely retryable channel (attempts are
  // incremented by the 0018 claim function on retry).
  assert.match(route, /voom-campaign-audience-send/);
});

test("audience sends are capped and results stay truthful and masked", async () => {
  const [route, helper] = await Promise.all([
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
    read("lib/voom/campaign-delivery.ts"),
  ]);
  assert.match(helper, /export const BULK_SEND_CAP = 100;/);
  assert.match(route, /eligible\.slice\(0, BULK_SEND_CAP\)/);
  assert.match(route, /overLimit/);
  // Truthful per-recipient outcomes with masked destinations.
  assert.match(route, /status: "accepted"/);
  assert.match(route, /status: "failed"/);
  assert.match(route, /status: "skipped"/);
  assert.match(route, /destination: target\.masked/);
  assert.doesNotMatch(route, /destination: target\.destination/);
  // The summary reports accepted/failed/skipped counters, never a blanket success.
  assert.match(route, /\$\{accepted\} accepted, \$\{failed\} failed, \$\{skipped\} skipped/);
});

test("SMS sends never claim Delivered without verified ClickSend tracking", async () => {
  const [route, helper] = await Promise.all([
    read("app/api/voom/campaigns/[id]/delivery/route.ts"),
    read("lib/voom/campaign-delivery.ts"),
  ]);
  // ClickSend delivery tracking stays unconfigured — accepted is the ceiling.
  assert.match(helper, /deliveryTrackingConfigured: false,/);
  assert.match(route, /Delivered is only ever set by a verified provider callback/);
  // No audience path writes a delivered state or message.
  assert.doesNotMatch(route, /internal_status: "delivered"|"sms"[^\n]*delivered|delivered[^\n]*"sms"/i);
  assert.doesNotMatch(helper, /mark.*Delivered.*provider API success/i);
});

test("the editor offers single-recipient or audience mode with a live eligibility preview", async () => {
  const modal = await read("components/voom/modals/CampaignEditorModal.tsx");
  assert.match(modal, /Single recipient/);
  assert.match(modal, />Audience</);
  assert.match(modal, /fetch\("\/api\/voom\/audiences"/);
  assert.match(modal, /\/api\/voom\/audiences\/\$\{encodeURIComponent\(audienceId\)\}\/eligibility\?kind=/);
  assert.match(modal, /eligibleCount/);
  assert.match(modal, /excludedCount/);
  assert.match(modal, /duplicateCount/);
  assert.match(modal, /overLimitCount/);
  assert.match(modal, /re-resolved on the server at send time/);
  // The existing single-recipient flow is preserved.
  assert.match(modal, /Recipient email/);
  assert.match(modal, /Recipient phone number/);
  assert.match(modal, /One recipient for this MVP/);
  assert.match(modal, /Send approved/);
  assert.match(modal, /delivery\?\.canSend/);
});

test("the editor sends only an explicit confirmation — never a recipient list", async () => {
  const modal = await read("components/voom/modals/CampaignEditorModal.tsx");
  assert.match(modal, /body: JSON\.stringify\(\{ audienceSend: true \}\)/);
  assert.match(modal, /audienceId: recipientMode === "audience" \? audienceId : null/);
  // No bulk/recipient-list wording or payload leaks into the editor.
  assert.doesNotMatch(modal, /bulk/i);
  assert.doesNotMatch(modal, /recipients: |contactList|recipientList/i);
});
