# Decisions log

Every important decision goes here, newest at the top. One entry per decision. If a later
decision reverses an earlier one, add a new entry and mark the old one "Replaced by: <date/title>".

## Template
```
## YYYY-MM-DD: <short title>
- Decision: what we decided, in one or two sentences.
- Before: what the architecture/plan/behaviour was until now.
- Why: the reasons, and the alternatives we rejected.
- Prompted by: what made us decide now (a bug, a finding, a user need, a cost).
- Consequences: what this changes or makes harder; follow-ups.
- Status: Active | Replaced by …
```

---

## 2026-10-20: "Continue with Google" on login and signup, keys in the Supabase dashboard only
- Decision: Add Google sign-in through Supabase's own OAuth support (`signInWithOAuth`, provider `google`), returning to the existing `/auth/callback?next=/app`. One server action (`app/auth/google/actions.ts`) and one button component (`app/components/GoogleButton.tsx`) shared by `/login` and `/signup`. The Google client ID and secret are pasted into the Supabase dashboard, never into code or env vars.
- Before: Email/password only. "Google sign-in" was listed under "Not built yet".
- Why these choices:
  - **Reuse the callback.** Google's flow ends with the same code exchange as email links, so the existing route and its exact allowlist (`/app`) already finish the sign-in. Rejected: a Google-specific callback (duplicate code).
  - **No new env vars.** Supabase holds the Google keys, so switching Supabase projects needs only the dashboard step (`handover/production-setup.md` A9). A new OAuth client is used, not YouTube's: different purpose and scopes, and YouTube's keys stay in `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` for channel connect.
  - **New users go through onboarding without new code.** No database trigger creates a business row on sign-up; the shell layout sends anyone without a finished business row to `/app/onboarding`. Verified in `app/app/(shell)/layout.tsx`.
  - **Same email, same account.** Supabase links an OAuth identity to an existing user with the same email automatically when both are verified. Google emails are always verified; our signups are verified by the confirmation link. No setting to change ("Manual linking" stays off). If "Confirm email" were ever switched off, unverified accounts could not be linked and Google would create duplicates; keep it on.
  - **Server action, not browser SDK.** Matches login/signup; the PKCE verifier is stored in the cookie by the server client.
- Trade-off accepted (Gurnoor, 2026-10-20): if the code exchange fails *after* Google, the callback cannot tell a Google return from an email link, so the user sees the "confirmation link is invalid" message. Keeping the exact `?next=/app` return address was preferred over adding a marker parameter. A refusal *before* Google (provider disabled, bad keys) shows the Google-specific message `/login?error=google_failed`.
- Known limit: a Google-only user who later tries email/password signup with the same address gets the "check your email" screen but no new account; "Forgot password?" sets a password instead. Noted in the handover.
- Testing: `tests/google-sign-in.test.mjs` (3 tests, failed before the code existed): the action asks for provider `google` with the right return address and redirects to the URL Supabase returned, or to the login message on failure; both forms render the button; the login page shows the Google message for its fixed key only. The doubles gained a fake `signInWithOAuth`. Full run and checks: see `docs/baseline.md` row for 2026-10-20 (Google). Browser check: done by Gurnoor on 2026-10-20 on the development project (new user → onboarding, existing user → same account, cancel → login message), works. The Google consent screen is still in "Testing" (only listed test users can sign in); publishing it is a production-day step in `handover/production-setup.md` A9.
- Prompted by: Gurnoor's task on 2026-10-20.
- Consequences: `handover/changes-log.md` has a row (Google Cloud client + Supabase provider, dev and prod pending). Part D of the handover gained three Google smoke tests. `ARCHITECTURE.md` no longer lists Google sign-in as missing.
- Status: Active

