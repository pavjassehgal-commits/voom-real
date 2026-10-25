# LinkedIn staging preparation — NOT deployed or configured

## Fixed targets

- Existing Vercel project/team: `voom-real` / `pavjassehgal-commits`.
- Implementation branch: `feature/linkedin-personal-publishing` (local changes are not committed).
- Planned short deployment branch: `linkedin-staging`, to be created from the reviewed implementation commit, not from main without the changes.
- Planned stable hostname: `voom-real-git-linkedin-staging-pavjassehgal-commits.vercel.app`.
- Exact planned callback: `https://voom-real-git-linkedin-staging-pavjassehgal-commits.vercel.app/api/integrations/linkedin/callback`.
- Staging Supabase only: `qcdpegwjofrqnfudyrqq`.
- LinkedIn app: `265037473`; both personal-profile products are provisioned.

The hostname is a deployment target, NOT a provisioned or tested live address.
Its label fits Vercel's 63-character limit. Do not use the longer feature-branch
generated hostname (Vercel truncates long labels). After an approved deployment,
verify/assign only this staging alias, before real OAuth testing. No DNS is needed.
Never repoint `sandbox.voom.today`, the TikTok branch alias, or production domains.

## What is reusable

Reuse staging Auth, businesses, versioned draft approvals, calendar and auditing.
Use a dedicated LinkedIn testing owner/business; do not reuse or transfer the
TikTok account's connection, media, draft or queue rows. LinkedIn uses four new
provider-specific tables, separate encryption, and a separate publishing worker.
The existing Supabase TikTok scheduler targets TikTok routes at its own hostname;
do not change it, its Vault entries, or its branch variables.

## Configuration gate — not yet satisfied

Read-only inspection on 2026-10-25 found TikTok branch overrides, shared Supabase
variables applying to Production/Preview, and no `LINKEDIN_*` variables. Never
deploy this branch with inherited configuration. Do not blindly copy TikTok's
19-variable set: main now also has email, media/video and Google integrations.

Configure ONLY Preview + branch `linkedin-staging`, after separate approval:

| Variable | Type | Source/value requirement |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Config | `https://qcdpegwjofrqnfudyrqq.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | Config | Existing authorized staging public key, privately verified against staging Auth |
| `SUPABASE_SECRET_KEY` | Secret | Staging only; never copy the generic Preview value |
| `NEXT_PUBLIC_SITE_URL` | Config | Exact planned staging origin above |
| `LINKEDIN_CLIENT_ID` | Config | Existing Voom app's client ID, not the numeric app ID |
| `LINKEDIN_CLIENT_SECRET` | Secret | Existing Voom app secret, collected securely; never rotate or print |
| `LINKEDIN_REDIRECT_URI` | Config | Exact planned callback above |
| `LINKEDIN_TOKEN_ENCRYPTION_KEY` | Secret | New staging-only random key, at least 32 characters; never reuse another provider's key |
| `LINKEDIN_API_VERSION` | Config | `202610`; reconfirm supported version before deployment |
| `CRON_SECRET` | Secret | New staging-only random secret, NOT the TikTok or production secret; no scheduler registration |

Inventory ALL effective/shared variables before configuring. Explicitly disable
AI, image/video providers, email, Instagram/Meta, TikTok, YouTube/Google, trend
collection and webhooks for this branch only. Use blank mandatory config values
where supported so each provider fails its configuration check; otherwise use
reviewed inert values with network destinations restricted to loopback/`.invalid`.
Do not merely replace a real API key while leaving its live provider destination.
Relevant names include `AI_*`, `MEDIA_*`, `VIDEO_*`, `OPENROUTER_API_KEY`,
`EMAIL_*`, `META_*`, `INSTAGRAM_TOKEN_ENCRYPTION_KEY*`, `TIKTOK_*`, `GOOGLE_*`,
`YOUTUBE_*` and `TREND_COLLECTION_ENABLED=false`. These are inventory families,
not Vercel wildcard variable names. Recheck source and the full effective env;
stop if any live-capable inherited setting cannot be disabled safely.

Verify effective build AND runtime settings privately, including the public
Supabase bundle URL/key matching the staging server config. Never expose env
values through public endpoints or logs. No secrets in deployment arguments/files.
Keep Vercel Authentication enabled; authenticate the tester's browser to Vercel
before OAuth and keep the same hostname throughout so VOOM/state cookies return.
If protection blocks the callback, stop; don't disable protection automatically.

## Migration 0062 — separate approval required

File: `supabase/migrations/0062_linkedin_personal.sql`.
SHA-256: `fa430a4c36c83fc5a38e320605dbae436403018e91c2af5c05de5118862b0a53`.

Requires existing business/draft/calendar/audit schema through 0059, especially
approval_origin, content_version, approved_content_version and approval-integrity
triggers. Uses no 0061 AI accounting objects or TikTok 0060 upload-size objects.
It adds `linkedin_connections`, `linkedin_connection_secrets`,
`linkedin_oauth_states`, `linkedin_publish_queue`, three explicit indexes, two
owner-read RLS policies, nine server-only functions and one LinkedIn draft-edit
guard. Four existing named draft/calendar vocabulary constraints are extended,
preserving their original expressions. No existing data backfill, cron or HTTP.

Before applying: positively identify staging; inspect actual prerequisite columns,
named constraints/triggers and grants, confirm all 0062 objects are absent,
snapshot current constraints/counts and TikTok cron definitions, and review rollback
handling of future LinkedIn records. Local embedded-Postgres tests are not a live
staging-schema preflight. Do not run a bulk db-push against manually bootstrapped
staging. No migration or rollback has been executed in this preparation.

## Ordered approval gates

1. Read-only actual staging-schema preflight; approve branch-only secure env setup.
2. Review and commit implementation + safeguards locally; create `linkedin-staging`
   from that commit with no main upstream. Any eventual push must use an explicit
   staging refspec. Root `vercel.json` disables Git deploys for both LinkedIn
   branches, while preserving main's existing cron entries.
3. Only with approval: configure branch variables, apply reviewed 0062 once to
   staging, and register the exact redirect in app 265037473 Auth settings.
   Do not change Company Page verification or request more scopes. VOOM requests
   `openid profile w_member_social` only; portal-granted `email` is not requested.
4. Only with deployment approval: one Preview using the short branch's actual Git
   metadata, `--target preview --skip-domain`, and
   `--local-config vercel.linkedin-staging.json` (no cron definitions). Explicit
   `githubDeployment=1` and `githubCommitRef=linkedin-staging` metadata are required
   by the established CLI workflow. Verify effective branch isolation rather than
   assuming metadata proves it. No `--prod`, no production domain or TikTok alias.
5. Verify READY/Preview, protection, inert providers and staging env before assigning
   the planned stable alias. Confirm no new scheduler/webhook targets this host.
6. Separately authorize real OAuth. Confirm correct owner/business persistence.
   Do not approve/queue a post or call any worker during setup. Later text tests
   need explicit post approval and a protected, one-time LinkedIn worker trigger;
   no automatic schedule is part of this preparation.

Company Page verification remains pending and was not bypassed. No remote
configuration, account connections, database writes or deployment occurred here.

References: https://vercel.com/docs/environment-variables
and https://vercel.com/docs/deployments/generated-urls
and https://vercel.com/docs/project-configuration/git-configuration
and https://vercel.com/docs/cli/global-options
