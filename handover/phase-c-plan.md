# Phase C plan: our Brand page and onboarding in the redesign (2026-11-02)

Approved by Gurnoor on 2026-11-02 with all four recommendations: reuse main's three automation
icons for Manual / Assisted / Autopilot; add main's "Need inspiration?" chips under the description
box; SetupComplete's Edit links go to the Brand page; delete `AnalyzingScreen.tsx`.

## What was found before planning

- The wizard (`components/voom/onboarding/OnboardingWizard.tsx`) kept the old look through the
  merge: emoji tiles, dark-theme error boxes, old `Btn`/`Chip`, plain top bar, timed
  "MARA is studying your brand" popup. main's wizard (`git show origin/main:components/voom/onboarding/OnboardingWizard.tsx`)
  has the sticky header with the step list, the art column, white `OptionCard` answers with the
  3D icons, a light footer and the real `SetupComplete` summary.
- Everything to borrow is in the tree: `public/redesign/onboarding-icons/*` (52 icons),
  `public/redesign/setup-art-*.webp` (5 panels), `components/voom/onboarding/SetupComplete.tsx`,
  `components/voom/redesign/ui.tsx` (`PageHeader`, `BTN`, `ChannelGlyph`), `voom-card` CSS.
- main's icon set already has "I decide everything" / "MARA drafts, I approve" /
  "MARA runs it end-to-end": one-to-one with Manual / Assisted / Autopilot.
- The old primitives (`components/voom/ui/primitives.tsx`) are still used by main's own
  Sidebar, Topbar, BottomBar and every modal, so `Btn`, `Chip`, `Tag`, `Input`, `Textarea` stay
  in the Brand Hub. Only `Card` (glassy) and `PageHead` (old title block) are swapped.
- main never changed `components/voom/modals/PostEditorModal.tsx` (our purpose line, "MARA saw",
  Existing content); only the Studio page around it. Phase C checks it in the browser, no code.
- About 60 test assertions pin exact sentences and code shapes in the wizard
  (`brand-website`, `brand-extract`, `brand-voice`, `brand-assets`, `onboarding-v2`,
  `product-truth-cleanup`). The restyle changes markup only; every sentence and the logic stay.

## Steps (in build order)

1. Brand page: `app/app/(shell)/brand/page.tsx` uses `PageHeader`; `BrandHub.tsx` sections become
   `voom-card`, light message boxes. Logic untouched.
2. `onboardingIcons.tsx`: Manual → auto-decide, Assisted → auto-approve, Autopilot → auto-end-to-end.
3. Wizard restyle: main's header, two-column layout with sticky art column (`StepIntro` verbatim,
   the artwork test pins its classes), `OptionCard`/`Mark`/`TINTS` for industry, goal, audience,
   personality, pace, automation, avoid rules; channel cards with `ChannelGlyph`; inspiration
   chips on the Describe screen; main's footer with Back / Skip this step / Continue (Continue
   stays the footer's last button for `tests/motion-system.test.mjs`). Our 11 screens, texts,
   per-screen Skip, five blockers and all slice 4 to 7 behaviour unchanged. Art per screen:
   mara (Name, Automation), voice (Images, Describe, Voice, Avoid, Channels), business (Basics,
   Brand Brief), audience (Audience), budget (Pace).
4. End of setup: Finish shows `SetupComplete`; wizard takes `completedOnServer` with main's
   `finishedBeforeMount` bypass; `app/app/onboarding/page.tsx` stops redirecting on the server
   (keeps `maxDuration = 60` and `visionEnabled`). `SetupComplete`: automation shows the mode
   title, Edit links go to `/app/brand`, copy says "on your Brand page". Delete `AnalyzingScreen.tsx`.
5. Tests back to their original intent: `onboarding-icons` (no emoji, icon per answer incl. the
   inspiration list), `redesign-batch-4a` (bypass + artwork), `onboarding-completion` (an
   onboarded owner's wizard renders nothing). `toast-stacking` keeps its "missing button" guard:
   no global Skip is our standing decision (DECISIONS 2026-10-24).
6. Docs: `ARCHITECTURE.md` full pass on what main built, `DECISIONS.md`, `docs/baseline.md`,
   `handover/next-session.md`.

## Tests

`npm test`, `npm run typecheck`, `npm run lint` after every step. Expected end: the two todo
tests pass, fail count stays at the named 20 (17 without the cleanup flake), lint 0 errors and
15 or fewer warnings. Browser check by Gurnoor on the spare profile: 11 screens at desktop and
phone width, "Read my website" (eatlexis.com), Finish setup → summary → Go to dashboard,
`/app/onboarding` again as a finished account lands on Today, Brand page, Post Studio with
Existing content.

## Risks

- A pinned sentence breaks a test: restore the sentence.
- The finished-account redirect moves from server to browser: a blank instant before Today
  (main accepted that for the summary screen).
- Long screens on phones (art hidden, cards stacked), same as main's wizard.
