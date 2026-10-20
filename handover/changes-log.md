# Changes that need a step outside the code

One row per code change that also needs something done in Supabase, Vercel, an email provider or
a platform console. Newest at the top. "Dev" and "Prod" say whether that step has been done on
each project. Before every production deploy, do every row whose Prod column is not "done".

How to add a row: date, what changed in the code (file or feature), the outside step with the
exact dashboard path, and the two status columns. If a change needs **no** outside step, do not
add a row; `DECISIONS.md` already records it.

| Date | Code change | Outside step needed | Dev | Prod |
|---|---|---|---|---|
| 2026-10-20 | "Continue with Google" on login and signup (`app/auth/google/actions.ts`, `app/components/GoogleButton.tsx`) | Google Cloud: new OAuth client (Web) with the Supabase callback URL as redirect URI; consent screen published. Supabase → Authentication → Providers → Google: enabled, Client ID + secret pasted. Full steps and the production checklist: `production-setup.md` A9. No env vars. | done (2026-10-20, consent screen still in Testing) | pending |
| 2026-10-17 | Forgot-password flow (`app/forgot-password`, `app/reset-password`, `app/auth/callback/route.ts` now allows `/reset-password`) | Supabase → Authentication → URL Configuration: Redirect URLs must include `<site>/**` (wildcard). Email Templates → Reset Password keeps `{{ .ConfirmationURL }}`. Providers → Email: "Secure password change" off. Production only: custom SMTP + raised email rate limit (`production-setup.md` A6). | done (2026-10-20) | pending |
| 2026-10-17 | Truthfulness fixes (Connections Instagram status, Generate guard order, empty-channel plan notice) | None. Code only. | n/a | n/a |
| before 2026-10-15 | Everything up to migration 0058 (original developers) | Apply all migrations in order; cron secret in Vault; `schedule-workers.sql`; provider redirects (Part C). See `production-setup.md`. | done | unknown: confirm which migrations production has (see `DECISIONS.md` known state) |
