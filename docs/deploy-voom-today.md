# Deploying Voom to voom.today

Production runbook. Steps are ordered; each is required unless marked optional.

## 1. Supabase (production project, Pro plan recommended for backups/PITR)

1. Apply migrations `0001` → `0051` in order (`supabase db push`, or run each
   file in the SQL editor). `0050` locks approval state to server-side writes;
   `0051` adds per-owner AI rate limits. Deploy the app code from this release
   together with them — `0050` requires the updated API routes.
2. Auth → URL configuration:
   - Site URL: `https://voom.today`
   - Redirect URLs: `https://voom.today/auth/callback`
   - Review Auth rate limits (sign-in / sign-up / email) for brute-force protection.
3. Auth → SMTP: use a custom SMTP sender on the voom.today domain (the default
   Supabase sender is heavily rate limited).

## 2. Vercel (Pro plan — routes use up to 300 s)

1. Import the repo, framework preset Next.js, Node 20+.
2. Domains: add `voom.today` (and `www.voom.today` → redirect to apex).
3. Environment variables (Production), see `.env.example`:
   - `NEXT_PUBLIC_SITE_URL=https://voom.today`
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`
   - `CRON_SECRET` (long random value; also stored in Supabase Vault, step 3)
   - `EMAIL_UNSUBSCRIBE_SECRET`, `EMAIL_WEBHOOK_SECRET`, `EMAIL_PROVIDER_API_KEY`,
     `EMAIL_FROM_ADDRESS` (on a Resend-verified voom.today domain), `EMAIL_FROM_NAME`
   - `AI_*`, `MEDIA_*`, `OPENROUTER_API_KEY`, `VIDEO_*`
   - `META_*` + `INSTAGRAM_TOKEN_ENCRYPTION_KEY`
   - `GOOGLE_CLIENT_ID/SECRET`, `YOUTUBE_REDIRECT_URI`, `YOUTUBE_TOKEN_ENCRYPTION_KEY`
   - `TIKTOK_CLIENT_KEY/SECRET`, `TIKTOK_REDIRECT_URI`, `TIKTOK_TOKEN_ENCRYPTION_KEY`
   - Leave `NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW`, `*_KEY_NEXT`, `*_KEY_LEGACY`
     and `INSTAGRAM_KEY_ROTATION_SECRET` empty.
   - Generate each secret/key with `openssl rand -base64 48`.
4. `vercel.json` schedules the daily planning job (`/api/cron/weekly-plans`).

## 3. Background workers (Supabase Cron)

Run `supabase/ops/schedule-workers.sql` in the production SQL editor after
storing the cron secret in Vault:

```sql
select vault.create_secret('<same value as CRON_SECRET>', 'voom_cron_secret');
```

It schedules the 9 workers (Instagram/YouTube/TikTok publish, YouTube/TikTok
reconcile, media polling, email flows, Instagram/YouTube performance).
Verify with the queries at the bottom of that file.

## 4. Provider consoles

| Provider | Redirect / webhook to register |
|---|---|
| Meta (Instagram) | `https://voom.today/api/integrations/instagram/callback` → `META_INSTAGRAM_REDIRECT_URI` |
| Google Cloud (YouTube) | `https://voom.today/api/integrations/youtube/callback` → `YOUTUBE_REDIRECT_URI` |
| TikTok for Developers | `https://voom.today/api/integrations/tiktok/callback` → `TIKTOK_REDIRECT_URI` |
| Resend | Verify the sending domain; webhook `https://voom.today/api/webhooks/resend` (signing secret → `EMAIL_WEBHOOK_SECRET`) |

App reviews (these take time, so start them early): Meta App Review (incl.
`instagram_business_manage_insights`), the YouTube API Services compliance
audit, and the TikTok content-sharing audit. Set `YOUTUBE_PROJECT_AUDITED` and
`TIKTOK_APP_AUDITED` to `true` only after each audit passes.
Privacy/terms/data-deletion URLs for the reviews:
`https://voom.today/privacy`, `/terms`, `/data-deletion`.

## 5. Smoke test after deploy

- Sign up with a fresh email, confirm the link lands on voom.today, then finish onboarding.
- `curl -I https://voom.today` shows the HSTS, X-Frame-Options and CSP headers.
- `curl https://voom.today/api/cron/email-flows` returns 401 (the secret is required).
- Connect Instagram, approve one scheduled post, and watch `instagram_publish_queue` publish it.
- Send a test campaign to your own address: check that the unsubscribe link uses voom.today and that the delivery webhook marks it delivered.

## Known product gaps (not blockers for a free beta)

- Stripe is not wired, so every account is on the Free plan: manual mode and no
  AI media. Pilot accounts can be upgraded by setting `businesses.plan` with the
  service role.
- The landing page at `/` is minimal.
