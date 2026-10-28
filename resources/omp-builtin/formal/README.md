# OMPdesk built-in formal verification

One extension root (`-e resources/omp-builtin/formal`, mounted on every spawn) holding one skill, `skills/ompdesk-formal-verify/`: model checking with TLA+/TLC and proofs in Lean 4, the Bun TypeScript scripts that run them on macOS and Windows, a mutation runner, a report renderer, the project-local verify-skill and drift loop, and the statechart for non-technical readers. Adapted from opum-ai/proof-skills and pstack (both MIT); see `LICENSES/` and `THIRD_PARTY_NOTICES.txt`.

- No `plugin.json` here: omp would class the folder an Agent Plugins root and drop the skill.
- The one version pin is `skills/ompdesk-formal-verify/assets/toolchain.json` (SHA-256 for every download).
- Rules and tests: `.omp/rules/builtin-packs.md`, "Built-in formal verification skill".