## 2026-10-20: After a password reset, sign out everywhere and return to login
- Decision: A successful password reset no longer logs the user in. The reset action sets the new password, ends every session for the account (`signOut({ scope: "global" })`, this browser and any other device), and sends the user to `/login?notice=password_reset`, where a fixed green notice says "Your password has been updated. Log in with your new password."
- Before: The reset action went straight to `/app` using the recovery session the email link had created (2026-10-17 entry, "then `/app`").
- Why: Gurnoor's call after testing the flow: "there's a layer of safety involved there". Re-entering the new password proves the person who clicked the link also knows the password they just set, and the global sign-out means a reset also kicks out anyone else who was sitting in the account, which is what most people expect "reset my password" to do. Rejected: keeping the automatic login (one click less for the user, but a stolen or forwarded link would land straight in the app and leave other sessions alive).
- How it is kept safe: the login page can only show text for its two fixed keys (`error=confirm_failed`, `notice=password_reset`); anything else in the address bar shows nothing. If the sign-out call fails after the password was already changed, the user still goes to login (the recovery session is single-use and the new password is in place), and the failure is logged on the server.
- Side effect: a logged-in user who opens `/reset-password` directly and changes their password is also signed out everywhere and must log in again. Acceptable; it is the same safety rule.
- Testing: `tests/forgot-password.test.mjs` test 4 now expects the sign-out call and the login target (failed before the change), test 5 checks the form no longer promises an automatic login, and new test 6 renders the login page with the notice key, an unknown key and no key. Full run and the three checks: see `docs/baseline.md` row for 2026-10-20. Browser check: done by Gurnoor on 2026-10-20 on the development project (`handover/production-setup.md` Part D item 2), works.
- Prompted by: Gurnoor's browser test of the forgot-password flow on 2026-10-19.
- Consequences: No Supabase or Vercel step, so no `handover/changes-log.md` row. The 2026-10-17 entry's "then `/app`" is replaced by this one; its other choices stand.
- Status: Active

