# Checks on CI: `ompdesk_checks`

One tool replaces `gh workflow run`, `gh run watch`, `gh run view` and `scripts/ci-run.ts` for checks. OMPdesk keeps one poller for every session, so a wait costs no turns and no GitHub request of yours. Never poll a run yourself.

## Start

`ompdesk_checks {"op":"start"}` starts the checks of your folder's branch (pushed first). Optional:

- `purpose`: `branch` (default: work in progress), `release` (a release's gate), `land` (land this branch through OMPdesk's merge queue).
- `scope`: `changed` (default: what the change needs) or `full` (every check).
- `rerun`: `failed`, to run again only what failed in the branch's last run.
- `repo` (`owner/name`) and `ref` (a branch), when not your folder's.

You give no placement: OMPdesk decides what runs where (local or a runner, macOS or not) and in which lane. The answer names the decision and why:

- started: a run id; wait for it.
- reused: a green result already covers these inputs; nothing ran.
- held: it waits in OMPdesk's own queue (macOS full, release work first) and starts by itself; wait for it like a started run.
- refused: nothing started (the owner paused admission, a branch not allowed macOS, nothing pushed); the reason says what to do.

## Wait

`ompdesk_checks {"op":"wait","run":"<id>"}` ends when the result arrives. Optional `until`: `result` (default, the verdict) or `any` (the run's first change), and `timeout_seconds` (default 600, at most 3600).

The answer carries the judgment, so you read no logs:

- green, red or unknown. unknown means there is no trustworthy result yet (still running, or OMPdesk's facts are stale): never report it as green. A wait that runs out answers unknown; waiting again is free.
- each failing test with its first error line, whether it is known flaky and its record.
- whether it blocks a release gate, the expected wait, and what to do next (fix, rerun only the failures, wait, land, ask the user).

A message that reaches you ends the wait early; call it again to keep waiting. You may also end your turn instead of waiting: when the result arrives you are woken with it.

## Status

`ompdesk_checks {"op":"status"}` reads OMPdesk's own cache: every pool (GitHub's macOS limit, each computer's heavy slots) with what runs and waits, the runs and who started them, the release gates. `scope`: `mine` (default, runs you started), `repo` (the repository's) or `all`. Use it to decide whether to start release checks now or after the queue drains.

## From a shell

`ompdesk checks start|wait|status` takes the same arguments (`--purpose`, `--scope`, `--rerun-failed`, `--repo`, `--ref`; `wait RUN --until --timeout`). See skill://ompdesk/references/cli.md.
