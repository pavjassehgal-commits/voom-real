# PR #111 handoff: who does what, before and after the merge

Written 2026-11-07 after the teammate's Codex review of PR #111 (`merge-main-2026-10-31` →
`main`). Plain checklist for both sides. "Teammate" = the owner of the production Supabase,
Vercel and Cloudflare accounts. Gurnoor does not press "Merge pull request" until every box in
section 1 is ticked by the teammate. Merging deploys `main` to voom.today within minutes.

Where things are explained in full:

| Topic | File |
|---|---|
| Every outside step a code change needs, with Dev / Prod status | `handover/changes-log.md` (Prod column) |
| Production setup from zero: Supabase, Vercel, providers, smoke test | `handover/production-setup.md` (A9 = Google sign-in, B3 = env vars, D = smoke test) |
| Which side's code won at each merge conflict | `handover/merge-decisions.md` |
| Why the website reader changed on 2026-11-07, and the two decisions below | `DECISIONS.md` 2026-11-07 |
| Expected test counts and the named failing tests | `docs/baseline.md` |

## 1. Teammate, before the merge (production is theirs)

- [ ] **Migration 0075** on the production Supabase: `supabase/migrations/0075_brand_kits.sql`,
      SQL editor, paste whole, run once. Check: table `brand_kits` exists, Storage bucket
      `brand-kit` exists and is private. Without it the Brand page and onboarding fail on the
      live site. 0065, 0069, 0071, 0072 are already there (Codex, 2026-11-05); do not re-run.
- [ ] **Google sign-in** for the production project: Google Cloud OAuth client (Web) whose
      redirect URI is the production Supabase callback URL; Supabase → Authentication →
      Providers → Google: enabled, client ID and secret pasted; consent screen published.
      Steps: `handover/production-setup.md` A9 "Production checklist". Without it the
      "Continue with Google" button appears and fails.
