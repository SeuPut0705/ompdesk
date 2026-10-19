/**
 * gui-bridge background checks (resources/gui-bridge/modes/background-checks-core.ts): which sessions get the
 * section that tells the agent to run long checks as background jobs.
 */
import { describe, expect, it } from "vitest";
import { AUTOPILOT_STATE_ENTRY } from "../../resources/gui-bridge/modes/autopilot-contracts";
import { autopilotRunning } from "../../resources/gui-bridge/modes/autopilot-core";
import {
	BACKGROUND_CHECKS_SECTION,
	backgroundChecksSection,
} from "../../resources/gui-bridge/modes/background-checks-core";

const journal = (state?: string) =>
	state === undefined ? [] : [{ type: "custom", customType: AUTOPILOT_STATE_ENTRY, data: { state } }];

describe("background checks section", () => {
	it("is given to a session whose bash takes async, outside an Autopilot run", () => {
		for (const state of [undefined, "ended", "paused"]) {
			const autopilot = autopilotRunning(journal(state));
			expect(backgroundChecksSection({ asyncEnabled: true, autopilot })).toBe(BACKGROUND_CHECKS_SECTION);
		}
	});

	it("is left out when stock async is off: the bash tool has no async parameter then", () => {
		expect(backgroundChecksSection({ asyncEnabled: false, autopilot: false })).toBeUndefined();
	});

	it("is left out of a running Autopilot run, whose cycle report is judged from foreground check results", () => {
		for (const state of ["running", "stopping"]) {
			const autopilot = autopilotRunning(journal(state));
			expect(backgroundChecksSection({ asyncEnabled: true, autopilot })).toBeUndefined();
		}
	});
});
