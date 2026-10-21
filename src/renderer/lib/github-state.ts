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

/** What a notification is about (`subject.type`), in the UI's words. */
const NOTIFICATION_TYPES: Record<string, true> = {
	Issue: true,
	PullRequest: true,
	Commit: true,
	Release: true,
	Discussion: true,
	CheckSuite: true,
	RepositoryInvitation: true,
	RepositoryVulnerabilityAlert: true,
};

/** A notification's subject; a kind GitHub adds later reads as GitHub spells it. */
export function githubNotificationTypeLabel(t: (key: string) => string, type: string): string {
	return NOTIFICATION_TYPES[type] ? t(`github.notifications.type.${type}`) : type;
}

/** Why a notification came in (`reason`), in the UI's words. */
const NOTIFICATION_REASONS: Record<string, true> = {
	approval_requested: true,
	assign: true,
	author: true,
	ci_activity: true,
	comment: true,
	invitation: true,
	manual: true,
	mention: true,
	review_requested: true,
	security_alert: true,
	state_change: true,
	subscribed: true,
	team_mention: true,
};

/** Why a notification came in; a reason GitHub adds later reads as GitHub spells it. */
export function githubNotificationReasonLabel(t: (key: string) => string, reason: string): string {
	return NOTIFICATION_REASONS[reason] ? t(`github.notifications.reason.${reason}`) : reason.replace(/_/g, " ");
}
