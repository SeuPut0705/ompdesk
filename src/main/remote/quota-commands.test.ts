import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RpcCommand } from "../../shared/rpc-types";
import {
	CONDITIONAL_MODEL_COMMAND_TYPES,
	commandUsesModel,
	MODEL_COMMAND_TYPES,
	QUOTA_FREE_COMMAND_TYPES,
} from "./quota-commands";

/** Every `type: "…"` literal of the `RpcCommand` union, read from the contract file. */
function rpcCommandTypes(): string[] {
	const source = readFileSync(new URL("../../shared/rpc-types.ts", import.meta.url), "utf8");
	const start = source.indexOf("export type RpcCommand =");
	const end = source.indexOf("// RPC Responses", start);
	if (start < 0 || end < 0) throw new Error("RpcCommand union not found in rpc-types.ts");
	const types = new Set<string>();
	for (const match of source.slice(start, end).matchAll(/\btype: "([a-z_]+)"/g)) types.add(match[1] as string);
	return [...types].sort();
}

const command = (value: Record<string, unknown>) => value as unknown as RpcCommand;

describe("quota command classification", () => {
	it("covers every RPC command type exactly once, so a new model-calling command cannot slip past the limit", () => {
		const lists = [MODEL_COMMAND_TYPES, CONDITIONAL_MODEL_COMMAND_TYPES, QUOTA_FREE_COMMAND_TYPES];
		const classified = lists.flat().sort();
		expect(new Set(classified).size).toBe(classified.length);
		expect(classified).toEqual(rpcCommandTypes());
	});

	it("reads the union well enough to know the commands it is guarding", () => {
		const types = rpcCommandTypes();
		expect(types.length).toBeGreaterThan(200);
		expect(types).toEqual(expect.arrayContaining(["prompt", "omfg", "switch_leaf", "plan_approval", "get_state"]));
	});

	it("counts the commands that call a model beyond the original ten", () => {
		for (const type of ["omfg", "tan", "restore_interrupted", "security_start", "guided_goal", "pr_draft"]) {
			expect(commandUsesModel(command({ type })), type).toBe(true);
		}
		for (const type of ["get_state", "set_setting", "git_commit", "abort", "queue_edit"]) {
			expect(commandUsesModel(command({ type })), type).toBe(false);
		}
	});

	it("counts a forced memory consolidation, not reviving a parked subagent", () => {
		// Stock `backend.enqueue`: mnemopi extracts facts with an LLM, hindsight retains through its server's model,
		// the local backend marks consolidation due (a model run at the next start).
		expect(commandUsesModel(command({ type: "memory_enqueue" }))).toBe(true);
		// `AgentLifecycleManager.ensureLive` rebuilds the session from its file; it sends no prompt.
		expect(commandUsesModel(command({ type: "revive_subagent", agentId: "a" }))).toBe(false);
	});

	it("counts a command no list knows, as a client newer than this host may send it", () => {
		expect(commandUsesModel(command({ type: "invented_by_a_newer_client" }))).toBe(true);
	});

	it("counts a leaf switch only when it summarizes", () => {
		expect(commandUsesModel(command({ type: "switch_leaf", entryId: "e" }))).toBe(false);
		expect(commandUsesModel(command({ type: "switch_leaf", entryId: "e", summarize: true }))).toBe(true);
	});

	it("counts a plan approval that runs the plan or sends feedback, not a save or a bare rejection", () => {
		expect(commandUsesModel(command({ type: "plan_approval", approved: true, option: "execute" }))).toBe(true);
		expect(commandUsesModel(command({ type: "plan_approval", approved: true }))).toBe(true);
		expect(commandUsesModel(command({ type: "plan_approval", approved: true, option: "compact" }))).toBe(true);
		expect(commandUsesModel(command({ type: "plan_approval", approved: true, option: "save" }))).toBe(false);
		expect(commandUsesModel(command({ type: "plan_approval", approved: false }))).toBe(false);
		expect(commandUsesModel(command({ type: "plan_approval", approved: false, feedback: "  " }))).toBe(false);
		expect(commandUsesModel(command({ type: "plan_approval", approved: false, feedback: "shorter" }))).toBe(true);
	});

	it("counts a goal that starts or resumes a turn, not a budget, pause or drop", () => {
		expect(commandUsesModel(command({ type: "set_goal", objective: "ship it" }))).toBe(true);
		expect(commandUsesModel(command({ type: "set_goal", action: "resume" }))).toBe(true);
		expect(commandUsesModel(command({ type: "set_goal", action: "pause" }))).toBe(false);
		expect(commandUsesModel(command({ type: "set_goal", action: "drop" }))).toBe(false);
		expect(commandUsesModel(command({ type: "set_goal", tokenBudget: 5 }))).toBe(false);
		expect(commandUsesModel(command({ type: "set_goal", objective: "  " }))).toBe(false);
	});

	it("counts the prompt-suggestion requests that run the cheap model, not the state, draft and cancel commands", () => {
		for (const type of ["complete_inline", "refresh_next_prompt"]) {
			expect(commandUsesModel(command({ type })), type).toBe(true);
		}
		for (const type of ["get_next_prompt", "set_next_prompt_draft", "cancel_next_prompt"]) {
			expect(commandUsesModel(command({ type })), type).toBe(false);
		}
	});
});
