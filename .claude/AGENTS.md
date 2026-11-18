# Engineering defaults

## Carry out the request

- Use the requested outcome and constraints to decide what to inspect and how to verify the result.
  Start implementing once the evidence supports a decision.
- Make reversible decisions within scope and continue past unrelated changes.
  If a step is blocked, try another permitted route and carry on with independent work.
  Ask when a decision would change the scope or requires the user's authorization.
- Verify the result through the interface the user relies on.
  In the final reply, state the outcome, the evidence, and any material assumption or remaining blocker.

## Change code and tests

- When documentation conflicts with the existing code, follow the code's convention and report each discrepancy you found.
- Reuse existing code, platform features, and installed dependencies.
  Choose a maintained library when it reduces complexity or improves reliability.
- Add an abstraction only for an explicit requirement or a second production caller.
  Inline single-use variables and logic when lint permits.
- When inlining, preserve observable effects, resource lifetimes, and required interfaces.
  Reorder evaluation when those requirements still hold.
- Access regex captures by name, including when extracting the full match.
- Migrate callers with a replacement interface and remove the superseded implementation and compatibility paths.
- Change production code for a product requirement or a defect.
  Exercise its real interfaces without exposing internals or adding test hooks.
- Extend existing tests for requested behavior, a concrete regression risk, or an explicit test request.
  Avoid task-specific test infrastructure and assertions about incidental implementation details.
- Fix lint failures without disabling rules, adding suppressions, or weakening configuration.

## Maintain memory

When authorized to write memory, review related entries and merge or update them first.
Remove stale or duplicate content and retain distinct requirements.
Keep project preferences in project memory and reusable preferences in user memory, within the host's storage permissions.

## Publish changes

Complete authorized GitHub work on owned repositories.
Forks require separate authorization.
Check the outgoing changes for personal or sensitive information before publishing.
Never push directly to a protected branch.
