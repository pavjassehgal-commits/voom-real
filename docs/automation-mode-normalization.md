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
- **Migration 0071** refuses browser-role writes of `automation_level` that
  aren't NULL or a canonical mode the plan includes. Unchanged values pass, so
  no existing row is rewritten. Server-side code isn't affected.
- **No Production business is updated.** Existing answers stay stored until the
  owner confirms a mode.

## Release order (each step needs its own approval)

1. Merge and deploy the code.
2. **Then** apply `supabase/migrations/0071_automation_mode_entitlement_guard.sql`
   (rollback: `supabase/rollbacks/0071_automation_mode_entitlement_guard.sql`).
   Never apply it before the deploy. Today's Production onboarding stores raw
   answer text through the user's session, and 0071 would refuse it, so new
   signups would fail onboarding.
3. This branch is opted out of automatic Vercel Preview deployments.
