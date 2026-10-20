import { describe, expect, it } from "vitest";
import { rerouteTodoReminder, TODO_ERROR_REMINDER } from "../../resources/gui-bridge/todo-reminder-core";

describe("which custom messages the bridge reroutes", () => {
	const reminder = { customType: TODO_ERROR_REMINDER };

	it("sends stock's todo-error reminder as an aside of the turn that streams", () => {
		expect(rerouteTodoReminder(reminder, { deliverAs: "nextTurn" }, true)).toEqual({ deliverAs: "aside" });
	});

	it("leaves everything else as stock sent it", () => {
		// Idle: stock appends it to the context at once and nothing waits.
		expect(rerouteTodoReminder(reminder, { deliverAs: "nextTurn" }, false)).toBeUndefined();
		// A deferred message that starts its own turn stays stock's.
		expect(rerouteTodoReminder(reminder, { deliverAs: "nextTurn", triggerTurn: true }, true)).toBeUndefined();
		expect(rerouteTodoReminder(reminder, { deliverAs: "steer" }, true)).toBeUndefined();
		expect(rerouteTodoReminder({ customType: "skillful-notice" }, { deliverAs: "nextTurn" }, true)).toBeUndefined();
		expect(rerouteTodoReminder(undefined, undefined, true)).toBeUndefined();
	});
});
