# Next session: where we are, what is next, what is open

**Read this after `ARCHITECTURE.md` and `DECISIONS.md`, before doing anything. Update it at the
end of every task** (the "Where we are" numbers, the "What is next" order, the open items). It is
the status board for Gurnoor and for whichever AI tool opens the repo next. It is a separate file
on purpose: a merge from `main` can touch `ARCHITECTURE.md`, `DECISIONS.md` and `AGENTS.md`, and
this file must survive that untouched.

Last updated: 2026-10-31. **The next task is the merge with GitHub `main`: read
`handover/merge-plan.md` and start its Phase B.** Everything below describes the branch before that
merge; section 2's slice 8 comes after the merge and its Phase C.

---

## 1. Where we are

- Branch: `gurnoor-dev`, head `22a7421` (2026-10-29), 17 commits ahead of the local `main`
  (`8067316`, the baseline commit). Working tree clean. Remote: `origin` on GitHub
  (`pavjassehgal-commits/voom-real`). Other people's work lands on `main` through pull requests;
  on 2026-10-29 the remote also had new `codex/...` branches, so expect `main` to have moved.
- Latest checks (2026-10-29, full run on the commit above):

  | Check | Result | Meaning |
  |---|---|---|
  | `npm test` | 1773 pass / 9 fail / 4 skipped | The 9 are the parked trend tests (section 4). The 4 skips are on purpose. |
  | `npm run typecheck` | clean | |
  | `npm run lint` | 0 errors / 16 warnings | All 16 pre-existing. New work must not add one. |

  `docs/baseline.md` has the full history and the rule: pass count never drops, fail stays at the
  parked 9, lint errors 0, warnings 16 or fewer.

### What the 17 commits on this branch built (oldest first)

| Date | What | Where to look |
|---|---|---|
| 2026-10-16/17 | Agent rules (`AGENTS.md`), architecture map, decisions log, test baseline, three truthfulness fixes | `DECISIONS.md` 2026-10-15 to 10-17 |
| 2026-10-20 | Forgot-password flow; reset signs out everywhere; "Continue with Google" | `DECISIONS.md` 2026-10-20; `handover/production-setup.md` A6, A9 |
| 2026-10-23 | Delete post and cancel approval from the editor; brand kit versions carry forward by field; "Existing content" switch | `DECISIONS.md` 2026-10-23 |
| 2026-10-22 to 10-29 | **Brand Kit v2, slices 1 to 7** (below) | `docs/brand-kit-v2-design.md` "Build order" |

### Brand Kit v2: slices built, one line each

The design and the full detail per slice: `docs/brand-kit-v2-design.md`, section "Build order".
Each slice has a dated `DECISIONS.md` entry and one test file.

| Slice | Built | What it does | Test file |
|---|---|---|---|
| 1 | 10-22 | `brand_kits` table (migration 0059) and the one brand reader generation uses (`lib/brand/context.ts`) | `tests/brand-kit-context.test.mjs` |
| 2 | 10-23 | Brand Hub page `/app/brand`: every section editable in place, history | `tests/brand-hub.test.mjs` |
| 3 | 10-24 | New onboarding (now 11 screens), five required answers, Settings links to Brand | `tests/onboarding-v2.test.mjs` |
| 4 | 10-24 | MARA reads the description and prefills the screens; facts wait for one-tap Confirm | `tests/brand-extract.test.mjs` |
| 5 | 10-26 | Logo, product photos, past posts; logo colours; vision reads images; email brand fill | `tests/brand-assets.test.mjs` |
| 5b | 10-28 | Post Studio: MARA looks at an uploaded photo with a brand hint; "What is this post for?" | `tests/post-vision.test.mjs` |
| 6 | 10-27 | Voice screen and Brand page write three sample captions to sort | `tests/brand-voice.test.mjs` |
| fix | 10-28 | Leftover image files swept after Finish and Brand page saves; colours go with the logo | `tests/brand-assets.test.mjs` |
| 7 | 10-29 | "Read my website": text read plus one homepage screenshot for colours and look; MARA drafts the description from the site; colours kept per source (logo, website, owner) with the owner choosing which leads | `tests/brand-website.test.mjs` |

Slice 7 was browser-checked by Gurnoor on 2026-10-29 on a spare onboarding profile with the
perfume site `https://blabliblulife.com/`: the pages were read, the description was drafted, and
the website colours arrived (red and maroon) next to the logo colours.

---

## 2. What is next (agreed order)

Each slice follows the working rules in `AGENTS.md`: a short plan first, wait for Gurnoor's OK,
build, `npm test` plus a browser check, update the docs, print the git commands for Gurnoor.

