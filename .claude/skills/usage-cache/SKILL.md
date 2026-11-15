---
name: usage-cache
description: Check credential isolation when changing the statusline usage cache or its identity handling.
---

# Check usage cache isolation

The cache must never return a snapshot belonging to a different credential identity.
Otherwise, an account switch can display another account's quota.
Review `.claude/statusline/usage-cache.mjs` before trusting the result.

## Run the bounded check

Install repository dependencies with `pnpm install --frozen-lockfile`.
Use the Node.js version declared in `package.json`.
Run from the repository root:

```sh
pnpm run check:usage-cache
```

The [enumeration](../../../verification/usage-cache.mjs) tests the real cache.
It checks every returned snapshot's owner across 585 sequences.
It explores up to three sequential requests over two identities.
Fetches can succeed or fail.
Requests advance time by one or six seconds.
This is bounded exhaustive execution, not an unbounded proof or a model checker.

## Bounds and maintenance

The check covers `withUsageCache`, `readCache`, and `validRecord`.
Snapshots must identify their originating account.
The filesystem must behave normally.
It excludes concurrency, other providers, tampering, and hash collisions.
Other intervals and collector-specific identity selection are not checked.

The source correspondence was reviewed on `main` on 2026-11-15.
Compare covered changes with the enumeration before trusting a later result.
After a covered change, rerun the check.
Confirm an isolated broken credential comparison still fails.
Never weaken the owner assertion to make verification pass.
Do not mutate production code during verification.
Update the branch and review date only after completing those checks.

On failure, reproduce the reported action sequence against the real cache.
Distinguish an actual foreign snapshot from an invalid assumption or a script error.
Report the failing sequence, the affected account boundary, and any untested behavior.
