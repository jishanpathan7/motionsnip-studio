# Evidence templates

## Verification section (reply and PR description)

Paste results from the **final** run (step 7), not from earlier attempts. Use real numbers. If something
didn't run, say so in **Not verified**. Never leave that section out.

```markdown
## Verification

**Change type:** frontend / backend / database / API / integration / build (pick the ones that apply)
**Affected flows:** <user flows and features this touches>
**Regression risks checked:** <what could have broken, and how you checked it>

### Tests added or changed
- `<path>`: <what it covers, including edge and failure cases>
- Regression test for <bug>: fails on the old code, passes now.

### Commands run (final run, after the last change)
| Check | Command | Result |
|---|---|---|
| Unit | `<cmd>` | 142 passed, 0 failed, 0 skipped |
| Integration | `<cmd>` | 37 passed |
| E2E | `<cmd>` | 9 passed |
| Lint | `<cmd>` | clean |
| Types | `<cmd>` | clean |
| Build | `<cmd>` | ok |

### Verified by hand (real user behaviour)
- <flow>: <what you did>, <what you saw> (screenshot or log line if useful)

### Not verified
- <check>: <why it couldn't run: environment, secret, service>; <the risk>; <how to verify it>
  (or "Nothing: every required check ran and passed.")

### Known issues
- <a pre-existing failure, with proof it also fails on the base branch> (or "None.")
```

## Blocker report (step 6: don't open a PR)

```markdown
## Blocked: <one-line summary>

**What fails:** <test, check or flow>
**Command:** `<exact command>`
**Output:**
<the relevant lines of the error or stack trace>

**Root cause:** <what's wrong and where, or the best current understanding and how sure you are>
**Pre-existing?** <yes or no, and the proof: the result of the same command on the base branch>

**Tried:**
1. <attempt>: <result>
2. <attempt>: <result>

**Recommended next steps:** <options, with trade-offs>
**Needed from you:** <a decision, access, a secret, an environment, or a product answer>

The change is not ready for a PR until this is resolved.
```
