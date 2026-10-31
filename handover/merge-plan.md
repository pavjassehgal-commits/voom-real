# Merge plan: bringing GitHub `main` (the other developer's 67 commits) into Gurnoor's branch

Written 2026-10-31 in the session that finished Brand Kit v2 slice 7. Read after `AGENTS.md`,
`ARCHITECTURE.md`, `DECISIONS.md` and `handover/next-session.md`. The rules in `AGENTS.md` apply
throughout: the AI tool edits files and prints git commands; **Gurnoor runs every git command**;
plan, wait for OK, then act; stop and ask at every decision point marked **DECISION**.

The plan has four phases. Phase A was done by Gurnoor in the old folder on 2026-10-31 (see the
checklist at the end of section A; tick what is done). Phase B is the merge itself, done in the
`voom-merge` folder in a new session. Phase C makes our screens look like the redesign. Phase D is
the habit that stops this from being painful again.

---

## 0. The situation in numbers (read-only facts gathered 2026-10-31)

- Our branch `gurnoor-dev`: 17 commits since the shared starting point `8067316` (16 October),
  105 files changed. Everything is described in `handover/next-session.md`.
- GitHub `main`: 67 commits since the same point, about 300 files changed, head `9043131`
  (31 October). None of our commits are on it; none of its commits are on ours.
- **33 files changed on both sides** (section B2 lists them with the rule for each).
- `main` has **no** `ARCHITECTURE.md`, `DECISIONS.md` or `handover/` folder, and its `AGENTS.md` is
  only the Next.js notice that ours already contains. Our docs merge in as plain additions.
- **Migration number clash:** `main` has `0059_automation_emergency_pause.sql`; we have
  `0059_brand_kits.sql`. `main`'s migrations run 0059, 0061, 0062, 0063, 0064, 0066, 0067, 0068
  (no 0060 or 0065). Ours becomes **0069** (section B3). Our 0059 was applied to the dev Supabase
  project through the **SQL editor**, not the command-line tool, so the database has no migration
  history table entry to fix: the rename is a file rename only.
- `main` deleted `components/voom/onboarding/AnalyzingScreen.tsx`; our wizard still imports it.
  Git reports this as a "deleted by them, modified by us" conflict: **keep our file**.

What `main` built, by theme (so the new session knows what it is looking at):

| Theme | Commits / PRs | Where |
|---|---|---|
| Redesign from Figma: app shell, Today, Create, Content, Marketing Plan, Approvals, Automations, MARA, Calendar, Contacts, Channels, Performance, Settings, homepage, login, signup, onboarding visuals (3D icons, SetupComplete screen), motion system, haptics, notifications | PRs #84 to #91 | `components/voom/shell/*`, `components/voom/*`, `app/app/(shell)/*`, `public/redesign/*`, `tests/redesign-batch-*.test.mjs`, `tests/onboarding-icons.test.mjs`, `tests/onboarding-completion.test.mjs` |
| LinkedIn personal text publishing and LinkedIn in marketing plans | PRs #92, #93, #94 | `lib/linkedin/*`, migration 0062 |
| Native TikTok and Shorts plan videos with MARA | PR #95 | `lib/mara/*`, `lib/voom/*`, migration 0063 |
| YouTube: OAuth host fix, MP4 upload, resumable uploads, cleanup fairness | PRs #96 to #99 | `lib/youtube/*`, migrations 0064, 0066, 0067 |
| Instagram token renewal (Vercel production only) | PR #100 | `lib/instagram/*`, migration 0068 |
| AI usage and cost tracking; credit reconciliation | PR #82 | `lib/ai/*`, migration 0061, rollback script |
| MARA automation safety: emergency pause/resume, approval integrity | PR #81 | `lib/coordinator/*`, migration 0059 (theirs) |
| Next.js entry-point export rules; test harness leak fix | PR #83 and others | `tests/helpers/*` |

---

## A. Secure the work and make the merge folder (done in the old folder, 2026-10-31)

Why: sixteen of our commits existed only on the laptop. After A3 and A4 nothing done later can lose
them. A6 makes a second folder that shares the same history but sits on its own branch, so the old
folder keeps running the app untouched and is the plan B.

