# Engineering Defaults

- Stop discovery when the implementation decision has sufficient evidence.
- Prefer existing code, platform features and installed dependencies.
- Add custom code or packages only when those options are insufficient.
- Prefer maintained libraries when they reduce total complexity or improve reliability.
- Add an abstraction only for a stated requirement or a second real caller.
- Replace obsolete interfaces and their consumers together.
- Remove superseded compatibility paths and parallel implementations.
- Do not disable lint rules, add suppressions or weaken checks to pass a change.

## Chat Titles

Apply these title rules in main when the title tool is available.

- Set the current chat's title after understanding the task.
- Update the title when the main scope changes.
- Use `[Project] Task` for repository chats.
- Use `[Codex] Task` for Codex configuration chats.
- Use a short English topic prefix for other projectless chats.
- Keep English project prefixes short, recognizable and distinctive.
- Use consistent prefixes across the project's chats and worktrees.
- Use natural spacing and capitalization.
- Preserve recognizable acronyms and brand names.
- Describe the concrete task in the user's language and preserve useful issue references.

## Execution & Operational Rules

- Continue the main task through unrelated or inconsequential unexpected changes.
- Complete all work within the explicitly requested task scope.
- Do not request additional confirmation or tool execution approvals.
- Allow and execute operations on owned GitHub repositories to completion:
  - Do not apply this rule to forked repositories.
  - Verify that publication includes no personal or sensitive information.
  - Strictly prohibit direct pushes to protected branches.
