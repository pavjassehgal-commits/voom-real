# Handover: moving Voom from development to production

This folder is written for whoever sets up or takes over the **production** copy of Voom,
including a future Gurnoor who no longer has this chat history. Read it in this order:

1. `production-setup.md`: everything that has to be configured outside the code (Vercel,
   Supabase, email sending, provider consoles), with *why* each step exists and *how* to do it.
   Follow it top to bottom on a brand-new production project.
2. `changes-log.md`: the running list of code changes that need a matching step outside the
   code. **Every time we change the app in a way that needs a Supabase, Vercel or provider
   setting, a row is added here.** Before each production deploy, work through every row that is
   not yet marked done for production.

## The one rule that makes this plug-and-play

The code never knows which Supabase project it is talking to. It reads four values from the
environment (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`,
`SUPABASE_SECRET_KEY`, `NEXT_PUBLIC_SITE_URL`) and nothing else. Switching from the development
project to production means: set those values in Vercel, apply the migrations, do the dashboard
settings in `production-setup.md` once, and deploy. No code change.

If you ever find yourself editing code to make production work, stop: that is a bug in the
"account-agnostic" rule and should be logged in `DECISIONS.md`.

## Where the other documents live

- `next-session.md` (this folder): the status board for the next working session: where the
  branch is, what is next in agreed order, open items with their triggers, environment facts,
  and the checklist for pulling `main`. Updated at the end of every task.
- `merge-plan.md` (this folder): the step-by-step for merging GitHub `main` (the other developer's
  67 commits of 2026-10-16 to 10-31) into Gurnoor's branch: backups, the second worktree folder,
  the 33 overlapping files with a rule each, migration 0059 → 0069, the "nothing vanished" check.
- `ARCHITECTURE.md` (repo root): how the app is built.
- `DECISIONS.md` (repo root): why things are the way they are.
- `docs/deploy-voom-today.md`: the original deploy runbook; `production-setup.md` here is the
  fuller, kept-current version and wins if they disagree.
- `docs/baseline.md`: the test, type and lint counts every change must match or beat.
