# Production setup, step by step

Last updated 2026-10-20. Every step says **what** to do, **why** it is needed, and **how**.
Steps are ordered. Do them on a *new* Supabase project and a *new* Vercel project; never
re-point the development project at real customers.

Words used below:
- **Environment variable (env var):** a named setting the app reads at start-up. Locally they
  live in `.env.local` (never committed). In production they live in Vercel's project settings.
  `.env.example` in the repo lists every name with a comment.
- **Migration:** a numbered SQL file in `supabase/migrations/` that changes the database. They
  are applied in number order, once each.
- **Service/secret key:** the Supabase key that bypasses all row security. Server-only. Never
  put it in a `NEXT_PUBLIC_` variable.

---

## Part A: Supabase (the database, logins and file storage)

### A1. Create the production project
- **What:** Supabase dashboard → New project. Pick the region closest to your customers. Choose a
  strong database password and store it in a password manager.
- **Why:** Development and production data must never mix. A separate project also gives
  separate keys, so leaking a dev key cannot touch customer data.

### A2. Apply the database migrations
- **What:** Run every file in `supabase/migrations/` in number order. Two ways:
  - SQL editor: open each file, paste, run. Tedious but needs no tools.
  - Supabase CLI: `supabase link --project-ref <ref>` then `supabase db push`.
- **Why:** The app expects these tables, functions and security rules to exist exactly as the
  files define them. Code and migrations are released together; a newer migration than the code
  (or the reverse) can break the app.
- **Watch out:** numbers 0052 to 0054 do not exist in this repo (see `DECISIONS.md`). That is
  fine; apply what is there. Check the newest number in the folder before you start so you know
  where "done" is.

### A3. Copy the keys into env vars
- **What:** Dashboard → Project Settings → API. Copy:
  - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
  - Publishable key → `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
  - Secret key → `SUPABASE_SECRET_KEY`
- **Why:** This is the only way the code learns which project to use. Nothing is hard-coded.

### A4. Login and email-link settings (Authentication → URL Configuration)
- **What:**
  - Site URL: your real address, e.g. `https://voom.today`.
  - Redirect URLs: add `https://voom.today/**` (and `http://localhost:3000/**` on the
    development project). The `/**` wildcard is required.
- **Why:** Every email link (signup confirmation, password reset) returns to
  `/auth/callback?next=...`. Supabase only follows return addresses on this list, and the
  `?next=` part means an exact address without the wildcard will not match. If this is wrong,
  links silently land on the home page and the user is never logged in.

### A5. Email templates (Authentication → Email Templates)
- **What:** Open **Reset Password**. Keep the `{{ .ConfirmationURL }}` link in it. Suggested text:

  > Subject: Reset your Voom password
  >
  > Someone asked to reset the password for this email address. If that was you, click the link
  > below within one hour. If not, you can ignore this email; nothing changes.
  >
  > `{{ .ConfirmationURL }}`

  Open **Confirm signup** and keep `{{ .ConfirmationURL }}` there too.
- **Why:** The app's callback expects Supabase's standard "confirmation URL" style link. Do not
  switch the template to the token-hash style; the callback would not understand it.
- **Also set:** Authentication → Providers → Email → leave **Secure password change** off (the
  reset page would otherwise demand a second emailed code) and leave the OTP/link expiry at the
  default 1 hour, which matches the wording on the reset screens.

### A6. Email sending (SMTP)
- **What:** By default Supabase sends login emails from its own shared mailer, which is capped at
  roughly **2 emails per hour for the whole project** and is meant for testing only.
  - **Development project:** the built-in mailer is fine. Just expect the second test email in an
    hour to not arrive. The forgot-password page will still say "we've sent a link" (by design).
  - **Production project:** you must connect your own sender. Dashboard → Project Settings →
    Authentication → SMTP Settings → Enable custom SMTP, then fill host, port, username, password,
    sender email and sender name from the provider below. Then raise the limit under
    Authentication → Rate Limits → "Rate limit for sending emails" (30 per hour is a sane start).
