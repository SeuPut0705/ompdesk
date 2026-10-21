/** GitHub's check run, commit status and workflow run states (rollup and REST alike), in the UI's words. */
const GITHUB_STATES: Record<string, true> = {
	success: true,
	failure: true,
	error: true,
	neutral: true,
	cancelled: true,
	skipped: true,
	timed_out: true,
	action_required: true,
	stale: true,
	startup_failure: true,
	queued: true,
	in_progress: true,
	waiting: true,
	requested: true,
	pending: true,
	expected: true,
	completed: true,
};

/** A state GitHub adds later reads as GitHub spells it. */
export function githubStateLabel(t: (key: string) => string, state: string): string {
	const key = state.toLowerCase();
	return GITHUB_STATES[key] ? t(`prCenter.checkState.${key}`) : key.replace(/_/g, " ");
}

/** Workflow triggers a run names (`event`), in the UI's words. */
const GITHUB_EVENTS: Record<string, true> = {
	push: true,
	pull_request: true,
	pull_request_target: true,
	workflow_dispatch: true,
	schedule: true,
	release: true,
	workflow_run: true,
	merge_group: true,
	dynamic: true,
};

/** What started a run; an event GitHub adds later reads as GitHub spells it. */
export function githubEventLabel(t: (key: string) => string, event: string): string {
	return GITHUB_EVENTS[event] ? t(`github.runs.event.${event}`) : event.replace(/_/g, " ");
}
