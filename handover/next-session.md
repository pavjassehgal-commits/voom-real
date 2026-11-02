# Next session: where we are, what is next, what is open

**Read this after `ARCHITECTURE.md` and `DECISIONS.md`, before doing anything. Update it at the
end of every task** (the "Where we are" numbers, the "What is next" order, the open items). It is
the status board for Gurnoor and for whichever AI tool opens the repo next. It is a separate file
on purpose: a merge from `main` can touch `ARCHITECTURE.md`, `DECISIONS.md` and `AGENTS.md`, and
this file must survive that untouched.

Last updated: 2026-11-02, at the end of Phase C of `handover/merge-plan.md` (our Brand page and
onboarding in the redesign; `handover/phase-c-plan.md`, `DECISIONS.md` 2026-11-02). **The next
task is slice 8, Instagram import, plan first.** Before that, Gurnoor's browser check of Phase C
and the commit (section 1).

---

## 1. Where we are

- **Folder and branch:** work happens in `Desktop/voom/voom-merge` on branch
  `merge-main-2026-10-31` (rename later if wanted; Gurnoor's call). It contains everything from
  `gurnoor-dev` (17 commits) plus GitHub `main` at `ea1676b` (73 commits), merged on 2026-11-01:
  merge commit `a958352`, follow-ups `bfaa2a3`, `665caa5`, `07cc603` (B8 docs), then the Phase C
  commit of 2026-11-02. Phase C is done, so the old folder `voom-real-main` (branch `gurnoor-dev`,
  tag `pre-merge-2026-10-31`) can be retired when Gurnoor is comfortable: `git worktree remove
  ../voom-real-main` from this folder (the branch and tag stay in git). The `voom-main-check`
  worktree was removed on 2026-11-01.
- **Pushed?** If `git status` says "ahead of origin", push (`git push`).
- **Phase C browser check:** Gurnoor had not yet run it when this was written. The list: all 11
  screens at desktop and phone width, "Read my website" (eatlexis.com), Finish setup → "Your
  workspace is ready" → Go to dashboard, then `/app/onboarding` again as a finished account (should
  land on Today after a blank instant), the Brand page, and a post with Existing content in Post
  Studio. Anything off: fix it as a small follow-up, then the pull request (section 2).
- Latest checks (2026-11-02, full run after Phase C):

  | Check | Result | Meaning |
  |---|---|---|
  | `npm test` | 2315 tests: 2292 pass / 19 fail / 4 skipped / 0 todo (about 120 s) | The 19 are named in `docs/baseline.md` Notes: 14 parked trend tests (2 more aged out with the date on 2026-11-02), 5 of `main`'s own tests that fail identically on plain `main`. The 3 cleanup flakes did not show this run; when they do, 22. |
  | `npm run typecheck` | clean | |
  | `npm run lint` | 0 errors / 15 warnings | Pre-existing. New work must not add one. |

  `docs/baseline.md` has the rule: pass count never drops, fail stays at the named tests, lint
  errors 0, warnings 15 or fewer. Trend tests pin October dates against the real clock, so more of
  them may age out as days pass; a new trend failure is that, not a regression, if it fails the
  same way alone and names a 2026-10 date.

### What this branch holds

| Where it came from | What | Where to look |
|---|---|---|
| `gurnoor-dev`, 10-16 to 10-29 | Agent rules, architecture map, decisions log, baseline; forgot-password and Google sign-in; delete post and cancel approval; Brand Kit v2 slices 1 to 7 (table below) | `DECISIONS.md` 2026-10-15 to 10-28 |
| `main`, 10-16 to 10-31 | The Figma redesign of every screen (shell, Today, Create, Content, Marketing Plan, Approvals, Automations, MARA, Calendar, Contacts, Channels, Performance, Settings, homepage, login, signup, motion, haptics, notifications); LinkedIn personal text publishing; native TikTok/Shorts plan videos; YouTube MP4 and resumable uploads; Instagram token renewal; AI usage and cost tracking; automation emergency pause and approval integrity; rolling cadence windows and slot leases | `handover/merge-plan.md` section 0 table; `docs/*.md` from `main` (`mara-automation-launch.md`, `scheduled-workers.md`, `linkedin-personal-publishing.md`, `native-plan-video-generation.md`) |
| The merge itself, 11-01 | 26 conflicts resolved, our migration 0059 renumbered **0075**, 15 tests re-pointed, wizard footer with toast clearance and the haptic warning | `DECISIONS.md` 2026-11-01 |
| Phase C, 11-02 | Brand page on `PageHeader` + `voom-card`; the 11-screen wizard in `main`'s setup layout with the 3D icons (Manual / Assisted / Autopilot reuse main's automation icons), inspiration chips, `SetupComplete` at the end with Edit links to the Brand page, `completedOnServer` bypass in the wizard (page no longer redirects); `AnalyzingScreen` deleted; 3 tests back to original intent; `ARCHITECTURE.md` full pass ("What `main` built") | `handover/phase-c-plan.md`, `DECISIONS.md` 2026-11-02 |

