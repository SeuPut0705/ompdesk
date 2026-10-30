import * as os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { AGENT_PRIORITY, agentPriorityLowerer } from "./agent-priority";

describe("agentPriorityLowerer", () => {
	it("sets the below-normal priority on the spawned pid", () => {
		const setPriority = vi.fn();
		agentPriorityLowerer({ setPriority })(4242);
		expect(setPriority).toHaveBeenCalledWith(4242, os.constants.priority.PRIORITY_BELOW_NORMAL);
		expect(AGENT_PRIORITY).toBeGreaterThan(0);
	});

	it("does nothing for a spawn that has no pid", () => {
		const setPriority = vi.fn();
		agentPriorityLowerer({ setPriority })(undefined);
		expect(setPriority).not.toHaveBeenCalled();
	});

	it("never throws, and reports only the first failure", () => {
		const report = vi.fn();
		const setPriority = vi.fn(() => {
			throw new Error("ESRCH: no such process");
		});
		const lower = agentPriorityLowerer({ setPriority, report });
		expect(() => {
			lower(1);
			lower(2);
		}).not.toThrow();
		expect(setPriority).toHaveBeenCalledTimes(2);
		expect(report).toHaveBeenCalledTimes(1);
		expect(report).toHaveBeenCalledWith("ESRCH: no such process");
	});
});