```
git status                                   # A2: must say "working tree clean"
git push -u origin gurnoor-dev               # A3: the real backup, every commit on GitHub
git tag pre-merge-2026-10-31                 # A4: a bookmark that never moves
git push origin pre-merge-2026-10-31         #     and a copy of it on GitHub
git fetch origin                             # A5: learn what is on GitHub; changes no files
git worktree add ../voom-merge -b merge-main-2026-10-31 gurnoor-dev   # A6: the merge folder
cp .env.local ../voom-merge/.env.local       # A7: keys are never in git, so copy them by hand
cd ../voom-merge && npm install              #     packages are per folder
```

Result: `Desktop/voom/voom-real-main` (branch `gurnoor-dev`, untouched) next to
`Desktop/voom/voom-merge` (branch `merge-main-2026-10-31`, same code today). Git refuses to put two
folders on the same branch, which is the protection. Only one dev server at a time (port 3000).

**Undo at any time:** in the merge folder, `git merge --abort` during an unfinished merge, or
`git reset --hard pre-merge-2026-10-31` after a committed one, puts the branch back to today. The
old folder is never touched. Deleting the `voom-merge` folder (`git worktree remove ../voom-merge`)
also undoes everything.

Checklist (Gurnoor ticks): [ ] A2 clean  [ ] A3 pushed  [ ] A4 tagged and pushed  [ ] A5 fetched
[ ] A6 folder exists  [ ] A7 keys copied, npm install clean

---

## B. The merge (new session, opened in `voom-merge`)

Open Claude Code in `Desktop/voom/voom-merge` and say: "Read handover/merge-plan.md and start
Phase B." The session reads the four docs, then this file, then gives a short plan to OK.

### B1. Merge main into our branch

```
git merge origin/main
```

Expect: many files merged silently, then `CONFLICT (content): Merge conflict in …` lines and
"Automatic merge failed; fix conflicts and then commit the result." **This is the expected
outcome, not an error.** The app in this folder will not start until B2 is complete. Do not run
`npm install`, `npm test` or the dev server until B4.

The AI tool first lists the conflicted files (`git status` is read-only and allowed) and compares
the list with B2. Any conflicted file **not** in B2 is new information: read both sides before
deciding, and note it in the merge decision entry (B8).

### B2. The 33 files changed on both sides, and the rule for each

"Ours" = `gurnoor-dev`. "Theirs" = `main`. "Both" = keep every change from both sides; where the
same lines differ, read both and write one version that does both jobs. For every file: open it,
resolve every `<<<<<<<` / `=======` / `>>>>>>>` block, make sure the file still parses, then tell
Gurnoor to run `git add <file>`.

