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
- Rule of thumb: pass count ≥ 1665, fail = 0, typecheck clean, lint errors = 0, lint warnings ≤ 17.
  If a task legitimately adds or removes tests, record the new numbers here with the date.

## History
| Date | Tests pass / fail / skip | Typecheck | Lint err / warn | Change |
|---|---|---|---|---|
| 2026-10-16 | 1665 / 0 / 4 | clean | 0 / 17 | Baseline, no code changes |
