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
- The 17 lint warnings are all pre-existing: unused variables (11), `<img>` instead of Next's
  `<Image>` (3), one `window.location.assign()` in `PostEditorModal.tsx`, and unused imports in
  two test files. New work must not add warnings; removing some is fine but not required.
- Rule of thumb: pass count ≥ the latest row below, fail = 0, typecheck clean, lint errors = 0,
  lint warnings ≤ the latest row below. If a task legitimately adds or removes tests, record the
  new numbers here with the date.

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
