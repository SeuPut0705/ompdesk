/**
 * Stock (agent-session.ts, omp 18.12.3) answers a failed `todo` call with a hidden `todo-error-reminder` sent
 * `deliverAs: "nextTurn"`. During a turn that queues it for the next explicit prompt, where it is late (it says "call
 * todo again before continuing") and, counted by `queuedMessageCount`, keeps `isRpcSessionSettled` false, so the
 * session never reports settled. Only that reminder, only while a turn streams, goes as stock's `aside` instead: the
 * agent loop reads it at the next step of the same turn. Everything else, `triggerTurn` included, is untouched.
 */

export const TODO_ERROR_REMINDER = "todo-error-reminder";

export interface CustomMessageOptions {
	deliverAs?: string;
	triggerTurn?: boolean;
	[key: string]: unknown;
}

/** The options to send with, or undefined to leave stock's call as it is. */
export function rerouteTodoReminder(
	message: { customType?: unknown } | undefined,
	options: CustomMessageOptions | undefined,
	streaming: boolean,
): CustomMessageOptions | undefined {
	if (!streaming || message?.customType !== TODO_ERROR_REMINDER) return undefined;
	if (options?.deliverAs !== "nextTurn" || options.triggerTurn === true) return undefined;
	return { ...options, deliverAs: "aside" };
}
