# Quality baseline

Recorded 2026-10-16 on branch `gurnoor-dev` at commit `8067316` (level with `main`), before any
of our changes. **Every later step must match or beat these numbers.** Re-run the three commands
after each task and compare.

Environment: Node v26.0.0, npm 11.12.1, macOS.

| Check | Command | Result |
|---|---|---|
| Tests | `npm test` | 1669 tests: **1665 pass, 0 fail, 4 skipped** (took ~97 s) |
| Types | `npm run typecheck` | **Clean** (exit 0, no errors) |
| Lint | `npm run lint` | **0 errors, 17 warnings** (exit 0) |

## Notes
- The 4 skipped tests are all in `tests/voom-plans-credits-v1.test.mjs` (numbers 3, 5, 6 and 15)
  and are skipped **on purpose** by the original developers. Each one has a note explaining that
  the credit-ledger logic it covered moved into a database function (migration 0035), which that
  file's simple fake database cannot model, and naming the test that now covers the same
  behaviour against real SQL (`voom-plans-credits-safety`, `manual-replenish-cost-safety`,
  `workflow-video-hard-timeout`). Those replacement tests pass. The 4 skips are expected and
  should stay at 4.
- The 25 browser-layout tests (`today-v2`, `voom-2-mobile-overflow`, `voom-core-workspace-v2`)
  run in a real headless Chrome and all **pass**. They use the Google Chrome installed in
  `/Applications`; if that is ever missing they skip themselves with a "no Chromium" message.
  Known weakness: the helper (`tests/helpers/rendered-surface.mjs`) has a 30 s limit on Chrome
  starting but no limit on the page measurements after that, so a stalled Chrome can hang
  `npm test` indefinitely (seen once on 2026-10-16; normal runs take ~95 s). If a run passes
  ~3 minutes, stop it and run it again.
- One test is timing-sensitive under full-suite load: "loadPerformanceReport itself stays parallel
  and dedupe-safe" in `tests/perf-regression.test.mjs` measures that two reads overlap in time and
  has failed twice (2026-10-28 and 2026-10-29) in full runs on a busy machine, passing on its own
  every time (three of three each time it was checked). A full run showing 10 failures with that
  one extra is the flake, not a regression; run that file alone to confirm.
- The 17 lint warnings are all pre-existing: unused variables (11), `<img>` instead of Next's
  `<Image>` (3), one `window.location.assign()` in `PostEditorModal.tsx`, and unused imports in
  two test files. New work must not add warnings; removing some is fine but not required.
- Rule of thumb: pass count ≥ the latest row below, fail = 0, typecheck clean, lint errors = 0,
  lint warnings ≤ the latest row below. If a task legitimately adds or removes tests, record the
  new numbers here with the date.
- **After the 2026-11-01 merge with `main`** (`handover/merge-plan.md` B4) the suite is 2316 tests
  and the expected result is **2290 pass / 20 fail / 4 skipped / 2 todo**. The 20 are: (a) the 12
  parked trend failures, now `trends-universal` (6), `trends-demo` (4), `trends-gp-replenish` (2);
  (b) 5 failures that are **identical on a plain checkout of `main` at `ea1676b`** (proved
  2026-11-01 in a sibling worktree): `approval-state-lockdown` "every cron worker uses the
  constant-time Bearer check" (main's LinkedIn cron route), `linkedin-production-release` (main's
  `vercel.json` lists more branches than its test), `perf-regression` ×2 (storage signing is no
  longer one batched call), `product-truth-cleanup` (expects four channels, main added LinkedIn);
  all 12 trend failures fail the same way there too; (c) 3 in `rendered-surface-cleanup.test.mjs`
  that failed once under full-suite load and pass alone (5/5) and in two other full runs: a
  concurrency flake, like the perf one above. None of the 20 touches Brand Kit v2 or the merge
  work. The 2 todo are main's two visual wizard assertions parked until Phase C
  (`onboarding-icons`, `redesign-batch-4a`). Hang note: `tests/motion-system.test.mjs` hung the
  whole run at the merge because its page script looked for the wizard's `<footer>` and our wizard
  had none; fixed by giving our wizard that footer (with `data-toast-clearance`). The helper's
  missing page-script timeout (above) is what turned a failing lookup into a hang.

