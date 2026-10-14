# Engineering Defaults

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