### Brand Kit v2: slices built, one line each

The design and the full detail per slice: `docs/brand-kit-v2-design.md`, section "Build order".

| Slice | Built | What it does | Test file |
|---|---|---|---|
| 1 | 10-22 | `brand_kits` table (migration 0075, was 0059) and the one brand reader generation uses (`lib/brand/context.ts`) | `tests/brand-kit-context.test.mjs` |
| 2 | 10-23 | Brand Hub page `/app/brand`: every section editable in place, history | `tests/brand-hub.test.mjs` |
| 3 | 10-24 | New onboarding (now 11 screens), five required answers, Settings links to Brand | `tests/onboarding-v2.test.mjs` |
| 4 | 10-24 | MARA reads the description and prefills the screens; facts wait for one-tap Confirm | `tests/brand-extract.test.mjs` |
| 5 | 10-26 | Logo, product photos, past posts; logo colours; vision reads images; email brand fill | `tests/brand-assets.test.mjs` |
| 5b | 10-28 | Post Studio: MARA looks at an uploaded photo with a brand hint; "What is this post for?" | `tests/post-vision.test.mjs` |
| 6 | 10-27 | Voice screen and Brand page write three sample captions to sort | `tests/brand-voice.test.mjs` |
| fix | 10-28 | Leftover image files swept after Finish and Brand page saves; colours go with the logo | `tests/brand-assets.test.mjs` |
| 7 | 10-29 | "Read my website": text read plus one homepage screenshot for colours and look; MARA drafts the description; colours kept per source | `tests/brand-website.test.mjs` |

All of it was browser-checked by Gurnoor on 2026-11-01 inside the merged app (B7), before the
Phase C restyle: the 11 screens, "Read my website", Finish, `/app/brand`, the Brand entry in the
new sidebar, Google and Forgot password on login. The Phase C look is checked by the tests
(2026-11-02) and awaits Gurnoor's browser pass (section 1).

---

## 2. What is next (agreed order)

Each task follows `AGENTS.md`: a short plan first, wait for Gurnoor's OK, build, `npm test` plus a
browser check, update the docs, print the git commands for Gurnoor.

1. **Finish Phase C:** Gurnoor's browser check (section 1), any small fix it turns up, then the
   first **pull request from `merge-main-2026-10-31` to `main`** so the other developer sees the
   Brand Kit work (Phase D habit, section 6, step 6). Gurnoor opens it on GitHub; the AI tool
   prints nothing for it beyond a suggested title and description.
2. **Slice 8: Instagram import.** Design: `docs/brand-kit-v2-design.md`, section "Instagram
   import (slice 8)" and build-order item 8. Not yet planned in detail; the plan is the first step.
3. **Slice 9 (optional): the brand kit everywhere** (Reel and Story visuals, campaigns, the
   coordinator still read the old business fields).
4. **Anything from section 4 whose trigger has arrived.**

Beyond Brand Kit v2, the older agreed order (`DECISIONS.md` 2026-10-15 and 10-16) is: 2FA before
onboarding goes public, then LinkedIn company pages (personal text posts exist now, from `main`),
then Stripe billing.

---

## 3. How we work (the short version; `AGENTS.md` is the binding one)

- Gurnoor owns the product and is not a developer: plain language, lead with the result, say
  plainly when a test is red or you are unsure, disagree when needed.
