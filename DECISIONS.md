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