- **Which provider:** any SMTP service works; this is independent of the app code. Options, all
  with a free tier and none needing a card to start:
  | Provider | Free tier | Notes |
  |---|---|---|
  | Brevo (brevo.com) | 300 emails/day | Simplest if you have no email provider yet. SMTP under "SMTP & API". |
  | Resend (resend.com) | 3,000/month, 100/day | The app's *campaign* emails already use Resend (`EMAIL_*` env vars), so one account can cover both. Host `smtp.resend.com`, port 465, username `resend`, password = an API key. |
  | Postmark | 100/month | Very reliable, small free tier. |
  Whichever you pick, you must **verify your domain** there (they give you DNS records to add at
  your domain registrar) so the sender address is `something@voom.today`, not a free-mail address.
- **Why:** Without this, real customers will not get signup or reset emails once more than two
  people act in the same hour.

### A7. Background job secret and timers
- **What:** Generate a long random value (`openssl rand -base64 48`). Store it twice:
  - in Vercel as `CRON_SECRET`
  - in Supabase: SQL editor → `select vault.create_secret('<the value>', 'voom_cron_secret');`
  Then run `supabase/ops/schedule-workers.sql` in the SQL editor.
- **Why:** The publishing, media-polling and performance jobs are URLs. The secret is the only
  thing stopping strangers from triggering them. The SQL file creates the 9 timers that call
  those URLs every few minutes. The two copies of the secret must be identical.

### A8. Storage buckets
- **What:** Nothing manual. The migrations create the buckets the app needs.
- **Why:** Listed so you do not go looking for a step that does not exist.

### A9. "Continue with Google" (Google Cloud + Authentication → Providers → Google)
- **What:** Create a **new** OAuth client in Google Cloud for login (do not reuse the YouTube
  one: different purpose, different scopes, and the YouTube keys stay in env vars), then paste
  its ID and secret into Supabase. The app code has no Google login keys at all, so this is the
  whole step.
  1. Supabase → Authentication → Providers → Google. Copy the **Callback URL** shown there. It
     looks like `https://<project-ref>.supabase.co/auth/v1/callback`. Keep this tab open.
  2. Google Cloud console (console.cloud.google.com) → pick or create a project → APIs & Services
     → **OAuth consent screen**: User type External; app name "Voom"; your support email; developer
     contact email. Scopes: leave the defaults (email, profile, openid). While the app's
     publishing status is **Testing**, only addresses listed under *Test users* can sign in, so
     add your own Gmail there. Click **Publish app** before real customers use it (the default
     scopes need no Google review).
  3. APIs & Services → **Credentials** → Create credentials → **OAuth client ID** → Application
     type **Web application** → name "Voom login". Under *Authorized redirect URIs* paste the
     Supabase callback URL from step 1, exactly. *Authorized JavaScript origins* can stay empty.
     Create, then copy the **Client ID** and **Client secret**.
  4. Back in Supabase (step 1 tab): switch **Enable Sign in with Google** on, paste the Client ID
     and Client secret, leave "Skip nonce check" off, Save.
  5. Confirm A4 is done: Redirect URLs must contain `https://voom.today/**` (and
     `http://localhost:3000/**` on the development project), because Google's flow returns to
     `/auth/callback?next=/app` like the email links do.
- **Why:** Google only sends users back to addresses it was told about, and Supabase is the
  address in the middle: browser → Google → Supabase → our callback. The production project has
  its own callback URL, so production needs its own OAuth client (or a second redirect URI on a
  shared one; a separate client is simpler to revoke).