- Plan first, stop, wait for "OK" or "go ahead", then build only what the plan says.
- **The AI tool never runs a git command that changes anything.** It prints the commands in a
  code block; Gurnoor runs them. Commit messages end with
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>` (when the tool is Claude).
- Keys only in `.env.local`. Only the dev Supabase project, never production. Ask before deleting.
- Every change: `npm test` (report the counts), typecheck, lint, browser check, update
  `ARCHITECTURE.md` / `DECISIONS.md` / `docs/baseline.md` / this file in the same change.
- Say what you are doing while you work; a long silent stretch is a problem (Gurnoor, 2026-11-01).

---

## 4. Open items (not blocking, each with its trigger)

| Item | What | Trigger / when | Recorded in |
|---|---|---|---|
| Parked trend test failures (14) | `tests/trends-universal.test.mjs` (6), `trends-demo` (4), `trends-gp-replenish` (2), `trends-wikidata-activation` (2, since 2026-11-02): fixtures pin October dates against the real clock; the first 12 fail identically on plain `main`. Not brand work. More may age out as days pass. | Gurnoor parked them until the trend feature is understood. | `DECISIONS.md` 2026-10-23 and 2026-11-01, `docs/baseline.md` |
| `main`'s own 5 red tests | `approval-state-lockdown` (its LinkedIn cron route lacks the Bearer check), `linkedin-production-release` (its `vercel.json`), `perf-regression` ×2 (storage signing), `product-truth-cleanup` (four channels vs LinkedIn). Identical on plain `main` at `ea1676b`. | Tell the other developer, or fix on a later merge if `main` fixes them first. | `docs/baseline.md` Notes |
| Browser-test helper: leak and no timeout | `tests/helpers/rendered-surface.mjs` leaves one Chrome profile folder per scenario in the system temp dir (803 folders, 4.2 GB, deleted by hand on 2026-11-01 with Gurnoor's OK; they come back a few per run) and has no limit on page scripts, so a script waiting for a missing element hangs `npm test` (happened at the merge). `tests/rendered-surface-cleanup.test.mjs` is a concurrency flake for the same reason. | Fix as a small task when a hang or disk space bites again; a per-scenario timeout plus cleanup of the temp folder. | `docs/baseline.md` Notes, `DECISIONS.md` 2026-10-17 and 2026-11-01 |
| Wizard cards without 3D icons | The six avoid-rules and the LinkedIn "coming soon" channel card are plain white cards; every other answer has the designers' icon. | If the designers draw them, or if Gurnoor wants placeholders. | `DECISIONS.md` 2026-11-02 |
| LinkedIn not configured on dev | The five `LINKEDIN_*` vars (`.env.example`) are unset; the Channels card says "not configured", nothing publishes. | When LinkedIn is to be tested; `docs/linkedin-personal-publishing.md`. | `handover/changes-log.md` 2026-11-01 |
| Worker schedules not re-run on dev | `main` rewrote `supabase/ops/schedule-workers.sql`. | Before relying on scheduled publishing on dev; before production. | `handover/changes-log.md` 2026-11-01 |
| New branch on GitHub with migrations 0071 and 0072 | `fix/automation-mode-normalization` (3 commits) is not on `main` yet. When it lands, the next routine merge brings two more migrations to run on dev. | The next merge of `main` (Phase D habit, every 2 or 3 days). | `DECISIONS.md` 2026-11-01 |
| Timing flake (1) | "loadPerformanceReport itself stays parallel and dedupe-safe" in `tests/perf-regression.test.mjs` sometimes fails in a full run, always passes alone. | Only if it starts failing alone. | `docs/baseline.md` Notes |
| DNS rebinding in the website reader | The reader resolves a site's address and refuses private ones, then lets `fetch` and Chromium resolve again. **Planned fix:** pin the resolved address. | Before a public launch, or before leaving Vercel. | `DECISIONS.md` 2026-10-28 and 2026-10-30; `lib/brand/website-fetch.ts` header |
| Website read-again from the Brand page | A site can only be read during onboarding today. | When an owner asks, or with slice 9. | design doc item 7 "Not built" |
| Screenshots of further pages | Only the top of the homepage is looked at for colours and look. | If homepage-only proves too thin in real use. | design doc item 7 "Not built" |
| Chromium memory on Vercel | The homepage screenshot runs a packaged headless Chromium inside the onboarding server action (`maxDuration = 60`). If production logs show out-of-memory or "browser closed", raise the function memory. | First production deploy with slice 7. | `handover/production-setup.md` |
| Production deploy steps not yet done | `handover/changes-log.md`: migration 0075, the nine `main` migrations, LinkedIn vars and app, worker schedules, the vision env vars, the Chromium memory check, Google sign-in's production OAuth client. Dev is done for all but LinkedIn and the schedules. | The next production deploy; work through the table top to bottom. | `handover/changes-log.md` |
| Reference images in image generation | Product photos and past posts are described to the image model as text only. | A later design decision. | `ARCHITECTURE.md` "Not built yet" |

---

## 5. Environment facts a new session needs

- Run locally: `npm run dev` at http://localhost:3000, from `voom-merge`. Only one dev server at a
  time (port 3000); the old folder's server must be stopped first. **Restart the dev server after
  any change to `next.config.ts`.**
- Node 26, npm 11, macOS. `npm test` takes about 130 s; the browser tests use the Google Chrome in
  `/Applications` and skip themselves if it is missing. If a run passes 4 minutes, it is hung:
  stop it, find the file (`ps` shows the `node --test` worker and its `--headless=new` Chrome),
  run that file alone.
- `.env.local` (never committed) holds the keys; the names are all in `.env.example`. Brand Kit v2
  uses `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL`, `AI_VISION_MODEL` plus
  `AI_VISION_PROVIDER` / `AI_VISION_API_KEY` / `AI_VISION_BASE_URL` or `OPENROUTER_API_KEY`,
  `VOOM_CHROMIUM_PATH` (optional). `main` added `LINKEDIN_*` (five) and the optional
  `YOUTUBE_UPLOAD_MAX_BYTES`.
- Models in use on the dev machine: text through Groq, `openai/gpt-oss-120b`; vision through
  OpenRouter, `google/gemini-2.5-flash`. Learned the hard way (`DECISIONS.md` 2026-10-27): the text
  model's reasoning counts against `max_tokens`, so structured calls use caps of 1500; Groq rejects
  the `reasoning: { effort }` field.
- Supabase: the **dev project only**. Migrations run to `0075_brand_kits.sql` with gaps (0052–0054,
  0060, 0065, 0069, 0071–0074). Fifteen tests list the migration files or pin "newest is 0075" and
  must move with any new one (`grep -rln "0075_brand_kits" tests`). Storage buckets `brand-kit`
  (private) and `main`'s YouTube uploads bucket (migration 0066). The nine `main` migrations were
  applied through the SQL editor on 2026-11-01.
- Hourly limits per user (`lib/rate-limit.ts`): extract 10, asset upload 60, vision 40, voice 20,
  website text 10, website look 10. Hitting one shows a plain message; wait an hour or delete that
  user's row for the bucket in the `voom_rate_limits` table on the dev project.
- Browser checks: Gurnoor runs them on a **spare onboarding profile** so the real one is not
  changed. Sites used for the website reader: `https://blabliblulife.com/` (slow, JavaScript-heavy)
  and `https://eatlexis.com/` (fast). The AI tool cannot sign in as Gurnoor.