## History
| Date | Tests pass / fail / skip | Typecheck | Lint err / warn | Change |
|---|---|---|---|---|
| 2026-10-16 | 1665 / 0 / 4 | clean | 0 / 17 | Baseline, no code changes |
| 2026-10-17 | 1668 / 0 / 4 | clean | 0 / 16 | Three truthfulness fixes (+3 tests, 5 tests reworded, 1 unused variable removed). See DECISIONS 2026-10-17. |
| 2026-10-17 | 1673 / 0 / 4 | clean | 0 / 16 | Forgot-password flow (+5 tests). See DECISIONS 2026-10-17. |
| 2026-10-20 | 1674 / 0 / 4 | clean | 0 / 16 | Password reset signs out everywhere and returns to login (+1 test, 2 tests extended). See DECISIONS 2026-10-20. |
| 2026-10-20 | 1677 / 0 / 4 | clean | 0 / 16 | "Continue with Google" on login and signup (+3 tests). See DECISIONS 2026-10-20 (Google). |
| 2026-10-22 | 1687 / 0 / 4 | clean | 0 / 16 | Brand Kit v2 slice 1: migration 0059, brand reader wired into generation (+10 tests, 10 migration-head assertions moved to 0059). See DECISIONS 2026-10-22. |
| 2026-10-23 | 1688 / **6** / 4 | clean | 0 / 16 | Delete post + cancel approval in the editor (+7 tests, all pass). The 6 failures are `tests/trends-universal.test.mjs` only: a pre-existing date time bomb (fixture clock 2026-10-13 vs the database's real `now()` and a 10-day evidence expiry), failing from 2026-10-23 regardless of code. Open item; see DECISIONS 2026-10-23. |
| 2026-10-23 | 1695 / **6** / 4 | clean | 0 / 16 | Brand kit versions carry forward by field (+2 tests); "Existing content" source switch on Instagram Posts (+5 tests). Same 6 parked trend failures. See DECISIONS 2026-10-23 (carry forward / source switch). |
| 2026-10-23 | 1706 / **6** / 4 | clean | 0 / 16 | Brand Kit v2 slice 2: Brand Hub page (+10 tests), plus a fix found in the browser check: typed lists kept swallowing commas and new lines (+1 test). Same 6 parked trend failures. See DECISIONS 2026-10-23 (Brand Hub). |
| 2026-10-24 | 1714 / **6** / 4 | clean | 0 / 16 | Brand Kit v2 slice 3: new ten-screen onboarding (+8 tests; 3 existing tests reworded for the new Connect screen, the Settings link card and the retired budget/permission keys). Same 6 parked trend failures. See DECISIONS 2026-10-24. |
| 2026-10-24 | 1724 / **6** / 4 | clean | 0 / 16 | Brand Kit v2 slice 4: MARA reads the description and prefills the screens, unconfirmed facts with one-tap Confirm (+10 tests). The first build's separate confirmation screen was removed after the browser check found it a double ask. Same 6 parked trend failures. See DECISIONS 2026-10-24 (slice 4). |
| 2026-10-26 | 1738 / **9** / 4 | clean | 0 / 16 | Brand Kit v2 slice 5: brand images, logo colours, vision, email fill (+17 tests; 5 assertions reworded for the eleventh screen and the ninth Brand page section). The 9 failures are all trend tests: the 6 parked ones plus 3 in `trends-demo` and `trends-gp-replenish` that hard-code 24 and 26 October and started failing with the calendar (same time bomb, no brand code involved). See DECISIONS 2026-10-26. |
| 2026-10-27 | 1749 / **9** / 4 | clean | 0 / 16 | Brand Kit v2 slice 6: MARA writes three sample captions to sort, on the voice screen and the Brand page (+10 tests); token cap raised after the browser check; History line now names only the fields that changed (+1 test, 1 assertion reordered). Same 9 parked trend failures. See DECISIONS 2026-10-27. |
| 2026-10-28 | 1752 / **9** / 4 | clean | 0 / 16 | Brand images: leftover files swept after Finish and after a Brand page images save; colours go with the logo (+3 tests, 1 extended). Same 9 parked trend failures. See DECISIONS 2026-10-28. |
| 2026-10-28 | 1761 / **9** / 4 | clean | 0 / 16 | Slice 5b: MARA looks at an uploaded photo, with a brand hint, before suggesting its caption, and the caption serves the owner's "What is this post for?" line (+9 tests; 2 existing assertions reworded for the seen path). Same 9 parked trend failures. See DECISIONS 2026-10-28 (slice 5b). |
| 2026-11-01 | 2290 / **20** / 4 (+2 todo) | clean | 0 / 15 | Merged GitHub `main` (73 commits, head `ea1676b`: redesign, LinkedIn, native TikTok/Shorts videos, YouTube uploads, cost tracking, automation safety) into Gurnoor's branch; our migration 0059 renumbered 0075. 26 conflicts resolved per `handover/merge-plan.md` B2; 8 of our tests and 7 of main's re-pointed at the merged shape; wizard footer gained `data-toast-clearance` and the haptic warning. The 20 failures: 12 parked trend + 5 identical on plain `main` + 3 cleanup flake (Notes above). See DECISIONS 2026-10-31 and 2026-11-01. |
| 2026-10-29 | 1773 / **9** / 4 | clean | 0 / 16 | Brand Kit v2 slice 7: MARA reads the website in place from a "Read my website" button (text plus one homepage screenshot for the look, side by side), drafts the description with the text model, shows the read's state on screens 2 and 3 with "Try again" / "Back to the website", colours kept per source with the owner choosing which leads (+12 tests; 6 existing assertions reworded for the new colour shape, the website field's copy and the flow). Two new dependencies (`puppeteer-core`, `@sparticuz/chromium`). Same 9 parked trend failures. See DECISIONS 2026-10-28 (slice 7) and its 2026-10-29 notes. |