- **Production checklist (done on the development project 2026-10-20; repeat every item for
  production, nothing carries over):**
  1. **Supabase production project** → Authentication → Providers → Google → copy *its* Callback
     URL. It contains the production project ref, so it differs from the development one.
  2. **Google Cloud** → Credentials → create a second OAuth client, Web application, name
     "Voom login (production)", Authorized redirect URI = the production Callback URL from 1.
     Do not add it to the development client; keep dev and prod separable.
  3. **Supabase production project** → Providers → Google: enable, paste the *production*
     client's ID and secret, Save. Pasting the development client's values here will fail with
     "redirect_uri_mismatch" on Google's screen.
  4. **Google Cloud** → OAuth consent screen → **Publish app** (status changes from Testing to
     In production). Until this is done, every customer who is not on the Test users list is
     blocked at Google's screen with "Voom has not completed the Google verification process".
     With only the default scopes (email, profile, openid) there is no Google review; the
     confirmation dialog just asks you to confirm. Optional but recommended on the same screen:
     add `voom.today` under *Authorized domains*, and set the app's home page, privacy policy
     (`https://voom.today/privacy`) and terms (`https://voom.today/terms`) links so the consent
     screen shows "Voom" with those links instead of looking unverified.
  5. **Supabase production project** → Authentication → URL Configuration: Site URL
     `https://voom.today`, Redirect URLs contains `https://voom.today/**` (A4). Without this
     Google's return trip ends on the home page, logged out.
  6. **Vercel** → `NEXT_PUBLIC_SITE_URL=https://voom.today` (B3), because the action builds the
     return address from it.
  7. Run Part D items 6 to 8 on the live site with a Gmail that is **not** on the old Test users
     list, to prove step 4 took effect.
  Nothing in the code changes between development and production for this feature.
- **Same email, one account:** Supabase links a Google sign-in to an existing email/password
  account with the same address automatically, because Google reports its emails as verified and
  our signups are verified by the confirmation link. No setting is needed; leave *Manual linking*
  off. Known limit the other way round: someone who only ever used Google and then tries
  email/password signup with the same address gets the "check your email" screen but no new
  account; they should use "Forgot password?" to set a password.

---

## Part B: Vercel (where the app runs)

### B1. Create the project
- **What:** Import the GitHub repo, framework Next.js, Node 20 or newer. Pro plan is needed:
  some routes run up to 300 seconds, which the free plan does not allow.

### B2. Domain
- **What:** Add `voom.today` and `www.voom.today` (redirect www to the apex). Follow Vercel's DNS
  instructions at your registrar.
- **Why:** `NEXT_PUBLIC_SITE_URL` and every provider redirect below use this address.

### B3. Environment variables (Production)
- **What:** Settings → Environment Variables. Use `.env.example` as the checklist. The groups:
  - Site and Supabase: `NEXT_PUBLIC_SITE_URL`, the three Supabase values from A3.
  - Jobs: `CRON_SECRET` from A7.
  - AI text (`AI_*`), images/video (`MEDIA_*`, `OPENROUTER_API_KEY`, `VIDEO_*`).
  - Optional image reading for brand images (`AI_VISION_MODEL`, plus `AI_VISION_PROVIDER` / `AI_VISION_API_KEY` when it is not the text provider). Off when unset; owners then type a line per image. With it on, onboarding's website read also takes one screenshot of the homepage with a headless browser (`@sparticuz/chromium` + `puppeteer-core`, shipped in the repo's dependencies, nothing to install). That function needs memory: if the Vercel logs show the screenshot failing with an out-of-memory or "browser closed" message, raise the function memory for the app (Settings → Functions, 1024 MB or more). The text read works without the browser.
  - Instagram (`META_*`, `INSTAGRAM_TOKEN_ENCRYPTION_KEY`), YouTube (`GOOGLE_*`, `YOUTUBE_*`),
    TikTok (`TIKTOK_*`).
  - Campaign email (`EMAIL_*`), including `EMAIL_UNSUBSCRIBE_SECRET`.
  - Leave empty: `NEXT_PUBLIC_ENABLE_PLANNING_PREVIEW`, every `*_KEY_NEXT` and `*_KEY_LEGACY`,
    `INSTAGRAM_KEY_ROTATION_SECRET`, and the `STRIPE_*` values until billing is built.
  - Generate every secret or encryption key with `openssl rand -base64 48`. Use **different**
    values from the development project.
- **Why:** Anything starting `NEXT_PUBLIC_` is visible to every visitor's browser; everything else
  stays on the server. Reusing dev secrets in production would mean a dev leak unlocks production.

