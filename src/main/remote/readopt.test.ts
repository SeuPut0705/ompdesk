/**
 * A tab a paired host keeps running for this computer that this computer's saved layout does not name comes back
 * (the 21 Oct 2026 update restart: the layout a stalled quit rewrote lost the host's tab, and the next launch never
 * reopened it). The ask is the host's `tabs.kept`; a tab a local tab already holds is left to that tab.
 */
import { describe, expect, it, vi } from "vitest";
import { codedError } from "../../shared/ipc-error-codes";
import type { KeptTab } from "./app-protocol";
import { type HostTabReadopt, readoptHostTabs } from "./readopt";

function kept(rtab: string, patch: Partial<KeptTab> = {}): KeptTab {
	return {
		rtab,
		formerRtabs: [],
		sessionPath: `/host/sessions/${rtab}.jsonl`,
		cwd: "/host/work",
		kind: "agent",
		state: "running",
		...patch,
	};
}

function setup(tabs: KeptTab[] | null | Error, open: HostTabReadopt["open"] = (_device, tab) => `tab-for-${tab.rtab}`) {
	const held = new Set<string>();
	const opened: string[] = [];
	const log = vi.fn();
	const deps: HostTabReadopt = {
		kept: async () => {
			if (tabs instanceof Error) throw tabs;
			return tabs;
		},
		holds: (device, sessionPath) => held.has(`${device}:${sessionPath}`),
		open: (device, tab) => {
			const id = open(device, tab);
			if (id) {
				opened.push(tab.rtab);
				held.add(`${device}:${tab.sessionPath}`);
			}
			return id;
		},
		log,
	};
	return { deps, held, opened, log };
}

describe("readoptHostTabs", () => {
	it("opens the host's working tab the layout did not name, and skips the one a local tab already holds", async () => {
		const missing = kept("lost", { formerRtabs: ["older"], state: "asking", title: "Long job" });
		const present = kept("present");
		const { deps, held, opened, log } = setup([present, missing]);
		held.add("host-1:/host/sessions/present.jsonl");

		expect(await readoptHostTabs("host-1", deps)).toEqual(["tab-for-lost"]);
		expect(opened).toEqual(["lost"]);
		// One runtime-log line per re-adopted tab, naming the ids the host knows.
		expect(log).toHaveBeenCalledTimes(1);
		expect(log).toHaveBeenCalledWith("readopt", {
			device: "host-1",
			rtab: "lost",
			formerRtabs: ["older"],
			session: "lost.jsonl",
			state: "asking",
			tab: "tab-for-lost",
		});
	});

	it("opens a session once however many asks overlap", async () => {
		const { deps, opened } = setup([kept("lost")]);
		await Promise.all([readoptHostTabs("host-1", deps), readoptHostTabs("host-1", deps)]);
		expect(opened).toEqual(["lost"]);
	});

	it("does nothing for a host that cannot say, a host that is away, or a tab no window can open", async () => {
		for (const answer of [null, codedError("remote_offline", "offline")] as const) {
			const { deps, opened } = setup(answer);
			expect(await readoptHostTabs("host-1", deps)).toEqual([]);
			expect(opened).toEqual([]);
		}
		const none = setup([kept("lost")], () => null);
		expect(await readoptHostTabs("host-1", none.deps)).toEqual([]);
		expect(none.log).not.toHaveBeenCalled();
	});

	it("logs a host's failure to answer once, as a failure", async () => {
		const { deps, log } = setup(new Error("boom"));
		expect(await readoptHostTabs("host-1", deps)).toEqual([]);
		expect(log).toHaveBeenCalledWith("readopt-failed", { device: "host-1", error: "boom" });
	});
});
