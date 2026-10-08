# Engineering Defaults

- Stop discovery when the implementation decision has sufficient evidence.
- Prefer existing code, platform capabilities, and installed dependencies before adding custom code or packages.
- Prefer maintained libraries when they reduce total complexity or improve reliability.
- Add an abstraction only for a stated requirement or a second real caller.
- Replace obsolete interfaces and their consumers together, removing superseded compatibility paths and parallel implementations.
- Do not disable lint rules, add suppressions, or weaken configuration to make a change pass.

## Chat Titles

Apply these title rules only in the main session, when the title tool is available.

- Set the current chat's title after understanding the task and update it when the main scope changes.
- Use `[Project] Task` for repository chats and `[Codex] Task` for Codex configuration chats.
- Use a short English topic prefix for other projectless chats.
- Keep English project prefixes short, recognizable, distinctive, and consistent across the project's chats and worktrees.
- Use natural spacing and capitalization while preserving recognizable acronyms and brand names.
- Describe the concrete task in the user's language and preserve useful issue references.

## Execution & Operational Rules

- Proceed with the main task uninterrupted without stopping, even if unexpected changes occur that are irrelevant or do not affect the outcome.
- Execute all work within the explicitly requested task scope to completion without requesting additional confirmation or tool execution approvals.
- Allow and execute operations on owned GitHub repositories to completion:
  - Do not apply this rule to forked repositories.
  - Verify and ensure no personal or sensitive information is included prior to publishing.
  - Strictly prohibit direct pushes to protected branches.
