# Repository Conventions

## Agent Guidance

Read [shared guidance](.agents/engineering.md) for common rules.
Repository conventions below apply in addition to that shared guidance.
Preserve the Sample's product selectors.

## Dependencies And Checks

Reference direct dependencies with `catalog:`.
Declare their `^x.y.z` ranges in the default pnpm catalog.
Use overrides only for security fixes and record their reasons.
Keep lockfile integrity checks without adding version-plus-hash pins.
Prefer compatible, supported LTS releases.
Use stable releases when no LTS line exists.

Keep Husky's `prepare` script and working commit and push hooks.
Invoke Oxlint and Oxfmt only through Ultracite.
Preserve the existing Markdownlint baseline.
Keep compact tables and Git ignore handling.
Use the commands and lifecycle documented in README's Development checks section.

## Source And Documentation

Write one sentence per source line in Markdown prose.
Test documentation contracts without hard-pinning prose wording.
Use named regex captures and access full matches and subgroups by name.
Prefer literal operations or parsers when they express matching more clearly.
Inline genuine single-use logic when lint and behavior allow it.
Test production interfaces without adding test-only seams.
Do not retain production helpers solely for tests or hypothetical reuse.
Use documentation comments only.
Preserve required semantic directives and license notices.
Prefer `await` and error handling over `void` used to discard return values.
Preserve async contracts and intentional background work.
Prefer condition inversion over mid-function exits when behavior stays equivalent.
Avoid deeper nesting, and let lint requirements take precedence over this guidance.

## Security Overrides

`markdownlint-cli2>smol-toml` selects 1.9.1 for GHSA-r4xh-jqrq-34v2.
It fixes a TOML parsing denial of service.
`micromark-extension-math>katex` selects 0.19.0 for GHSA-238p-pmpm-9mq7.
It fixes a trust restriction bypass.
Remove each override when its parent supports the patched release without it.
