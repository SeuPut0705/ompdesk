# Contributing to OMPdesk

Thanks for helping. OMPdesk is an unofficial desktop app for the [omp](https://github.com/can1357/oh-my-pi) agent.

## Issues

Issues are welcome.

- **Bug:** include the OMPdesk version, your OS, `omp --version`, and the steps to reproduce. Logs help.
- **Feature idea:** describe the problem you want solved, not only the solution.
- **Vulnerability:** do not open an issue. Follow [SECURITY.md](SECURITY.md).

## Pull requests

- Open an issue first for anything non-trivial.
- Keep PRs small and focused on one change.
- Before you push, run:

  ```bash
  bun run check:types
  bunx biome check src e2e resources scripts
  bunx vitest run
  ```

- Every user-visible string needs the same key in both `src/renderer/locales/en.ts` and `ko.ts`.
- Do not add AI-attribution trailers to commit messages.
- The maintainer commits locally and batches releases, so a PR may be merged by rebase or squash rather than as-is.

Contributions are submitted under the [MIT License](LICENSE) (inbound = outbound), the same license as the project. There is no CLA.

New source files may start with `// SPDX-License-Identifier: MIT`. It is optional, and please do not mass-edit existing headers.

## Development rules

Architecture, conventions and the full list of checks are in [AGENTS.md](AGENTS.md). To run from source:

```bash
bun install
bun run dev
```
