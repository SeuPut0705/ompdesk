import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./ipc-types";
import {
	applySessionListDelta,
	compareSessionRows,
	diffSessionList,
	olderSessionListVersion,
	sameSessionRow,
} from "./session-list-delta";

const row = (path: string, modified: string, extra: Partial<SessionInfo> = {}): SessionInfo => ({
	path,
	id: path,
	title: null,
	cwd: "/work",
	created: "2026-10-01T00:00:00.000Z",
	modified,
	messageCount: 1,
	size: 10,
	status: "complete",
	firstMessage: "hi",
	...extra,
});

describe("session list deltas", () => {
	it("rebuilds the list it describes, in one order, keeping the rows that did not change", () => {
		const before = [
			row("/c", "2026-10-30T10:00:00.000Z"),
			row("/b", "2026-10-30T09:00:00.000Z"),
			row("/a", "2026-10-30T09:00:00.000Z"),
			row("/gone", "2026-10-29T00:00:00.000Z"),
		].sort(compareSessionRows);
		// Equal times order by path, so a receiver's sort gives the sender's order.
		expect(before.map(entry => entry.path)).toEqual(["/c", "/a", "/b", "/gone"]);
		const after = [
			row("/a", "2026-10-30T11:00:00.000Z", { size: 20 }),
			row("/new", "2026-10-30T10:30:00.000Z"),
			row("/c", "2026-10-30T10:00:00.000Z"),
			row("/b", "2026-10-30T09:00:00.000Z", { heldOnHost: true }),
		].sort(compareSessionRows);
		const delta = diffSessionList(before, after);
		expect(delta?.set.map(entry => entry.path).sort()).toEqual(["/a", "/b", "/new"]);
		expect(delta?.remove).toEqual(["/gone"]);
		const rebuilt = applySessionListDelta(before, delta ?? { set: [], remove: [] });
		expect(rebuilt).toEqual(after);
		expect(rebuilt[2]).toBe(before[0]);
	});

	it("says nothing changed for the same rows, and tells a field that appeared or went", () => {
		const rows = [row("/a", "2026-10-30T10:00:00.000Z")];
		expect(
			diffSessionList(
				rows,
				rows.map(entry => ({ ...entry })),
			),
		).toBeNull();
		expect(sameSessionRow(row("/a", "x"), row("/a", "x", { kind: "chat" }))).toBe(false);
		expect(sameSessionRow(row("/a", "x", { openedBySession: null }), row("/a", "x", { openedBySession: "/o" }))).toBe(
			false,
		);
	});

	it("orders versions of one run only", () => {
		expect(olderSessionListVersion("e1.2", "e1.10")).toBe(true);
		expect(olderSessionListVersion("e1.10", "e1.2")).toBe(false);
		expect(olderSessionListVersion("e1.2", "e2.10")).toBe(false);
	});
});
