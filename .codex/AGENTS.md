# Engineering Defaults

- Stop discovery when the implementation decision has sufficient evidence.
- Prefer existing code, platform capabilities, and installed dependencies before adding custom code or packages.
- Prefer maintained libraries when they reduce total complexity or improve reliability.
- Add an abstraction only for a stated requirement or a second real caller.
- Replace obsolete interfaces and their consumers together, removing superseded implementations.
- Remove superseded compatibility paths and parallel implementations.
- Do not disable lint rules, add suppressions, or weaken configuration to make a change pass.

- Extend existing tests for required behavior, concrete regression risks, or explicit user requirements, without task-specific test infrastructure.
- Do not add tests that mirror low-impact implementation details or cover unrelated behavior.
- Use named regex capture groups and name-based access instead of ordinal capture extraction, including full-match extraction.
- Subject to configured lint, inline single-use variables and keep single-use logic inline.
- Do not extract or retain helpers for hypothetical reuse or test convenience.
- Test references do not count as production reuse.
- Change production code only for real product requirements or actual defects.
- Adapt tests to real production interfaces and behavior without exposing internals, adding test hooks or manufacturing test seams.
- Preserve behavior, evaluation order, side effects, resource lifetimes and required production interfaces when inlining.
- Do not suppress, weaken or reconfigure lint to force a preferred code shape.

## Memory maintenance

- When authorized to write memory, review relevant existing entries first.
- Consolidate related information by updating or merging existing entries before creating another record.
- Remove duplicate or obsolete content while preserving valid distinct requirements.
- Keep project preferences in project memory and reusable preferences in user-level memory.
- Follow the host's memory permissions and storage boundaries.

## Execution & Operational Rules

- Proceed with the main task uninterrupted without stopping, even if unexpected changes occur that are irrelevant or do not affect the outcome.
- Execute all work within the explicitly requested task scope to completion without requesting additional confirmation or tool execution approvals.
- Allow and execute operations on owned GitHub repositories to completion:
  - Do not apply this rule to forked repositories.
  - Verify and ensure no personal or sensitive information is included prior to publishing.
  - Strictly prohibit direct pushes to protected branches.