1. **Slice 8: Instagram import.** Design: `docs/brand-kit-v2-design.md`, section "Instagram
   import (slice 8)" and build-order item 8. After the owner connects Instagram on the Connect
   screen, the existing official-API call (`lib/instagram/client.ts`, `getMedia`, at most 25
   posts) returns caption, type, link, date, likes and comments. Store those (media links expire,
   so any gallery re-fetches thumbnails); the three best-performing captions become voice
   examples. Until Meta reviews Voom's app, connect works only for accounts with a role on the
   Meta app, and the screen must say so. Tests expected: official client only, 25-post cap, no
   fetch without a connection. Not yet planned in detail; the plan is the first step.
2. **Slice 9 (optional): the brand kit everywhere.** Reel and Story visuals, campaigns and the
   coordinator still read the old business fields; switch them to `loadBrandContext()`. Reel video
   plans live in `lib/mara/video-ports.ts` and touching them means the video pipeline, which is why
   this was left for last (`DECISIONS.md` 2026-10-26, Consequences).
3. **Anything from section 4 whose trigger has arrived.**

Beyond Brand Kit v2, the older agreed order (`DECISIONS.md` 2026-10-15 and 10-16) is: 2FA before
onboarding goes public, then LinkedIn (profile plus company page), then Stripe billing. None of
these is started. `ARCHITECTURE.md` "Not built yet" is the short list.

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

---

## 4. Open items (not blocking, each with its trigger)

| Item | What | Trigger / when | Recorded in |
|---|---|---|---|
| Parked trend test failures (9) | `tests/trends-universal.test.mjs` (6), `trends-demo` and `trends-gp-replenish` (3) fix their clock to October dates while the database uses the real clock and evidence expires after 10 days. Failing since 2026-10-23 and 10-26 regardless of code. Not brand work. | Gurnoor parked them until the trend feature is understood. Fix = make the fixtures relative to today or freeze the database clock in the test. | `DECISIONS.md` 2026-10-23, `docs/baseline.md` rows |
| Timing flake (1) | "loadPerformanceReport itself stays parallel and dedupe-safe" in `tests/perf-regression.test.mjs` sometimes fails in a full run on a busy machine, always passes alone. A full run showing 10 failures with this one extra is the flake. | Only if it starts failing alone. | `docs/baseline.md` Notes |
| DNS rebinding in the website reader | The reader resolves a site's address and refuses private ones, then lets `fetch` and Chromium resolve again; a hostile site could answer differently the second time. **Planned fix:** pin the resolved address (connect to the checked IP with the host name in the request). | Before a public launch, or before leaving Vercel. | `DECISIONS.md` 2026-10-28 (slice 7) and 2026-10-30; `lib/brand/website-fetch.ts` header |
| Website read-again from the Brand page | A site can only be read during onboarding today. | When an owner asks, or with slice 9. | design doc item 7 "Not built" |
| Screenshots of further pages | Only the top of the homepage is looked at for colours and look. | If homepage-only proves too thin in real use. | design doc item 7 "Not built" |
| Chromium memory on Vercel | The homepage screenshot runs a packaged headless Chromium inside the onboarding server action (`maxDuration = 60`). If production logs show the screenshot failing with out-of-memory or "browser closed", raise the function memory to 1024 MB or more. The text read works without the browser. | First production deploy with slice 7. | `handover/production-setup.md`, vision paragraph |
| Production deploy steps not yet done | `handover/changes-log.md` has four rows with Prod "pending": migration 0059, the vision env vars (a decision: does production get an image model?), the Chromium function memory check, and Google sign-in's production OAuth client. Dev is done for all four. | The next production deploy; work through the table top to bottom. | `handover/changes-log.md` |
| Reference images in image generation | Product photos and past posts are described to the image model as text only; the files are never sent. | A later design decision. | `ARCHITECTURE.md` "Not built yet" |
| Images from an unfinished onboarding | Fixed on 2026-10-28 (swept after Finish and Brand page saves). Listed here so nobody re-reports the "known gap" line in the 2026-10-26 decision. | none | `DECISIONS.md` 2026-10-28 |

---

## 5. Environment facts a new session needs

- Run locally: `npm run dev` at http://localhost:3000. **Restart the dev server after any change
  to `next.config.ts`** (slice 7 added `serverExternalPackages` for the browser packages); a stale
  server shows "Export … doesn't exist" errors that are not real.
- Node 26, npm 11, macOS. `npm test` takes about 100 s; 25 layout tests use the Google Chrome in
  `/Applications` and skip themselves if it is missing.