- Server logs to watch during a website read: `[brand-website] text`, `[brand-website] look`,
  `[brand-website] screenshot failed`.

---

## 6. Keeping up with `main`: every 2 or 3 days (Phase D of the merge plan)

The 2026-10-31 merge took a full session because 20 days had passed. The habit that prevents a
repeat, Gurnoor running the git lines, the AI tool resolving conflicts and reading results:

1. `git fetch origin && git log --oneline HEAD..origin/main` to see what is new (and
   `git ls-tree --name-only origin/main supabase/migrations/ | tail -3` for new migrations).
2. `git merge origin/main`. Usually zero or one conflict. Rules when a conflict does appear:
   - `AGENTS.md`, `DECISIONS.md`, `ARCHITECTURE.md`, `handover/*`: keep both sides.
   - `package.json` / `package-lock.json`: keep both dependency lists, then `npm install` and
     commit the regenerated lock file.
   - `components/voom/onboarding/OnboardingWizard.tsx`, `app/app/onboarding/page.tsx`: ours is
     a different flow; if `main` changed its wizard again, re-do the change by hand in ours.
   - `components/voom/shell/nav.ts`: theirs plus our Brand entry after Today.
   - `app/app/(shell)/settings/page.tsx`: theirs, with the brand section as our link card.
   - A new migration numbered 0075 or above on `main`: ours stays 0075 if theirs is higher;
     if theirs is also 0075, ours moves to the next free number and the fifteen test pins with it.
3. `npm install` if the lock file changed, restart the dev server, `npm test`, `npm run typecheck`,
   `npm run lint`. Compare with section 1. A new failure outside the named 20 is either `main`'s
   (check it on a plain `main` worktree) or the merge's (fix it).
4. New `main` migrations: apply them to the dev project (SQL editor) and add a changes-log row.
5. Update section 1 here and add a `docs/baseline.md` row if the counts changed.
6. When a slice is done, open a pull request from this branch to `main` so the other developer
   sees our work. The first one is due after Phase C's browser check (section 2, item 1).
