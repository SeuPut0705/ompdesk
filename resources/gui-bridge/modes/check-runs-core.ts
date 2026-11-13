/**
 * Check runs, pure half (./check-runs.ts wires it): one static per-turn section telling the agent to run heavy
 * commands in the computer's heavy slots (`ompdesk run --heavy`) and test suites through `ompdesk check`, which reuses
 * only results whose inputs are unchanged, reruns failures alone, keeps flaky tests visible and survives an OMPdesk
 * restart (`native/ompdesk/crates/checks`). Measured before it: one project's release check took 142 minutes and was
 * run from scratch three times, the last after a 7-line change; checks took 22-77 % of tool time in this
 * computer's sessions.
 *
 * Every session gets it, subagents included: the `ompdesk` CLI is on the PATH of everything OMPdesk spawns, and its
 * local commands need no running OMPdesk and no control socket.
 *
 * No omp imports (not even types): the GUI's vitest loads this file directly.
 */

export const CHECK_RUNS_SECTION_ID = "check-runs";

export const CHECK_RUNS_SECTION = `<check-runs>
Run a test suite or a project's check script as \`ompdesk check -- <command>\`: it reuses results whose inputs are unchanged, reruns only what failed, keeps flaky tests visible, takes a heavy slot itself and keeps running across an OMPdesk restart (\`ompdesk check attach\` follows it again).
Wrap any other heavy command (a build, a type check, a dev server for e2e) as \`ompdesk run --heavy -- <command>\`, so this computer runs only as many at once as it can hold.
</check-runs>`;
