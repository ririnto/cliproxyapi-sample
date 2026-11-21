# pstack model configuration for Claude Code
# defaults: 3
# budget: large (xhigh)

Use this table for pstack Agent calls.
Each entry is a Claude family alias followed by its effort.
For example, `haiku xhigh` means `model: "haiku"` and `effort: "xhigh"`.

Choose one column before dispatch.
Use normal for a scoped change with a reproducible check.
Choose harder for changes spanning interacting components, unclear behavioral contracts, or an expensive verification cycle.
For perf-issue, keep Sonnet on application-level CPU work and choose harder for specialized kernel optimization.
A blank harder cell uses normal.
Comma-separated panel entries each get one seat.
The cross-judge pool supplies one judge only when the parent is from another vendor.

| role | normal | harder |
| --- | --- | --- |
| feature, refactoring | haiku xhigh | sonnet high |
| bug-fix | haiku high | sonnet high |
| perf-issue | sonnet high | opus high |
| hillclimb | haiku high | opus high |
| judgment and prose | haiku medium | sonnet high |
| arena runners | haiku xhigh, sonnet medium | haiku xhigh, opus high |
| arena cross-judge pool | opus medium | |
| swarm workers | haiku medium | |
| interrogate reviewers | haiku medium, sonnet low | sonnet low, opus high |
