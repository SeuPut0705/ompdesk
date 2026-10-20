/**
 * Background checks, pure half (./background-checks.ts wires it): one short per-turn prompt section telling the
 * agent to run tests, builds, lints and typechecks as background jobs (stock bash `async: true`) by default and keep
 * working on what does not depend on them. Stock's bash description only says what `async` does: a model that does
 * not know how long a suite takes runs it in the foreground and waits (measured: AGENTS.md, Background checks).
 *
 * The section reaches every session OMPdesk runs, subagents included (they run checks too). It is left out when:
 * - `async.enabled` is off (the bash tool has no `async` parameter then);
 * - an Autopilot run owns the session (parent or child): its cycle report is checked against the turn's own tool
 *   calls (autopilot-verify.ts), and a background job's call carries no verdict.
 *
 * The text is static, so the provider's prompt cache holds across turns.
 *
 * No omp imports (not even types): the GUI's vitest loads this file directly.
 */

export const BACKGROUND_CHECKS_SECTION_ID = "background-checks";

export const BACKGROUND_CHECKS_SECTION = `<background-checks>
Run tests, builds, lints and typechecks with bash \`async: true\` by default (how long a suite takes is rarely known up front), then keep working on steps that do not depend on the result. It arrives by itself; call \`wait\` when nothing else is left. Read it before you say the work is done and before an edit that depends on it.
A run that started before your last edit to the code it covers says nothing about that code: never wait for it, cancel it if it is still going, and run the check once on the edited tree.
Keep a run in the foreground only when the very next step needs its output, when it must be watched interactively, or when it would fight another run for the same lock, port or build directory.
</background-checks>`;

export interface BackgroundChecksGate {
	/** Stock `async.enabled`: the bash tool takes `async`. */
	asyncEnabled: boolean;
	/** The branch journals a running or stopping Autopilot run. */
	autopilot: boolean;
}

/** The section text for this session, or undefined for none. */
export function backgroundChecksSection(gate: BackgroundChecksGate): string | undefined {
	return gate.asyncEnabled && !gate.autopilot ? BACKGROUND_CHECKS_SECTION : undefined;
}