## 2026-10-17: Forgot-password flow, built account-agnostic; a `handover/` folder for production setup
- Decision: Add forgot password using Supabase's own reset email and the existing callback, with no project-specific value in code. Create `handover/` holding the production setup runbook and a running log of code changes that need an outside step.
- Before: No way to recover a lost password (the audit's step 1). Production setup knowledge lived only in `docs/deploy-voom-today.md` and chat history.
- What was built: `app/forgot-password/` (email form, server action `requestPasswordReset`), `app/reset-password/` (new password + confirm, server action `resetPassword`), a "Forgot password?" link on `/login`, and `/reset-password` added to the callback's exact allowlist. The callback now sends a broken reset link to `/reset-password?error=link_invalid` instead of the login error, so the user gets a reset-specific message and a "Request a new link" button.
- Why these choices:
  - **Same reply for every address.** The request action ignores Supabase's result entirely, so the form cannot be used to discover who has an account. Only a malformed address gets a field error.
  - **Reuse the callback.** Supabase's reset link is the same "code exchange" mechanism as signup confirmation, so one allowlisted `?next=` value covers it. Rejected: a separate `/auth/reset` route (duplicate code, second allowlist).
  - **Server actions, not browser calls.** Matches login/signup; the password never passes through client-side Supabase code.
  - **Account-agnostic.** The link is built from `NEXT_PUBLIC_SITE_URL`; the email template is Supabase's default `{{ .ConfirmationURL }}`. Switching to the production project needs only env vars plus the dashboard checklist.
  - **No Resend requirement.** Login emails are sent by Supabase, not by the app, so any SMTP provider works, or none in development (built-in mailer, ~2 emails/hour). Resend is listed as one option because campaign email already uses it.
  - **Config-as-code deferred.** Supabase's CLI can push auth settings from a file in the repo (`supabase config push`). Rejected for now because it requires linking the CLI to production and we have not confirmed how production's migrations are applied; revisit once that is known.
- Known limits: the emailed link must be opened in the same browser that requested it (code-exchange flow; same as signup). Any logged-in user can open `/reset-password` and change their password there (harmless). `same_password` and `weak_password` errors from Supabase are shown as field errors; any other error is treated as an expired link.
- Testing: `tests/forgot-password.test.mjs` (5 tests, all failed before the code existed) run the real actions, callback and reset page against doubled Supabase/Next modules (`tests/helpers/auth-doubles.mjs`). Full run 1673 pass / 0 fail / 4 skipped; typecheck clean; lint 0 errors, 16 warnings. Browser check: pending on the development Supabase project (needs A4/A5 from `handover/production-setup.md` done first).
- Prompted by: Gurnoor's task on 2026-10-17, plus "make it plug-and-play for production".
- Consequences: `handover/changes-log.md` must get a row for every future change that needs an outside step. `docs/deploy-voom-today.md` now defers to `handover/production-setup.md`.
- Status: Active, except "then `/app`" after the reset: Replaced by 2026-10-20 "After a password reset, sign out everywhere and return to login".

## 2026-10-17: Three truthfulness fixes: Instagram status, Free-plan Generate, empty-channel Build plan
- Decision: Fix three places where the app told the user something untrue or nothing at all. Each fix has one automated test in `tests/truthful-status-and-guards.test.mjs` that failed before the fix and passes after.
- Before:
  1. The Connections page always showed Instagram as "Connected" because the card helper defaulted `connected` to true and the Instagram card never passed a value.
  2. "Generate" in Post Studio asked MARA for copy and saved it into the draft *before* checking the plan and credits. A Free user was refused with a 402, but their caption had already been overwritten. When the image step failed afterwards, the copy stayed saved and the message said "MARA saved the copy".
  3. "Build plan" with no social channel selected did nothing visible: the server returned a clear "no supported social channels selected" outcome, but the Plan screen deliberately hid that outcome (`PlanWorkspace.tsx`) and had no text for it.
- What changed:
  1. `app/app/(shell)/connections/page.tsx` reads the real `instagram_connections` row with `getInstagramConnection`, the same way TikTok and YouTube already did, and passes a real `connected` value, status label and description. The helper default is now `connected = false`, so no card can claim a connection it never proved. The Email card passes `connected={email.configured}` so its display is unchanged.
  2. `app/api/posts/[id]/generate/route.ts`: the plan and credit guard now runs before any AI call. The generated title and caption are held in memory and written to the draft only after the visual is generated, validated and stored. Every refusal or failure path leaves the draft untouched, refunds any reservation, and says "Your draft is unchanged". An unused variable was removed (lint warnings 17 → 16).
  3. `components/voom/operating/PlanWorkspace.tsx`: the outcome notice is now shown for the no-channel state and says "Nothing was planned: no social channel is selected", with links to Settings and, when the real connection rows show a channel not connected, "Connect Instagram first" in Connections. `PlanOutcomeNotice` is exported so the test can render it.
- Why: Users must never see a status or a result the system cannot back up (same rule the TikTok and YouTube tiles already followed). Money matters: a refused generation must cost nothing and change nothing. Rejected: keeping the generated caption on image failure (simpler for the user, but it leaves the draft half-changed by a run that reported failure).
- Trade-off accepted: when the image provider fails, the user now loses the generated caption as well and must click Generate again. Credits are refunded either way. Edge case: if the visual is stored but the caption save then fails, the response says exactly that, the credits are refunded, and the text stays unchanged.
- Testing: `tests/truthful-status-and-guards.test.mjs` (A: source check on the page; B: runs the real route with the real plan rules and credit guard against doubled I/O in `tests/helpers/generate-route-doubles.mjs`, for Free refused / Pro image failure / Pro success; C: renders the notice). Five existing text-matching tests were updated to the new wording only. Full run: 1668 pass, 0 fail, 4 skipped; typecheck clean; lint 0 errors, 16 warnings. Browser check: done by Gurnoor on 2026-10-20 on the development project, works; the edge cases (a refused or failed generation leaving the draft untouched) will only be fully seen in real use.
- Prompted by: Gurnoor's bug list on 2026-10-17.
- Consequences: Any future change to the generate route must keep the order guard → copy → visual → save; test B enforces it. The test-doubles pattern (module hook scoped to one route file) can be reused for other API routes.
- Status: Active

## 2026-10-17: The 4 skipped tests are redundant on purpose; their replacements test real SQL
- Decision (fact recorded): `npm test` always reports 4 skipped tests. They are tests 3, 5, 6 and 15 in `tests/voom-plans-credits-v1.test.mjs`, skipped deliberately by the original developers, not broken and not waiting on a missing tool. Leave them as they are; the baseline (`docs/baseline.md`) expects exactly 4.
- Before: On 2026-10-16 we assumed the skips were browser-layout tests missing a Chromium install. That was wrong: Google Chrome is installed, the test helper finds it, and all 25 browser-layout tests pass.
- Why they are redundant: migration `0035_voom_plans_credits.sql` moved the credit-ledger rules out of app code and into three Postgres functions (`reserve_media_credits`, `refund_media_credits`, `settle_media_credits`) plus `voom_plan_allowance`. The old v1 file uses a simple fake database that only imitates tables, not functions, so those four tests can no longer exercise the real logic. Rather than delete them, the developers skipped each one with a note pointing to its replacement.
- Where the replacements are and what they cover:
  - Test 3 (Autopilot only auto-generates when all conditions hold) → `tests/voom-plans-credits-safety.test.mjs` sub-tests 5 and 6, plus the mode rules still active in v1 tests 1, 2 and 8.
  - Test 5 (refund when generation fails before creation) → `voom-plans-credits-safety` sub-test 9, and `tests/workflow-video-hard-timeout.test.mjs` test 4c.
  - Test 6 (no double charge for the same generation id) → `voom-plans-credits-safety` sub-test 8, and `tests/manual-replenish-cost-safety.test.mjs` test 5b (two fast clicks pay once).
  - Test 15 (remaining credits = allowance + purchased − charged) → `voom-plans-credits-safety` sub-tests 4 and 7.
- How the replacements work: `voom-plans-credits-safety` uses the helper `tests/helpers/pglite-supabase.mjs`, which starts PGlite (a real Postgres running inside Node, no install needed), applies every file in `supabase/migrations/` in order, then calls the actual database functions. So the replacements prove the real SQL that production runs, which is stronger than the old fake-table tests ever were. All replacement tests pass (verified 2026-10-17).
- Consequences: If someone later changes the credit rules, edit the SQL in a new migration and extend `voom-plans-credits-safety`, not the v1 file. If a future run shows a skip count other than 4, something changed and must be explained. Also noted: the browser-test helper (`tests/helpers/rendered-surface.mjs`) has no timeout on page measurements, so a stalled Chrome can hang `npm test`; seen once, fix not yet scheduled.
- Status: Active

## 2026-10-16: 2FA comes before onboarding
- Decision: Build 2FA (authenticator-app codes, optional per user) right after forgot-password and Google sign-in, before the onboarding rebuild.
- Before: The audit recommended deferring 2FA until after onboarding because it changes the central "who is logged in" check.
- Why: Gurnoor's call; he wants the sign-in area finished as one block.
- Prompted by: Gurnoor's answer on 2026-10-16.
- Consequences: The 2FA step must be tested extra carefully (it can lock users out if wrong); onboarding starts one step later.
- Status: Active

## 2026-10-16: LinkedIn will post as both the founder's profile and the company page; Voom has no registered company yet
- Decision: Target both personal-profile and company-page posting on LinkedIn.
- Before: Open question (profile vs page vs both).
- Why: Gurnoor's call.
- Prompted by: Gurnoor's answer on 2026-10-16.
- Consequences: Voom has **no registered legal company**, and LinkedIn's Community Management API (required for company-page posting and for page analytics) only accepts registered legal organizations — so the company-page half is blocked until a company is registered. Personal-profile posting ("Share on LinkedIn") can proceed sooner, but LinkedIn keeps personal-post analytics closed, so there is no measurement loop for personal posts. Registering a company is on the critical path; Meta's full app approval is also expected to need a verified business (confirm during the application).
- Status: Active

## 2026-10-16: Instagram posting is not Meta-approved yet
- Decision (fact recorded): Meta App Review has NOT been passed. Posting currently works only because the app is in its pre-approval state, where users with a Business/Professional Instagram account connected to the developer setup can post. Real customers cannot use it until Meta approves the review.
- Prompted by: Gurnoor's answer on 2026-10-16.
- Consequences: Start the Meta App Review early (it needs the privacy/terms pages, a screencast, and likely business verification). Until it passes, test publishing with our own accounts only.
- Status: Active

## 2026-10-15: Fix the current app instead of rebuilding from scratch
- Decision: Keep the existing codebase and fix/extend it.
- Before: The plan was a from-scratch rebuild, treating the live app only as a behaviour reference.
- Why: A code review found a disciplined codebase: about 70k lines, ~1,600 passing tests, security rules on all 64 tables, and working publishing queues with encrypted platform tokens. Rebuilding that plumbing would take months and add nothing new. Rejected: full rebuild (too slow); keep building as-is (it is over-built in areas we don't need yet and missing the brand/onboarding moat).
- Prompted by: Access to the real repo and the review in `reference/voom-real-code-review.md`; the rebuild plan was judged too slow.
- Consequences: Work is lean and incremental. Unneeded features stay in the code, not deleted.
- Status: Active

## 2026-10-15: Target platforms are Instagram, TikTok and LinkedIn
- Decision: Focus on Instagram, TikTok and LinkedIn.
- Before: The app supports Instagram, TikTok, YouTube and email. LinkedIn does not exist.
- Why: Gurnoor's product direction.
- Prompted by: Re-planning after the code review.
- Consequences: LinkedIn must be built from zero and needs LinkedIn's Community Management API approval for company pages (registered legal entity, review; weeks to months). YouTube and email code stay but are not a focus.
- Status: Active

## 2026-10-15: Order of work: auth basics, then onboarding, then content quality
- Decision: (0) put repo under git and run it locally; start slow platform approvals now; (1) forgot password; (2) Google sign-in; (3) 2FA, possibly deferred until after onboarding; (4) onboarding rebuilt as a Brand Kit; (5) feed Brand Kit into content generation; (6) LinkedIn.
- Before: No agreed order.
- Why: Cheapest and most necessary first; onboarding is the biggest lever on content quality; external approvals are the longest lead time.
- Prompted by: Gurnoor's direction and the audit (`voom-fix/AUDIT.md`).
- Consequences: Only the files each step needs are changed.
- Status: Active

## 2026-10-15: Onboarding becomes a "Brand Kit": take what they have, ask what they don't
- Decision: Onboarding collects existing assets first (website, Instagram posts, logo, reference posts, brand docs), then asks guided questions with examples for gaps, including an explicit "what we don't want" list. It ends with a MARA-written Brand Brief the user confirms.
- Before: 8 short steps of chips and one free-text description; no assets; the website was saved only for email; one Skip button skipped everything.
- Why: Content can only be on-brand if the brand is captured properly. Examples prevent decision paralysis.
- Prompted by: Gurnoor's requirements and the audit finding that generation receives only ~7 short fields.
- Consequences: One new table (`brand_kits`) and one storage bucket. Existing `businesses` columns are still written so nothing breaks.
- Status: Proposed (awaiting Gurnoor's OK on the question list)

## 2026-10-16: Repo instructions are agent- and session-agnostic
- Decision: All working rules live in `AGENTS.md` (the file most AI coding tools read); `CLAUDE.md` is only a pointer to it. Everything a fresh session needs (rules, `ARCHITECTURE.md`, `DECISIONS.md`) lives in the repo itself, so any tool and any new session starts with the same knowledge.
- Before: The rules were written in `CLAUDE.md`, which only Claude Code reads; `AGENTS.md` held only the auto-generated Next.js notice.
- Why: Gurnoor may use different coding tools and sessions; the setup must not depend on which one.
- Prompted by: Gurnoor's instruction on 2026-10-16.
- Consequences: `next dev` keeps rewriting its own marked block at the top of `AGENTS.md`; our rules sit below it and are untouched. If a rule changes, edit `AGENTS.md`, never `CLAUDE.md`.
- Status: Active

## 2026-10-15: The coding agent never runs git
- Decision: The coding agent (Claude Code or any other tool) prints git commands; Gurnoor runs them himself.
- Before: No rule.
- Why: Gurnoor wants control over what is committed and pushed while the setup is being sorted out.
- Prompted by: Gurnoor's instruction.
- Consequences: Encoded in `AGENTS.md`.
- Status: Active

## Known state (updated 2026-10-16; original 2026-10-15 notes folded in)
- The working folder is now a **real clone** of `github.com/pavjassehgal-commits/voom-real` (Gurnoor has access as `gurnoor-epay`), on his own branch `gurnoor-dev`, level with `main` at commit `8067316` (15 Oct 22:27). The earlier zip, which the audit used, matched `main` as of 13 Oct 16:13 (commit `b710063`), so the audit's baseline is precisely known.
- What landed on `main` since that baseline (PRs #74–#79, ~4,800 lines in 62 files): TikTok audit-compliance work (a per-post consent sheet, server-side video-duration checks, fail-closed preview validation, a TikTok site-verification file) and email work (a cleaner email-sending layer, an email campaign results panel). **None of it touches auth, onboarding, navigation, the plan route or the two known bugs — the audit's findings and the plan order are unaffected.**
- The repo is **actively developed by its owner** (6 PRs merged 13–15 Oct). Consequences: pull `main` into `gurnoor-dev` before every work session, and agree a division of work with the owner — they are investing in email (which this plan sidelines) and appear to be preparing the TikTok audit already, so check before filing a duplicate audit application.
- Migrations 0052–0054 are still absent from `main` (0051 jumps to 0055); the fresh pull did not change that. Harmless for a fresh test database (the files present apply in order); which migrations production runs is still unconfirmed.
