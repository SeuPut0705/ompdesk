import { describe, expect, it } from "vitest";
import { type HostNoticeRoutes, routeHostAutopilotNotice } from "./autopilot-notice-route";
import type { AutopilotNoticeEvent } from "./remote/app-protocol";

function routes(facts: ReturnType<HostNoticeRoutes["facts"]>) {
	const heard: string[] = [];
	const table: HostNoticeRoutes = {
		facts: () => facts,
		notifyTab: tabId => heard.push(`banner:${tabId}`),
		webPush: tabId => heard.push(`push:${tabId}`),
		banner: () => heard.push("plain"),
	};
	return { table, heard };
}

const notice: AutopilotNoticeEvent = {
	kind: "error",
	title: "Autopilot paused",
	body: "x",
	sessionPath: "/h/run.jsonl",
};

describe("routeHostAutopilotNotice", () => {
	it("a host's notice for a run this device shows reaches its tab's banner and this device's phones", () => {
		const { table, heard } = routes([
			{ tabId: "local", sessionFile: "/h/run.jsonl" },
			{ tabId: "other-host", device: "h2", sessionFile: "/h/run.jsonl" },
			{ tabId: "view", device: "h1", sessionFile: "/h/run.jsonl" },
		]);
		routeHostAutopilotNotice(table, "h1", notice);
		expect(heard).toEqual(["banner:view", "push:view"]);
	});

	it("with no tab on the run (the starter closed its view) it is a plain banner, and no phone push without a tab", () => {
		const { table, heard } = routes([{ tabId: "x", device: "h1", sessionFile: "/h/other.jsonl" }]);
		routeHostAutopilotNotice(table, "h1", notice);
		routeHostAutopilotNotice(table, "h1", { ...notice, sessionPath: undefined });
		expect(heard).toEqual(["plain", "plain"]);
	});
});