| File | Rule | Why |
|---|---|---|
| `components/voom/onboarding/OnboardingWizard.tsx` | **DECISION, then ours.** Recommended: keep our 11-screen flow entirely; take nothing from theirs now. Their icons and SetupComplete screen come in Phase C. | Both sides rewrote the file. Theirs restyled the old 7-screen wizard; ours is a different flow on a different data model. Blending line by line is not possible. |
| `components/voom/onboarding/AnalyzingScreen.tsx` | **Ours** (restore the file; theirs deleted it). | Our wizard imports it. |
| `app/app/onboarding/page.tsx` | **Both**: our `maxDuration = 60` and any wrapper/metadata they added. | We added the function limit for the website read. |
| `lib/voom/store.tsx`, `lib/voom/types.ts`, `lib/voom/onboardingData.ts` | **Both**, carefully. Our onboarding state (`OnboardingAnswers`, website read, colours, voice samples, `descFromWebsite`, `learnedWith`), theirs for anything else (plan videos, channels). | Both sides changed the onboarding state. Expect the hardest line-level work here. Typecheck will catch what is missed. |
| `components/voom/shell/nav.ts` | **Theirs, plus our Brand entry** (`/app/brand`, label "Brand", in their shape and icon style). **DECISION:** where in the list. | Their redesigned navigation has no Brand page. |
| `app/app/(shell)/settings/page.tsx` | **Theirs, plus our link card to Brand** (slice 3 replaced the old brand form with a link). | Both restyled Settings. |
| `app/app/(shell)/connections/page.tsx` | **Theirs**, then re-check that our slice-3 truthfulness fix (Instagram status) is still true in their version. | Both changed it; theirs is the redesign and added channels. |
| `app/login/page.tsx`, `app/login/LoginForm.tsx`, `app/signup/SignupForm.tsx` | **Theirs, plus our Google button and forgot-password link** (`app/components/GoogleButton.tsx`, `/forgot-password`). | Theirs is the redesign; ours added two features. |
| `components/voom/modals/CreateContentModal.tsx`, `components/voom/operating/PlanWorkspace.tsx` | **Theirs, plus ours**: our "Existing content" source switch (2026-10-23) and the "What is this post for?" purpose line (slice 5b) in the editor. | Theirs is the redesign and native videos. |
| `app/api/posts/[id]/route.ts`, `app/api/posts/[id]/generate/route.ts`, `app/api/posts/[id]/suggest/route.ts` | **Both**: our delete/cancel-approval, brand kit extras, vision "seen" path and purpose; theirs for TikTok/YouTube draft handling and cost tracking. | Both added behaviour; neither replaces the other. |
| `lib/ai/index.ts`, `lib/ai/types.ts` | **Both**: our `createAiVisionProvider` and vision config; their usage/cost tracking. | Two independent additions. |
| `lib/post/server-data.ts`, `lib/voom/workflow/prompt.ts`, `lib/voom/workflow/service.ts` | **Both**: our brand kit block in every prompt; their native video and cost changes. | Independent additions in the same functions. |
| `package.json`, `package-lock.json` | **Both** dependency lists (ours added `puppeteer-core`, `@sparticuz/chromium`), then `npm install` in B4 regenerates the lock file; commit the regenerated one. Never hand-edit the lock file. | |
| `tests/post-studio.test.mjs`, `tests/post-studio-production-0021.test.mjs`, `tests/multi-social-core.test.mjs`, `tests/post-format-persistence.test.mjs`, `tests/tiktok-provider.test.mjs`, `tests/campaigns-v3-pglite.test.mjs`, `tests/campaigns-v3-unified-channels.test.mjs`, `tests/email-automation-flows-pglite.test.mjs`, `tests/mara-media-brief.test.mjs`, `tests/mara-video-publishing.test.mjs` | **Both**, then the migration-list assertions follow B3 (newest = 0069, full list includes both 0059s' names, their 0061 to 0068 and our 0069). | These tests list the migration files; both sides edited the list. |
| `AGENTS.md` | **Ours** (theirs is only the Next.js notice, which ours contains). | Our working rules must survive. |

Files only we changed (72) and files only they changed (about 270) merge by themselves. Two of
theirs will **fail against our wizard** and are handled in B4, not deleted: `tests/onboarding-icons.test.mjs`
and `tests/onboarding-completion.test.mjs`.

### B3. Renumber our migration to 0069

Why: two files numbered 0059 make the order ambiguous for any tool that sorts by number, and both
sides' tests disagree about "the newest migration". Ours moves because theirs is already applied to
production-bound history under that number. The dev database is unaffected: our table exists
already and the file name is not stored anywhere (SQL editor, not CLI).

1. Rename `supabase/migrations/0059_brand_kits.sql` to `supabase/migrations/0069_brand_kits.sql`
   (Gurnoor runs `git mv supabase/migrations/0059_brand_kits.sql supabase/migrations/0069_brand_kits.sql`).
2. Change its header comment to:
   ```
   -- 0069_brand_kits.sql: Brand Kit v2 storage (Gurnoor's branch, slice 1).
   -- Written as 0059 on 2026-10-22; renumbered 0069 at the 2026-10-31 merge with main,
   -- which had its own 0059 (automation emergency pause).
   ```
3. Move every "0059 = brand kits" mention to 0069. Found on 2026-10-31 with
   `grep -rn 0059 lib app components tests docs handover` (re-run it; the merge may add more):
   - Code comments and one user-facing message: `lib/brand/actions.ts` ("Apply the latest Supabase
     migration (0059)"), `lib/brand/context.ts`, `lib/brand/versions.ts`, `lib/brand/assets.ts`,
     `lib/brand/asset-storage.ts`, `lib/voom/mutations.ts`, `lib/post/server-data.ts`,
     `lib/post/prompt.ts`, `lib/voom/workflow/prompt.ts`, `lib/voom/workflow/service.ts`,
     `app/api/posts/[id]/generate/route.ts`.
   - Our test pins (13 files): `tests/brand-hub.test.mjs` (the error message regex),
     `tests/brand-assets.test.mjs`, `tests/brand-kit-context.test.mjs`, and the ten migration-list
     tests named in B2. The pattern is an exact list of file names after 0049 plus "no migration
     beyond 0059": the list gains their 0059, 0061, 0062, 0063, 0064, 0066, 0067, 0068 and our 0069;
     the ceiling becomes 69.
   - Their pins at 0068 (4 files: `tests/instagram-token-renewal.test.mjs`, `tests/post-studio.test.mjs`,
     `tests/multi-social-core.test.mjs`, `tests/post-studio-production-0021.test.mjs`): "newest is
     0068" becomes 0069. Their pins that name their own `0059_automation_emergency_pause.sql` stay.
   - Docs: `docs/brand-kit-v2-design.md`, `handover/changes-log.md`, `handover/next-session.md`,
     `ARCHITECTURE.md` (migration range "0001–0059" becomes "0001–0069, with gaps"), the
     `DECISIONS.md` slice 1 entry gets one added line, not a rewrite.
4. `git add` the renamed file and every touched file.

### B4. Commit the merge, then make it build

```
git commit            # git opens the prepared merge message; save and close it
npm install           # their dependencies
npm run typecheck
npm run lint
npm test
```

Expect typecheck errors first, mostly in `lib/voom/types.ts` / `store.tsx` and the three API routes
where both sides changed a function. Fix them one at a time; every fix is an ordinary edit plus a
follow-up commit by Gurnoor (`git add -A && git commit -m "merge: fix …"`).

Tests: expect red. Three kinds, and the point is telling them apart:

| Kind | How to recognise it | What to do |
|---|---|---|
| Our 9 parked trend failures | `tests/trends-universal`, `trends-demo`, `trends-gp-replenish` | Nothing; still parked (`docs/baseline.md`). |
| Red on `main` too | Run the same test on a plain copy of main: Gurnoor runs `git worktree add ../voom-main-check origin/main --detach`, then the tool runs that one test file there. If it fails there too, it is theirs. | Record it in the baseline row; do not fix in the merge. Remove the check folder afterwards (`git worktree remove ../voom-main-check`). |
| Green on both sides alone, red after the merge | Everything else | The merge broke it. Fix. The usual suspects: a store field one side renamed, a prompt payload key, a migration list. |
| Their two onboarding tests | `tests/onboarding-icons.test.mjs`, `tests/onboarding-completion.test.mjs` expect their wizard's icons and SetupComplete screen | **DECISION with Gurnoor:** re-point them at what our wizard does today (so they stay as tests of something true), and note that Phase C brings the icons and SetupComplete into our flow, when the originals' intent returns. Never delete a test to make a run green. |

Done when: typecheck clean, lint 0 errors, and every remaining failure is in the first two kinds,
listed by name in the new `docs/baseline.md` row.

### B5. Prove nothing of ours vanished

Compiling is not the same as complete. This read-only check takes every line we added between the
shared starting point and the tag, and confirms the line still exists in the merged file. The tool
writes it to its scratchpad and runs it from the merge folder; it changes nothing.

```bash
#!/bin/bash
# Every line gurnoor-dev added (8067316 -> pre-merge tag) must still exist in HEAD's copy of the file.
# Usage: vanish-check.sh [tag-or-commit]   (default: pre-merge-2026-10-31). Takes ~2.5 minutes.
cd "$(git rev-parse --show-toplevel)"
TAG="${1:-pre-merge-2026-10-31}"
git diff --name-only 8067316 "$TAG" | while IFS= read -r f; do
  target="$f"
  [ "$f" = "supabase/migrations/0059_brand_kits.sql" ] && target="supabase/migrations/0069_brand_kits.sql"
  git show "HEAD:$target" >/dev/null 2>&1 || target="$f"
  git diff -U0 8067316 "$TAG" -- "$f" | grep '^+' | grep -v '^+++' | sed 's/^+//' | while IFS= read -r line; do
    [ -z "${line// }" ] && continue
    git show "HEAD:$target" 2>/dev/null | grep -qxF -- "$line" || echo "MISSING in $target: $line"
  done
done
```

Tested 2026-10-31 on the unmerged branch (`vanish-check.sh HEAD`): prints nothing, as it must.
Expected output after the merge: a short list. Every line in it is either (a) a line we deliberately changed during
B2/B3 (the 0059 mentions, a prompt the two sides merged into one sentence, a store type both sides
edited), or (b) a real loss. The tool goes through the list line by line and labels each one (a) or
(b), and fixes every (b). The labelled list goes into the merge decision entry (B8). An empty list
is possible but unlikely; a list of hundreds means a B2 rule was applied wrongly.

### B6. Bring the dev database up to date

Run their eight migrations on the **dev** Supabase project in the SQL editor, in this order, each
pasted whole and run once: `0059_automation_emergency_pause.sql`, `0061_ai_usage_cost_tracking.sql`,
`0062_linkedin_personal.sql`, `0063_native_plan_video_generation.sql`, `0064_youtube_uploaded_video.sql`,
`0066_youtube_resumable_uploads.sql`, `0067_youtube_upload_cleanup_fairness.sql`,
`0068_instagram_token_renewal.sql`. Our 0069 is already applied (it was 0059). Add a row to
`handover/changes-log.md` for the eight, Dev done, Prod pending, and copy any new env var names
their code reads (`grep -rhoE "process\.env\.[A-Z_]+" lib app | sort -u` compared with `.env.example`)
into `.env.example` with a comment, values never.

### B7. Browser check

Stop the dev server in the old folder first. In the merge folder: `npm run dev`. Gurnoor checks,
Claude watches the terminal and the browser where it can:

- Theirs: login, Today, Create flow, Content, one Channels page, Settings. Does the redesign render?
- Ours, on the spare onboarding profile: the 11 screens, "Read my website" on
  `https://blabliblulife.com/`, Finish, the Brand page at `/app/brand`, the Brand entry in their
  navigation, "Continue with Google" and "Forgot password" on login.

Expected: ours works but looks like the old design inside their new shell. That is Phase C, not a
defect. Anything that does not work is a defect to fix before B8.

### B8. Record and push

- `DECISIONS.md`: one entry "2026-11-xx: Merged main (67 commits) into Gurnoor's branch" with the
  B2 decisions as taken (wizard, nav position, their two tests), the B4 red list by kind, the B5
  labelled list, and the 0069 renumbering.
- `docs/baseline.md`: a new row with the merged counts and the named parked failures from both sides.
- `handover/next-session.md`: section 1 (new head, counts, "merged main at 9043131"), section 2
  (Phase C first), section 4 (new open items), section 6 replaced by "merge main every 2 or 3 days".
- `ARCHITECTURE.md`: at least the folder table and the "Not built yet" list must be true again
  (LinkedIn and TikTok are now built; Brand page exists in the new shell). A fuller pass is Phase C.
- Gurnoor:
  ```
  git add -A
  git commit -m "docs: record the merge of main into gurnoor-dev

  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
  git push -u origin merge-main-2026-10-31
  ```

From here on, work happens in `voom-merge` on `merge-main-2026-10-31` (rename it later if wanted:
Gurnoor's call). The old folder is retired but kept until Phase C is done.

---

## C. Make our screens belong to the redesign (its own plan, after B)

Not merge work; product work. The new session writes a plan and waits for OK, as for any slice.

- Brand page (`/app/brand`) in their shell, components and spacing; the Brand entry in their
  navigation (position decided in B2).
- Our 11 onboarding screens restyled with their components, their 3D icons for our chips where an
  icon exists (`public/redesign/onboarding-icons/`, `components/voom/onboarding/onboardingIcons.tsx`),
  their SetupComplete screen at the end of our flow; their two onboarding tests return to their
  original intent.
- The Post Studio bits we added (purpose line, "MARA saw", Existing content switch) checked in
  their restyled editor.
- `ARCHITECTURE.md` full pass describing what `main` built (section 0 table is the starting list).
- Then back to `handover/next-session.md` section 2: slice 8, Instagram import.

## D. The habit

- Merge `origin/main` into the working branch every two or three days
  (`git fetch origin && git merge origin/main`, resolve the usually zero or one conflict, run the
  tests, commit). Twenty-day gaps produce this document; two-day gaps produce five-minute merges.
- When a slice is done, open a pull request from the branch to `main` so the other developer sees
  our work and it stops being "Gurnoor's copy".
- Delete merged branches; they cost nothing but confusion.
