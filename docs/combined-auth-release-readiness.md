# Combined authentication: release prerequisites

This is a local candidate, not permission to release. Keep Google disabled in
both application and Supabase until legacy-account linking is safely resolved.
The application switch only hides and blocks the VOOM action; it cannot prevent
direct calls to Supabase Auth if the provider is enabled.

Before deployment, independently confirm Production schema and migration
history. Migration `0074_voom_transactional_email.sql` must be compared with
installed objects and the migration ledger; if objects already exist, reconcile
history using the reviewed procedure instead of blindly replaying SQL. If absent,
review prerequisites, backup and the exact transaction before separately
authorizing application. No bulk migration command is authorized.

Set a new server-only `VOOM_AUTH_EMAIL_SECRET` of at least 32 random characters
in the correct Production runtime; it signs recovery proofs and rate-limit
identifiers. Never copy staging secrets. Keep welcome automation disabled until
its separate delivery, scheduling and opt-in requirements are approved.

Verify `auth.voom.today` domain ownership and tracking safety, then separately
authorize a restricted sending credential and Supabase Auth SMTP settings.
Preserve existing marketing settings. Verify site URL, allowlist and templates:
confirmation uses the approved `/auth/callback` route and recovery uses
`https://voom.today/auth/recovery`; preserve existing URLs. Coordinate existing
legacy reset links, which may need a fresh request after the callback change.

Perform a protected combined staging test, including confirmation, resend,
recovery, password changes, session revocation and onboarding, before any
Production release decision. New Google sign-in must be tested separately only
after the provider-level safety question is resolved.
