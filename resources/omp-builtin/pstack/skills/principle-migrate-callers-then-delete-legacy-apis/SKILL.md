---
name: principle-migrate-callers-then-delete-legacy-apis
description: "Apply when introducing a new internal API while old callers still exist. Migrate callers and delete the old API in the same wave instead of preserving compatibility layers."
disable-model-invocation: true
---

# Migrate Callers Then Delete Legacy APIs

> OMPdesk built-in pack. Tool, agent and model names here are the omp and OMPdesk ones; the adapter is in the `<pstack>` section of your prompt, or `skill://pstack-adapter`.

- Update tests to assert the new contract, and delete tests that only protect pre-refactor implementation details

**When this applies:**
- No external users depend on backward compatibility
- The project can absorb coordinated breaking changes
- The new API is part of a simplification or refactor initiative
