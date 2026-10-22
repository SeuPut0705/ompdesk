# Autopilot

[한국어](autopilot.ko.md) · [Back to the README](../README.md)

Autopilot develops a project on its own, one cycle after another, until you end it. Each cycle audits the code, picks one item, implements it, runs the project's own check and commits. It works in a new git worktree, so your folder and your current branch are never touched.

## Start a run

1. Open a session in a git repository.
2. In the composer, open the Run chip, choose **Autopilot** under Mode, and press **Start Autopilot**.

The run opens in a new tab on a new branch, `autopilot/<date>`, cut from the branch checked out in your folder. Nothing else needs to be set. **Advanced** in the same place has:

- **Shipping**: where green cycles go (below).
- **Branch**: the folder's branch the run starts from.
- **Focus** areas (design, performance, features, refactoring, tests, bugs, docs). None selected means all of them.
- **Backlog**: items the agent does first, one per line.

## What happens to the work

Shipping is **Automatic** unless you pick another level:

- With a remote, every **green** cycle that made a commit lands on the default branch. If someone else moved that branch meanwhile, OMPdesk merges in a separate checkout and runs the cycle's check on the merged result before it pushes; a conflict or a failing check lands nothing and tells the agent to merge first. A protected branch gets one pull request instead, updated by later cycles.
- Without a remote, commits stay on your computer.
- A red cycle, or one without a commit, never lands.
- The project releases only if it already has a release procedure: in its rules files (`AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md`) or in the Release section of `AUTOPILOT.md`. The agent decides when, by the project's own release rhythm and how long ago the run's last release went out; a fix for a broken release still ships at once.

**Commit**, **Push** and **Release** under Advanced keep the commits local, push only the run's branch, or push and release.

## Steer it

- **Work board.** The run's tab shows its board: the run's state, the cycle in flight and its step, the recent cycles (tap one for its commit, time and change, and **Revert**), what the cycles left for later, and the backlog. On a narrow window, a split pane or a phone, tap the strip under the header to open it.
- **Left for later.** What earlier cycles found but did not do. Pin one to put it on the backlog, so the next cycle takes it first (it then shows only on the backlog); ✕ takes it off the agent's list. A later cycle that runs into the same thing again lists it again.
- **Your own words.** Type into the run's composer as in any session. The cycle in progress takes your message as a steer; a request to push or release is passed on to the runtime.
- **`AUTOPILOT.md`.** At the start OMPdesk writes the project's guide (goals, priorities, paths not to touch, what done means, how it releases) and commits it as the run's first commit, so it reaches your default branch with the work. Edit it like any file; every cycle reads it again. The repository's rules files win where they differ.

## Stop it

- **Pause** lets the current turn finish and starts no new cycle; **Resume** goes on.
- **End** lets the cycle in flight finish, then ends the run.
- **Stop now** stops the turn at once and pauses the run.

The run does not stop on its own for a red cycle, a failed check or a rejected push: the next cycle repairs it. It pauses only for you, for a git change it did not expect, when the repository folder is gone, and, with **Continue interrupted work after relaunch** off, when OMPdesk closes. On a usage limit it waits and continues at the reset by itself. A crash, an update or a normal quit continues the run on the next launch.

## What it never does

- No force push, history rewrite, reset or branch deletion, and the agent itself never pushes: only OMPdesk lands, pushes and releases, as the shipping level allows.
- No edits outside its worktree, no secrets in commits, no changes to your accounts or settings.

## Notifications

A run tells you when it pauses or stops, when it ends, and how a release went, never after each cycle. Every end or pause also writes one summary line (cycles, green, commits, what landed) to OMPdesk's log.

## On another computer

In a session of a folder on a paired computer (see [Remote devices](remote-devices.md)), Autopilot runs on that computer, as a tab of its own window: it keeps going if this device closes the tab or goes away.
