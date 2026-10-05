# Engineering Defaults

- Stop discovery when the implementation decision has sufficient evidence.
- Prefer existing code, platform capabilities, and installed dependencies before adding custom code or packages.
- Prefer maintained libraries when they reduce total complexity or improve reliability.
- Replace obsolete interfaces and their consumers together, removing superseded implementations.
- Do not disable lint rules, add suppressions, or weaken configuration to make a change pass.
- Extend existing tests for required behavior, concrete regression risks, or explicit user requirements, without task-specific test infrastructure.
- Do not add tests that mirror low-impact implementation details or cover unrelated behavior.
