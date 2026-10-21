# Contributing to OMPdesk

Thanks for helping. OMPdesk is an unofficial desktop app for the [omp](https://github.com/can1357/oh-my-pi) agent.

## Issues

Issues are welcome.

- **Bug:** include the OMPdesk version, your OS, `omp --version`, and the steps to reproduce. [Logs](docs/troubleshooting.md#logs) help.
- **Feature idea:** describe the problem you want solved, not only the solution.
- **Vulnerability:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

- Open an issue first for anything non-trivial.
- Keep PRs small and focused on one change.
- Before you push, run the checks CI runs on every pull request:

  ```bash
  bun run check:types
  bunx biome check src e2e resources scripts
  node scripts/lint-surfaces.mjs
  bunx vitest run
  ```

  While you work, `bun run check:changed` runs the same checks on just what you changed (plus the end-to-end specs that touch it).

- Every user-visible string needs the same key in both `src/renderer/locales/en.ts` and `ko.ts`.
- Do not add AI-attribution trailers to commit messages.
- The maintainer commits locally and batches releases, so a PR may be merged by rebase or squash rather than as-is.

Contributions are submitted under the [Apache License 2.0](LICENSE) (inbound = outbound, as its section 5 says), the same license as the project. There is no CLA.

New source files may start with `// SPDX-License-Identifier: Apache-2.0`. It is optional, and please do not mass-edit existing headers.

## Development rules

Architecture, conventions and the full list of checks are in [AGENTS.md](AGENTS.md). To run from source:

```bash
bun install
bun run dev
```
