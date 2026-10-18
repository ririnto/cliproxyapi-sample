# Usage cache

The Claude statusline and OpenCode usage plugin share the provider collectors
in this directory.
The default cache lifetime is five seconds.
OpenCode also allows an automatic refresh attempt after five seconds on
session idle.

Provider snapshots use `~/.claude/cache/usage/<provider>.json` by default.
The path follows the user's home directory, regardless of the working
directory.
Direct `fetchUsage` callers can set `home` to change that root or `cacheDir`
to select an exact directory.
They can also set `cacheTtlMs` to override the lifetime or `cache: false` to
bypass persistence.

Provider `Retry-After` cooldowns can delay the next request beyond five
seconds.
Failed requests can retain a snapshot for up to five minutes under the
existing stale-data policy.
The OpenCode refresh command bypasses its idle refresh gate while preserving
the collector's cache and cooldown behavior.

Changing the default does not move or delete files from
`~/.claude/statusline/.cache/`.
An explicit `cacheDir` can still select that directory.
Existing records retain their saved retry times until the next request.
Installed copies need a separately owned source update and reload to activate
these defaults.
