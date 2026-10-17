/**
 * Autopilot's GUI-side commands. The coordinator (src/main/autopilot.ts) answers `get_autopilot` and
 * `set_autopilot` for a tab in `ipc.ts`, where the window and the pool are; what stays here is what needs
 * neither: the read-only branch comparison, main's own door into the bridge (`autopilot_bridge`, the way
 * `agent_control_confirm` reaches it), and the two commands for a caller that has no coordinator (a paired
 * host answering a device: the status as the bridge keeps it, and a refusal to control).
 */
import { AUTOPILOT_BRIDGE_METHODS } from "../../../resources/gui-bridge/modes/autopilot-contracts";
import { gitRaw } from "./git/exec";
import { LocalCommandError, type LocalHandler } from "./types";

const BRIDGE_METHODS: readonly string[] = Object.values(AUTOPILOT_BRIDGE_METHODS);
const REF = /^[^\s-][^\s]*$/;

function ref(value: unknown, what: string): string {
	if (typeof value !== "string" || !REF.test(value) || value.includes("..")) {
		throw new LocalCommandError(`Invalid ${what}.`, "invalid_ref");
	}
	return value;
}

export const handlers: Record<string, LocalHandler> = {
	autopilot_branch_status: async command => {
		const root = command.root;
		if (typeof root !== "string" || root.length === 0) throw new LocalCommandError("Invalid root.", "invalid_root");
		const base = ref(command.base, "base branch");
		const branch = ref(command.branch, "branch");
		const counted = await gitRaw(root, ["rev-list", "--left-right", "--count", `${base}...${branch}`, "--"], {
			timeoutMs: 30_000,
		}).catch(() => null);
		if (counted?.code !== 0) {
			throw new LocalCommandError(
				`Could not compare ${branch} with ${base}: ${counted?.stderr.trim() || "git failed"}`,
				"git_failed",
			);
		}
		const [behind = 0, ahead = 0] = counted.stdout.toString("utf8").trim().split(/\s+/).map(Number);
		return { ahead, behind };
	},
	autopilot_bridge: async (command, ctx) => {
		const method = command.method;
		if (typeof method !== "string" || !BRIDGE_METHODS.includes(method)) {
			throw new LocalCommandError(`${String(method)} is not an autopilot method.`, "invalid_method");
		}
		return ctx.bridge.request(method, command.params);
	},
	get_autopilot: (_command, ctx) => ctx.bridge.request(AUTOPILOT_BRIDGE_METHODS.status, {}),
	set_autopilot: async () => {
		throw new LocalCommandError(
			"Autopilot is controlled from the OMPdesk window on this computer.",
			"autopilot_local_only",
		);
	},
};