- `.env.local` (never committed) holds the keys. The names are all in `.env.example`. The ones
  Brand Kit v2 uses: `AI_PROVIDER`, `AI_API_KEY`, `AI_BASE_URL`, `AI_MODEL` (the text model),
  `AI_VISION_MODEL` plus `AI_VISION_PROVIDER` / `AI_VISION_API_KEY` / `AI_VISION_BASE_URL` or
  `OPENROUTER_API_KEY` (the image model; everything image-related is off when the model is unset),
  `VOOM_CHROMIUM_PATH` (optional; without it the code finds the Google Chrome in `/Applications`,
  and in production uses the packaged `@sparticuz/chromium`).
- Models in use on the dev machine (2026-10-29): text through Groq, `openai/gpt-oss-120b`; vision
  through OpenRouter, `google/gemini-2.5-flash`. Two things learned the hard way, recorded in
  `DECISIONS.md` 2026-10-27: the text model's reasoning counts against `max_tokens`, so structured
  calls use caps of 1500, not 900; and Groq rejects the `reasoning: { effort }` request field.
- Supabase: the **dev project only**. Migrations go up to `0059_brand_kits.sql`; some tests pin
  "newest migration is 0059" and must move with any new one. Storage bucket `brand-kit` (private).
  Our 0059 was applied through the SQL editor (not the CLI), so renaming the file is safe; it
  becomes 0071 at the merge (`handover/merge-plan.md` B3).
- Hourly limits per user (`lib/rate-limit.ts`): extract 10, asset upload 60, vision 40, voice 20,
  website text 10, website look 10. Hitting one shows a plain message in the wizard; wait an hour
  or delete that user's row for the bucket in the `voom_rate_limits` table on the dev project.
- Browser checks: Gurnoor runs them on a **spare onboarding profile** (a throwaway account on the
  dev project) so the real one is not changed. Sites used for the website reader:
  `https://blabliblulife.com/` (perfume shop, JavaScript-heavy, slow to load) and
  `https://eatlexis.com/` (restaurant, fast). The AI tool cannot sign in as Gurnoor, so onboarding
  screens are checked by Gurnoor and the rest through scripts that call the app's own functions.
- Server logs to watch during a website read: `[brand-website] text`, `[brand-website] look`,
  `[brand-website] screenshot failed`.

---

## 6. After pulling `main`: checklist

**Superseded for the 2026-10-31 merge by `handover/merge-plan.md`**, which has the real list of
overlapping files, the migration renumbering (our 0059 becomes 0071) and the verification script.
The general checklist below stays for the routine small merges that follow (Phase D of that plan).

Gurnoor runs the git commands; the AI tool reads the result. The steps:

1. Before merging, the tool records the current counts (section 1) so there is something to
   compare with.
2. Gurnoor merges `main` into `gurnoor-dev` (or rebases; their call). Files on this branch that
   `main` is most likely to touch as well, and what to do if git reports a conflict in them:
   - `AGENTS.md`: keep both sides (ours adds one line about this file).
   - `DECISIONS.md`: keep both sides, newest entry at the top; both histories are true.
   - `ARCHITECTURE.md`: keep both sides, then read the merged file once for sentences that now
     contradict each other.
   - `package.json` / `package-lock.json`: keep both dependency sets (ours added `puppeteer-core`
     and `@sparticuz/chromium`), then `npm install` and commit the regenerated lock file.
   - `lib/rate-limit.ts`: keep both bucket lists.
   - `next.config.ts`: keep both (ours adds `serverExternalPackages`).
   - `components/voom/onboarding/OnboardingWizard.tsx`, `app/app/onboarding/page.tsx`: ours is a
     full rewrite (slice 3 onward); if `main` changed the old wizard, the change almost certainly
     needs re-doing by hand in the new one. Stop and plan it rather than resolving blind.
   - `supabase/migrations/`: if `main` added a migration numbered 0059 or higher, ours must be
     renumbered to come after it, and the tests that pin the newest number updated.
3. After the merge: `npm install` if the lock file changed, restart the dev server, then
   `npm test`, `npm run typecheck`, `npm run lint`. Compare with section 1 and the newest row of
   `docs/baseline.md`. A new failure outside the parked 9 and the one flake is a real regression:
   find whether it comes from `main`'s change or from the merge before touching anything.
4. If `main` applied new migrations, apply them to the dev project before browser-testing.
5. Update section 1 of this file with the new head commit and counts, and add a `docs/baseline.md`
   row if the counts changed.
