<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Working with Gurnoor on Voom

These rules bind every AI coding tool used on this repo — Claude Code, Codex, Cursor or anything
else — and every new session, with no other setup. (`CLAUDE.md` is only a pointer to this file.)
Start every task by reading `ARCHITECTURE.md` and `DECISIONS.md`.

I'm Gurnoor. I own this product and I'm not a developer. I need to understand everything that
changes so I can change it myself later.

## How to talk to me
- Plain, everyday language. Explain any technical term the first time, in one short phrase.
- Concise but complete: never leave out a fact, risk, failure or trade-off to keep it short.
  Cut words, not information.
- Lead with the answer or result. Then what changed, why, and what I need to do (if anything).
- If something failed, a test is red, or you're unsure, say so plainly. Never present a guess as fact.
- Disagree with me when I'm wrong. Don't just agree.

## How we work: plan first, then build
1. For every task, first write a short plan: what you'll change (files), why, how we'll test it,
   and what could go wrong. **Stop and wait for my OK.** Don't edit any file before I approve.
2. Do only what the plan says. If you find you need to change the plan, stop and tell me why.
3. After building, check the work against the plan and report: done / not done / changed, with
   test results.
4. Keep changes lean: the smallest change that fully solves the problem. Don't refactor, rename or
   "tidy" code that the task doesn't need. Don't touch working features (publishing, billing,
   database security) unless the task is about them.

## Git: you never run it, I do
- Never run any command that changes git: no `git add`, `commit`, `push`, `pull`, `merge`,
  `rebase`, `reset`, `checkout`, `stash`, `branch -d`, tags, or `gh pr`. Read-only commands
  (`git status`, `git diff`, `git log`) are fine.
- When a git step is needed, print the exact commands in a code block with one line saying what
  they do. I'll run them myself.

## Safety
- Never put real keys or passwords in code or files. They go in `.env.local`, which is never committed.
- Never run anything against the production database or production services. Local or a test
  Supabase project only.
- Ask before deleting files or data.

## Project files to keep up to date
- `ARCHITECTURE.md`: how the app is built. Update it in the same change when structure changes.
- `DECISIONS.md`: log every important decision (template inside). Add an entry when we decide
  something about architecture, scope, a library/provider, or a trade-off.

## Commands
- `npm run dev`: run locally at http://localhost:3000
- `npm test`: all tests (run before saying a task is done; report the pass/fail counts)
- `npm run typecheck`, `npm run lint`: must stay clean
- New database change = new numbered file in `supabase/migrations/`. Some tests check the newest
  migration number; update them in the same change.

## Testing rule
Every feature is tested before we move on: code tests (`npm test`) plus checking it in the browser,
step by step. Tell me exactly what you tested and what you couldn't.
