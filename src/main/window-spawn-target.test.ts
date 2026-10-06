import { describe, expect, it } from "vitest";
import { resolveWindowSpawnTarget } from "./window-spawn-target";

describe("resolveWindowSpawnTarget", () => {
	it("opens an untargeted window as a fresh agent in the default Work workspace", () => {
		expect(resolveWindowSpawnTarget(undefined, undefined, undefined, "/last-project", "/neutral-home")).toEqual({
			cwd: "/neutral-home",
			kind: "agent",
			fresh: true,
			placeholder: true,
		});
	});

	it("preserves an explicitly selected workspace as an agent window", () => {
		expect(
			resolveWindowSpawnTarget("/selected-project", undefined, undefined, "/last-project", "/neutral-home"),
		).toEqual({
			cwd: "/selected-project",
			kind: "agent",
			fresh: false,
			placeholder: false,
		});
	});

	it("uses the requested session kind when opening a known transcript", () => {
		expect(
			resolveWindowSpawnTarget(undefined, "/sessions/chat.jsonl", "chat", "/session-cwd", "/neutral-home"),
		).toEqual({
			cwd: "/session-cwd",
			kind: "chat",
			fresh: false,
			placeholder: false,
		});
	});
});
