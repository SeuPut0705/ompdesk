import { describe, expect, it } from "vitest";
import type { SessionInfo } from "../../shared/ipc-types";
import { rankSessions } from "./session-search";

function row(id: string, overrides: Partial<SessionInfo> = {}): SessionInfo {
	return {
		path: `/s/${id}.jsonl`,
		id,
		title: id,
		cwd: "/work",
		created: "2026-01-01T00:00:00Z",
		modified: "2026-01-01T00:00:00Z",
		messageCount: 2,
		size: 10,
		status: "complete",
		firstMessage: "hello",
		...overrides,
	};
}

describe("rankSessions", () => {
	it("finds a renamed session by its automatic title as well as by the name", () => {
		const renamed = row("renamed", { title: "Release prep", autoTitle: "Fix the login redirect" });
		const other = row("other");
		expect(rankSessions([other, renamed], "login redirect")).toEqual([renamed]);
		expect(rankSessions([other, renamed], "release")).toEqual([renamed]);
	});
});
