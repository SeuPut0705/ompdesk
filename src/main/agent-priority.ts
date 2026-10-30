import * as os from "node:os";

/**
 * Below the app's own processes, above nothing: nice +10 on macOS and Linux, BELOW_NORMAL_PRIORITY_CLASS on
 * Windows (libuv maps this one constant to each). It only decides who goes first when the app and an agent both
 * want a core; an agent still gets every idle one. Not the efficiency-core QoS (`taskpolicy -b`), which also
 * throttles disk I/O and would slow an agent on an idle machine.
 */
export const AGENT_PRIORITY = os.constants.priority.PRIORITY_BELOW_NORMAL;

export type LowerAgentPriority = (pid: number | undefined) => void;

export interface AgentPriorityDeps {
	/** Told once, with the reason, the first time the priority could not be set. */
	report?: (reason: string) => void;
	setPriority?: (pid: number, priority: number) => void;
}

/**
 * Lowers a freshly spawned omp's priority; its children inherit it (fork and CreateProcess both carry it over).
 * Never throws: an omp that already exited (ESRCH) or a platform that refuses is a missing nicety, not a failed start.
 */
export function agentPriorityLowerer(deps: AgentPriorityDeps = {}): LowerAgentPriority {
	const setPriority = deps.setPriority ?? os.setPriority;
	let reported = false;
	return pid => {
		if (pid === undefined) return;
		try {
			setPriority(pid, AGENT_PRIORITY);
		} catch (err) {
			if (reported) return;
			reported = true;
			deps.report?.(err instanceof Error ? err.message : String(err));
		}
	};
}

export const lowerAgentPriority: LowerAgentPriority = agentPriorityLowerer();
