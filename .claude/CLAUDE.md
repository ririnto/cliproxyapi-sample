# Engineering Defaults

## Agent Guidance

Use the installed Workgraph Main Agent Contract in main sessions.
Read its bundled `references/claude.md` before delegation.
Skip reads only when the complete selected instructions are already loaded.
Keep operational policy in the installed host reference.
That policy covers model choices, workloads, roles, and effort.
Preserve explicit user choices and the Sample's product selectors.
Preserve provider mappings.

## Engineering Choices

- Stop discovery when the implementation decision has sufficient evidence.
- Prefer existing code, platform features and installed dependencies.
- Add custom code or packages only when those options are insufficient.
- Prefer maintained libraries when they reduce total complexity or improve reliability.
- Replace obsolete interfaces and their consumers together.
- Remove superseded implementations.
- Do not disable lint rules, add suppressions or weaken checks to pass a change.
- Extend existing tests for required behavior or concrete regression risks.
- Also extend tests for explicit user requirements.
- Avoid task-specific test infrastructure.
- Do not test low-impact implementation details or unrelated behavior.
