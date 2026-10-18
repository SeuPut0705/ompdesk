---
name: principle-laziness-protocol
description: "Apply when refactoring, evaluating diff size, or tempted to add abstractions, layers, or signal threading. Bias toward deletion and the smallest change that solves the problem."
disable-model-invocation: true
---

# Laziness Protocol

> OMPdesk built-in pack. Tool, agent and model names here are the omp and OMPdesk ones; the adapter is in the `<pstack>` section of your prompt, or `skill://pstack-adapter`.

- **Consolidate decisions.** Do not repeat the same choice in several places. Put it behind one source of truth and pass the result as a simple flag.
- **Minimize the diff.** Make the smallest change that solves the problem. Fewer lines beat "elegant" boilerplate.