### B4. Scheduled jobs
- **What:** Nothing manual. `vercel.json` in the repo schedules the daily planning job and the
  (switched-off) trend collector. Vercel reads it on deploy.

---

## Part C: Provider consoles (only for the channels you switch on)

| Provider | Register this redirect / webhook | Put it in |
|---|---|---|
| Meta (Instagram) | `https://voom.today/api/integrations/instagram/callback` | `META_INSTAGRAM_REDIRECT_URI` |
| Google Cloud (YouTube) | `https://voom.today/api/integrations/youtube/callback` | `YOUTUBE_REDIRECT_URI` |
| TikTok for Developers | `https://voom.today/api/integrations/tiktok/callback` | `TIKTOK_REDIRECT_URI` |
| Resend (campaign email) | webhook `https://voom.today/api/webhooks/resend` | signing secret → `EMAIL_WEBHOOK_SECRET` |

**Why:** each platform only sends users back to addresses it was told about in advance.
App reviews (Meta App Review, YouTube compliance audit, TikTok content-sharing audit) take weeks;
start them early. Set `YOUTUBE_PROJECT_AUDITED` / `TIKTOK_APP_AUDITED` to `true` only after each
passes. Instagram posting for real customers does not work until Meta approves (see `DECISIONS.md`).

---

## Part D: Smoke test after the first deploy (15 minutes)

Do these in a private browser window with an email address you can read.

1. **Signup:** `/signup` → create an account → the email arrives → the link lands on
   `https://voom.today/app` logged in. *Proves A4, A5, A6 and B3.*
2. **Forgot password:** log out → `/login` → "Forgot password?" → enter the same email → the page
   says "If that email has an account, we've sent a link" → the email arrives → the link lands on
   `/reset-password` showing two password fields → enter a new password twice → you land on
   `/login` with a green "Your password has been updated" notice, **not** logged in → log in
   with the new password → `/app`. If you were logged in on another device, that device is
   logged out too. *Proves the reset flow end to end.*
3. **Dead link:** click the same reset email link again → "This reset link is invalid or has
   expired" with a "Request a new link" button. *Proves the callback's error path.*
4. **Other device:** request a reset on your laptop, open the email on your phone → expect the
   same "invalid or expired" screen. This is a known limit of the code-exchange flow (the link
   must be opened in the browser that requested it) and is the same for signup confirmation.
5. **Unknown email:** `/forgot-password` with an address that has no account → the identical
   "we've sent a link" message. *Proves nobody can use the form to discover accounts.*
6. **Google, new user:** `/signup` → "Continue with Google" with a Gmail that has no Voom
   account → Google's consent screen → you land in `/app/onboarding`. *Proves A9 and A4.*
7. **Google, existing user:** log out → `/login` → "Continue with Google" with the Gmail from
   step 1 (the email/password account) → you land in `/app` with the same business data, no
   second account. In Supabase → Authentication → Users that address has one row with two
   identities (email, google). *Proves automatic account linking.*
8. **Google, cancelled:** click the button, then Cancel on Google's screen → back on `/login`
   with "Google sign-in didn't complete". (A failure *after* Google, at the code exchange, shows
   the generic "confirmation link" message instead; accepted trade-off, see `DECISIONS.md`.)
9. **Jobs are locked:** `curl -I https://voom.today/api/cron/email-flows` returns 401.
10. **Security headers:** `curl -I https://voom.today` shows HSTS, X-Frame-Options and CSP.
11. **Publishing:** connect Instagram, approve one scheduled post, watch it publish.

---

## Part E: When to do what (timeline)

| When | Do |
|---|---|
| Today, development | A4 (with localhost), A5, A9 (dev project's callback URL). A6 is optional (built-in mailer, 2/hour). |
| Before the first production deploy | A1, A2, A3, A4, A5, A6 (custom SMTP, mandatory), A7, A9 (production callback URL, publish the consent screen), B1, B2, B3. Then Part D. |
| Every later deploy | Check `changes-log.md` for rows not yet done in production; apply any new migrations (A2) **before** deploying the code that needs them. |
| When a channel goes live | The matching row in Part C, then its app review. |
