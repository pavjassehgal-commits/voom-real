# Combined authentication and Brand Kit handover

This handover supersedes the authentication setup instructions in the older PR #111 handoff and `production-setup.md`. In particular, do not enable Production Google sign-in or retain the old email templates on the strength of those documents.

## Release contents

- PR #111 onboarding, Brand Kit and Google sign-in code, with Google disabled by default in both the UI and server action.
- PR #108 email confirmation, resend and password recovery, including per-action rate limits and an attempted global session sign-out after password reset; a failed global sign-out is reported, not claimed successful.
- Cross-browser email links: the confirmation and recovery templates use `/auth/confirm` and `/auth/recovery` with Supabase's `TokenHash`. Legacy account-verification experiments and migrations 0076/0077 are excluded.

## Validation

- Claude reported staging passes for signup and confirmation, resend, cross-browser recovery, onboarding three synthetic businesses, Brand Kit, account isolation and disabled Google sign-in. These journeys were not repeated during this local review.
- Local focused authentication/onboarding/Brand Kit checks: 78 passed, none failed. TypeScript passed; full lint passed with 0 errors and 16 warnings. Production Webpack build passed after allowing access to Google Fonts.
- Full suite: 2,517 tests; 2,491 passed, 21 failed, 5 skipped. The 21 failures match the categories and named tests documented in `docs/baseline.md`: 14 trend fixtures and 7 pre-existing main-branch assertions. Four skips are documented there; the fifth skips the migration-history comparison because this isolated checkout has no local `main` branch. These failures and the unrun comparison remain review items, not passing checks.
- Six exact migration-list assertions were updated to include reviewed migration 0074 while retaining their checks against unexpected migrations; all six pass independently.

## Production release order and gates

1. Confirm the exact release commit and take a current backup. Migration 0074 and 0075 are reported installed; their history reconciliation is reported complete, but was not checked during this local-only review. Verify ledger status separately before any migration tooling. Do not rerun either migration.
2. Keep the Supabase Google provider disabled and leave `VOOM_GOOGLE_AUTH_ENABLED` unset or false. Existing accounts may have been automatically confirmed without mailbox ownership checks. Get the supported Supabase Auth-level solution and a separately approved reconciliation plan before enabling Google. Hiding the button alone cannot block direct Auth requests.
3. Prepare a private server-side `VOOM_AUTH_EMAIL_SECRET` of at least 32 random characters and the exact Production site and redirect settings. Supabase Auth SMTP using the verified `auth.voom.today` sender has been reported tested. Preserve the separate marketing email setup and disabled transactional welcome automation.
4. Coordinate application deployment and Supabase email template changes as one controlled release: `supabase/templates/voom-auth/confirmation.html` and `recovery.html` must use the production `/auth/confirm?token_hash={{ .TokenHash }}` and `/auth/recovery?token_hash={{ .TokenHash }}` routes. Install the templates only when the deployed routes are ready; plan rollback of both code and templates together so links do not point to unavailable handlers. Keep click tracking disabled for authentication links.
5. After separate approval, enable email confirmation for future signups only after SMTP, redirects, templates and the deployed application are ready. Existing accounts need a separate ownership and lockout-safe reconciliation plan; a confirmed flag alone is not proof of mailbox ownership. Test an owner-controlled account end to end, including resend and cross-browser recovery, and check session revocation. Do not activate Google in this smoke test.
6. Independently reconcile the separately identified 0070–0072 migration-history question: compare actual installed definitions and ledger entries before any repair; never infer missing schema from missing history or rerun these migrations merely to fix history.

## Review risks

- A full test suite failure or incomplete check is a release review item; do not assume it is baseline without comparing the specific failure.
- `vercel.json` does not opt out `codex/combined-auth-release` from branch previews. Before any push, establish that Preview credentials are isolated or add a branch-specific opt-out; do not assume a Preview is safe.
- Production template, redirect, secret and provider states require independent confirmation immediately before release. Historical handoff instructions may be stale.
- Prior staging evidence is not a Production delivery or login test. Production settings, deployment, tests involving real accounts and any ledger changes need separate approval.