- [ ] **Password-reset emails**: Supabase → Authentication → URL Configuration → Redirect URLs
      includes `https://<production domain>/**`; Email Templates → Reset Password keeps
      `{{ .ConfirmationURL }}`. The built-in sender allows 2 emails an hour, so a proper SMTP
      provider (their PR #108 work, `production-setup.md` A6) is strongly advised before
      customers use "Forgot password".
- [ ] **Backup**: confirm the 2026-11-04 production backup restores (Codex point 9). Their
      call how; we only need a yes.
- [ ] **Vercel env vars** unchanged for us except: leave `VOOM_WEBSITE_SCREENSHOT` **unset**
      (screenshot stays off, deliberate; section 3). `AI_VISION_MODEL` optional: with it, MARA
      reads uploaded brand images; without it owners type a line per image.
- [ ] Tell Gurnoor "done" on the PR. Gurnoor then presses **Merge pull request** with the
      default "Create a merge commit" (not squash, not rebase).

## 2. Teammate, after the merge

- [ ] **Smoke test** on voom.today: `handover/production-setup.md` Part D, plus: sign up with
      Google, run onboarding with a logo and a website address, finish, open the Brand page.
      Expected after the website read: MARA's draft description appears; the line "The homepage
      look is off, so no colours from the site." is normal (section 3).
- [ ] **Land PR #108 on top of `main`** and resolve the seven overlapping files:
      `app/auth/callback/route.ts`, `app/forgot-password/actions.ts`,
      `app/forgot-password/page.tsx`, `app/login/LoginForm.tsx`, `app/login/page.tsx`,
      `app/reset-password/page.tsx`, `app/signup/SignupForm.tsx`.
      Rule agreed: **their recovery flow wins.** Keep from ours only "Continue with Google":
      `app/components/GoogleButton.tsx`, `app/auth/google/actions.ts`, and the one line that
      places the button in `LoginForm.tsx` and `SignupForm.tsx`. Our
      `app/forgot-password/ForgotPasswordForm.tsx`, `app/reset-password/ResetPasswordForm.tsx`
      and `app/reset-password/actions.ts` can go if theirs replace them. In the callback route,
      `/reset-password` is in the allowlist for our flow; keep it only if their flow lands there.
- [ ] **Migration 0074 and the exact-list tests.** Seven of our tests list every migration file
      and treat 0074 as a gap today. When 0074 lands they go red until the list is updated (a
      few minutes): `tests/multi-social-core.test.mjs`, `tests/post-studio.test.mjs`,
      `tests/post-studio-production-0021.test.mjs`, `tests/campaigns-v3-unified-channels.test.mjs`,
      `tests/mara-media-brief.test.mjs` (comment says 0060/0073/0074 are gaps),
      `tests/post-format-persistence.test.mjs`, `tests/email-automation-flows-pglite.test.mjs`.
      0075 stays the newest.
- [ ] **Their own seven red tests** (identical on plain `main`, `docs/baseline.md` Notes):
      `approval-state-lockdown` (LinkedIn cron Bearer check), `linkedin-production-release`,
      `perf-regression` ×2 (storage signing: intent unclear, their call), `product-truth-cleanup`
      (four channels vs LinkedIn), `worker-schedules` and `mara-launch-hardening` (both pin
      `vercel.json`'s branch list; ours added one more entry). Not ours to decide.
- [ ] **Cloudflare for the screenshot** (section 3): enable Browser Rendering on the Cloudflare
      account that runs the YouTube deletion worker and create an API token with only that
      permission; send it to Gurnoor privately (it goes into Vercel env vars, never in code or
      chat logs that are kept).

## 3. Gurnoor, after the merge

- [ ] Run the smoke test yourself too (section 2, first box), on a phone as well.
- [ ] Update `handover/changes-log.md` Prod column for the rows the teammate confirmed, and
      `handover/next-session.md` section 1.
- [ ] **Screenshot through Cloudflare Browser Rendering** (next task, plan first). Why: the
      homepage screenshot runs a browser that does its own DNS lookups for every image, script
      and font a page loads, so the pinned-address protection the text reader has does not cover
      it; a hostile page could make our browser reach inside our hosting. Cloudflare runs the
      browser in its own isolated environment, so there is nothing of ours to reach. After it
      ships: set `VOOM_WEBSITE_SCREENSHOT=on` in Vercel and the "From your website" colours
      return. Until then the text read and MARA's draft description work; colours come from the
      logo.
- [ ] Then slice 8, Instagram import (`handover/next-session.md` section 2).

## 4. The message sent to the teammate (PR #111 comment, 2026-11-07)

```
Thanks for the Codex review. Our side is in the latest push; I am NOT pressing merge until you
tell me production is ready. Full checklist for both of us: handover/pr-111-handoff.md in this
branch.

Done on our side (DECISIONS.md 2026-11-07):
1. Website reading: the text fetch now connects only to the address that passed the public check
   (no DNS rebinding). The homepage screenshot is off unless VOOM_WEBSITE_SCREENSHOT=on; leave it
   unset in production. We will move it to Cloudflare Browser Rendering after the merge.
7. Preview isolation: vercel.json lists merge-main-2026-10-31 as not deployable.
3. Migrations: agreed, only 0075 is needed. handover/changes-log.md says so now.
8. Tests: full suite 2468 tests, 2443 pass, 21 fail, 4 skipped; the 21 are named in
   docs/baseline.md (14 parked trend tests, 7 that fail identically on plain main).

Before I merge, on your side (section 1 of the handoff file):
- migration 0075 on production;
- Google sign-in for the production Supabase project (production-setup.md A9);
- password-reset redirect URL and, ideally, a real SMTP sender;
- your backup restore check.
Reply "ready" here and I press merge (default merge commit, not squash).

After the merge (section 2): smoke test, then land your PR #108 on top of main. Order agreed
on our side: your recovery flow wins in the seven overlapping auth files; please keep only our
"Continue with Google" (app/components/GoogleButton.tsx, app/auth/google/actions.ts, one line
each in LoginForm.tsx and SignupForm.tsx). Your 0074 will turn seven exact-list migration tests
red for a few minutes; the file names are in the handoff file.

For the screenshot work I will need Browser Rendering enabled on your Cloudflare account and a
token with only that permission, sent privately.
```
