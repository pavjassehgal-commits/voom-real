# Automation mode normalization

## Problem

- **Onboarding and Settings stored raw answers.** Answers like "MARA drafts, I
  approve" went into `businesses.automation_level`, and some accounts stored
  nothing at all.
- **The scheduled coordinator ignores those accounts.** It only plans for the
  exact values `assisted` and `autopilot`, so they were silently skipped while
  most screens called them Assisted.
- **Settings could rewrite the mode.** It re-saved a client-held value, which
  could revert a recent change or store a mode the plan doesn't include.
- **A modified client could do the same directly.** The owner-update RLS policy
  let it write `automation_level`, including `autopilot` on any plan.

## Behaviour now

- **One reading of the stored value:** `automationModeState` in
  `lib/voom/automation.ts`.
  - **saved:** an exact `manual`, `assisted` or `autopilot` value.
  - **legacy:** one of the four onboarding answers. "I decide everything" reads
    as Manual and the others as Assisted, **never Autopilot**. The owner must
    confirm it.
  - **unset:** missing or unknown. It runs as Manual.
- **Scheduled planning** runs only for a confirmed Assisted or Autopilot. The
  coordinator query is unchanged.
- **Onboarding** saves the canonical mode only if the account's plan includes
  it; a new account is Free, so only Manual. Anything else saves no mode, and
  the owner chooses one in Automations.
- **Settings** never writes the mode.
- **Confirmation** happens on Automations and Today through
  `PATCH /api/automation-mode`, which checks the plan.
- **Runtime authorization (final boundary).** Automation decides from the
  *effective* mode (`effectiveAutomationMode`): only a confirmed canonical
  value, capped at the plan. An unconfirmed answer, a missing value or a forged
  or stale value acts as Manual, or as Assisted for Autopilot on Pro.
  `assertAutonomousWorkAllowed` refuses any unconfirmed value
  (`automation_mode_unconfirmed`). The coordinator re-checks pause,
  confirmation and entitlement immediately before gap filling **and** email-flow
  proposals. Campaign and email-flow decisions use `confirmedAutomationMode`.
- **Automatic paid media consent.** It can be turned on only on a plan with
  automatic media (Max), in the app and in the database. Turning it off is
  always allowed.
- **Migration 0071 (database guard).** It applies to browser-role writes only:
  - `automation_level` may be set only to NULL, a canonical mode the plan
    includes, or one of the four exact onboarding answers. The answers grant
    nothing, and accepting them keeps today's Production onboarding working.
  - `allow_automatic_paid_media` may be turned on only on Max.

  Unchanged values pass, so no existing row is rewritten. Values forged before
  the guard grant nothing because of the runtime rule above.
- **Coordinator email flows.** Authorization is re-checked fresh before
  **each** email AI call and again before **each** write. A revocation during
  generation discards the result, which is reported as `not_permitted`, never
  as proposed. **Migration 0072** re-checks inside the insert transaction,
  holding a share lock on the owner's businesses row. A concurrent pause, mode
  change or plan change is therefore serialized against the write. Each email
  generation gets its own AI usage key.
- **No Production business is updated.** Existing answers stay stored until the
  owner confirms a mode.

## Release order (each step needs its own approval)

No step leaves a window where unauthorized automation can run:

1. Apply 0071 and 0072 to staging and run the release-order acceptance there:
   today's onboarding write, forged writes, a pre-guard forged row, and the
   coordinator.
2. **Production Gate 0, read-only:** confirm 0071 is absent and count stored
   values that exceed their plan (canonical mode or paid-media consent). If any
   exist, they keep their old-code reach until the deploy, so report them before
   continuing. No data is changed.
3. Apply 0071, then 0072, to Production. Both are compatible with the code
   currently live: 0071 accepts today's onboarding answers, and 0072 refuses
   only unauthorized coordinator email drafts. From then on no new forged value
   can be written and no unauthorized coordinator draft can be saved.
4. Merge and deploy the code. From this point any value that is stored but not
   confirmed or not entitled grants nothing at runtime.
5. Post-deploy read-only verification.

Rollbacks: `supabase/rollbacks/0071_automation_mode_entitlement_guard.sql`,
`supabase/rollbacks/0072_coordinator_email_flow_authorization.sql`.
This branch is opted out of automatic Vercel Preview deployments.
