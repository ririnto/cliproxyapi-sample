---
name: verify-usage-cache
description: Verify credential isolation when changing the statusline usage cache or its identity handling.
---

# Verify usage cache isolation

The cache must never return a snapshot belonging to a different credential identity.
Otherwise, a user switching accounts can see another account's quota and make
decisions from the wrong usage data.

Run from the repository root with Node.js 26.13.0:

```sh
node verification/usage-cache.mjs
```

The script exhaustively runs all sequences of up to three sequential requests
over two identities, successful or failed fetches, and intervals of one or six
seconds.
It calls the real `withUsageCache` function and checks every returned
snapshot's owner.
This is bounded exhaustive execution, not an unbounded proof or a model checker.
It excludes concurrent requests, other providers, cache tampering, hash
collisions, other time intervals, and collector-specific identity selection.
It assumes snapshots identify their originating account and the filesystem
behaves normally.

Coverage is `.claude/statusline/usage-cache.mjs`, especially `withUsageCache`,
`readCache`, and `validRecord`.
The verification was synchronized with source commit `3b591aed6b93113d53b31f6468b695f3a6651013`.
When covered code changes after that commit, compare its behavior and assumptions
with the script before trusting the result.
Move the sync commit forward only after confirming that the verification still
describes the code at the new commit.

On failure, read the reported action sequence in order and reproduce it against
the real cache.
Distinguish an actual foreign snapshot from an invalid assumption or a script
error before changing either the property or the implementation.
Use `/maintain-formal-verification-skill` to reconcile the check after covered changes.
