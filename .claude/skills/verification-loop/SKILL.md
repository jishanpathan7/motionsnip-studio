---
name: verification-loop
description: The required verification loop for every code change — Implement → Test → Analyze → Fix → Retest → Verify → PR, with no shortcuts. Use whenever you modify code in any project (frontend, backend, database, API, messaging/WhatsApp integrations, build or config), before you call the work done, and always before proposing a commit, push or pull request. Also use when asked to "verify", "test this change", "make sure it works", or "get this ready for a PR".
---

# Verification Loop

Every change is tested, verified and production-ready before anyone is asked to open a pull request. Passing
verification is **not** permission to push, open a PR or merge: those still need the user's explicit go-ahead,
per action.

The loop: **Understand → Test → Run → Analyze → Fix → Retest → Final validation → Report.** Repeat the middle
steps until everything required passes, or escalate.

## The gates (never broken)

- No PR (and no "ready for PR") unless every required check passed on the final code.
- Never skip, delete, weaken, `.only`/`.skip`, `xfail`, loosen an assertion, raise a timeout, mock away the thing
  under test, or catch-and-ignore an error to turn a run green.
- Skipped, flaky, unexecuted, or "couldn't run" tests are **not** passing. Say which and why.
- Verify what the user experiences, not only that functions return values: drive the real flow (browser, HTTP
  call, CLI, webhook) at least once for every user-visible change.
- If the environment stops a check from running (no DB, no network, missing secret, CI down), report the
  blocker. Never claim success for something that didn't run.
- Evidence goes in the PR description: commands run, their results, and what was checked by hand.
- Do not push, open a PR, or merge without explicit authorization, even after everything passes.

## 1. Understand the change

Before writing tests, write down (in your own notes or the task list):

- **What changed:** files, functions, endpoints, tables, screens, messages.
- **Who feels it:** the user flows and features that pass through that code. Grep for callers, imports, routes,
  event names, and table and column names.
- **Dependencies:** what this code calls (services, DB, queues, third-party APIs) and what calls it.
- **Regression risks:** what used to work that could break. Old data shapes, existing saved files, older clients,
  feature flags, both themes, mobile widths, time zones, retries.
- **Change type(s):** frontend, backend, database, API, integration (for example WhatsApp), build or config. Read
  the matching sections of `references/change-types.md`.

Then find how this project verifies itself. Look, in this order, at: `CLAUDE.md` or `AGENTS.md`, the CI config
(`.github/workflows/*`, `.gitlab-ci.yml`, and so on), `package.json` scripts, `Makefile`, `pyproject.toml` or `tox.ini`,
`Cargo.toml`, and the README. **What CI runs is the minimum you run locally.** Note the exact commands.

## 2. Create or update tests

For every change, add or update tests at the level that would have caught a bug in it:

- **Unit:** the new logic, each branch, boundaries (empty, one, many, max, zero, negative, unicode, very long),
  and invalid input.
- **Integration:** the change working with its real neighbours (DB, HTTP layer, queue, file system), using test
  doubles only at the true outer edge (third-party APIs).
- **End to end:** the user flow through the real interface, for anything a user can see or trigger.
- **Failure scenarios:** dependency down or slow, timeouts, bad responses, permission denied, duplicates and
  retries, partial failure, concurrent edits.
- **Regression:** a test that fails on the old code for every bug you fix. Write it first and watch it fail.

Match the project's existing test style and tools. Don't add a framework when one exists. If the project has no
tests at all, add the smallest runnable check that proves the change (a script with asserts is fine) and say
so in the report.

A test that can't fail proves nothing: for each new test, make sure it fails when the behaviour is broken (break
it on purpose or run it against the old code).

## 3. Run verification

Run everything relevant, not just the new tests:

1. The new and changed tests.
2. The full existing suite for each affected package, or the whole suite when it's reasonably fast.
3. Lint, format check, and type check, exactly as CI runs them.
4. The build (production build, compile, bundle, Docker image, migrations dry run), as CI runs it.
5. A real run of the user flow (`references/change-types.md` says how for each kind of change).

Record each command and its result (pass and fail counts, or the exit code). Run long commands in the background and
wait for them. Don't guess at their outcome.

## 4. Analyze failures

For each failure, find the **root cause** before touching anything:

- Read the whole error and stack trace. Reproduce the single failing test on its own.
- Decide which it is: a bug in the change, a test that encoded old behaviour which the change is meant to alter,
  an environment problem, or a pre-existing failure.
- **Pre-existing?** Prove it: run the same test on the base branch (`git stash` or a clean worktree). If it
  also fails there, it is not caused by you, but it is still not a pass. Report it as a blocker or known issue,
  with that proof.
- **Flaky?** Run it several times to characterise it, not to get one green run. A test that passes one time in
  three has failed. Find the race or the dependency on order or time.
- Change a test's expectation only when the requirement itself changed, and say so explicitly in the report.

## 5. Fix and retry

Fix the cause in the code (or in the test, only when the test was wrong). Rerun the failing test first, then
the wider set from step 3, because a fix can break something else. Repeat steps 3 to 5.

Stop and escalate (step 6) when any of these is true:

- The same failure survives about three genuine attempts without new understanding.
- The fix needs a decision only the user can make: a product behaviour, a data migration risk, or a security trade-off.
- The fix would need something forbidden by the gates.

## 6. Escalate blockers

When a failure can't be resolved safely, stop. Don't open a PR, and don't describe the work as ready. Report
it with the template in `references/evidence.md` (Blocker report): what fails, the exact command and output,
the root cause (or best current understanding and how sure you are), what you tried and what happened, and
recommended next steps, plus what you need from the user.

## 7. Final validation

After the **last** code change, even a one-line fix or a rename, run the complete required set from step 3
again, from a clean state where that matters (fresh install, rebuilt artifacts, a migrated empty database). Only
this run counts as the evidence. Then check:

- `git status` and `git diff` show only the intended changes: no debug output, commented-out code, stray files,
  secrets or keys.
- New tests are committed alongside the code, not left untracked.
- Nothing was skipped or disabled to get here (`git diff` shows no new `skip`, `only`, `xfail`, `eslint-disable`, `@ts-ignore`,
  `# noqa` or loosened assertions, or you can justify each one in the report).

## 8. Report, then ask

Write the verification summary (template: `references/evidence.md`, Verification section) into your reply. If
the user has authorized a PR, put the same section into the PR description. Then **ask** before any push, PR or
merge, unless the user has already explicitly authorized that specific action. Approval for one action is not
approval for the next.

## Doing this alongside other skills and agents

- This loop wraps whatever skill or workflow produced the change. Run it before that workflow's "done" or "ship"
  step.
- When work is split across subagents or sessions, each one runs the loop for its own change, and whoever combines
  them runs step 7 on the combined result before reporting.
- A reviewer's or another agent's "looks good" is not verification. Evidence is commands that ran and what they
  printed.
