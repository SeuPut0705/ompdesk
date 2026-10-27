import { describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { buildHistoryRows, type HistoryRow } from "./chat-stream-utils";

const skillPrompt = (name: string, timestamp: number, attribution: "user" | "agent" = "user"): AgentMessage => ({
	role: "custom",
	customType: "skill-prompt",
	content: "Skill instructions",
	display: true,
	attribution,
	details: { name },
	timestamp,
});
const user = (timestamp: number): AgentMessage => ({ role: "user", content: "go", timestamp });
const call = (id: string, timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id, name: "bash", arguments: { command: "ls" } }],
	stopReason: "toolUse",
	timestamp,
});
const answer = (timestamp: number): AgentMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "Done" }],
	timestamp,
});

const runs = (rows: HistoryRow[]) => rows.filter(row => row.kind === "process");

describe("the skills a work row's prompt named", () => {
	it("gives the run a /skill: prompt started the skill, and no later run of another turn", () => {
		const rows = runs(
			buildHistoryRows(
				[skillPrompt("release", 1), call("a", 2), answer(3), user(4), call("b", 5), answer(6)],
				"compact",
			),
		);
		expect(rows.map(row => row.kind === "process" && row.skills)).toEqual([["release"], undefined]);
	});

	it("names each skill once, in the order the turn was given them", () => {
		const [work] = runs(
			buildHistoryRows(
				[
					skillPrompt("release", 1),
					skillPrompt("review", 2, "agent"),
					skillPrompt("release", 3),
					call("a", 4),
					answer(5),
				],
				"compact",
			),
		);
		expect(work?.kind === "process" && work.skills).toEqual(["release", "review"]);
	});

	it("keeps a skill prompt injected into a running card among its notes, not its leading skills", () => {
		const [work] = runs(
			buildHistoryRows([user(1), call("a", 2), skillPrompt("review", 3, "agent"), answer(4)], "compact"),
		);
		if (work?.kind !== "process") throw new Error("expected a work row");
		expect(work.skills).toBeUndefined();
		expect(work.notes?.map(note => note.customType)).toEqual(["skill-prompt"]);
	});
});
