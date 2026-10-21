/**
 * A tab a paired host keeps running for this computer comes back attached after the device relaunches (the 21 Oct
 * 2026 update restarts: a layout a stalled quit rewrote lost the host's tab, and a tab the layout kept came back
 * deferred, "not started", until someone looked at it). The ask is the host's `tabs.kept`; a session a tab here
 * already holds is started in that tab, so it attaches to the host's running turn instead of waiting to be shown.
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
	/** device:session → the tab here holding it, and whether that tab's process runs. */
	const held = new Map<string, { tab: string; started: boolean }>();
	const opened: string[] = [];
	const started: string[] = [];
	const log = vi.fn();
	const deps: HostTabReadopt = {
		kept: async () => {
			if (tabs instanceof Error) throw tabs;
			return tabs;
		},
		holder: (device, sessionPath) => held.get(`${device}:${sessionPath}`)?.tab ?? null,
		start: tabId => {
			const holding = [...held.values()].find(entry => entry.tab === tabId);
			if (!holding || holding.started) return false;
			holding.started = true;
			started.push(tabId);
			return true;
		},
		open: (device, tab) => {
			const id = open(device, tab);
			if (id) {
				opened.push(tab.rtab);
				held.set(`${device}:${tab.sessionPath}`, { tab: id, started: true });
			}
			return id;
		},
		log,
	};
	return { deps, held, opened, started, log };
}

describe("readoptHostTabs", () => {
	it("opens the host's working tab the layout did not name, and leaves alone the one a running tab already holds", async () => {
		const missing = kept("lost", { formerRtabs: ["older"], state: "asking", title: "Long job" });
		const present = kept("present");
		const { deps, held, opened, started, log } = setup([present, missing]);
		held.set("host-1:/host/sessions/present.jsonl", { tab: "tab-present", started: true });

		expect(await readoptHostTabs("host-1", deps)).toEqual(["tab-for-lost"]);
		expect(opened).toEqual(["lost"]);
		expect(started).toEqual([]);
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

	it("starts the tab the layout restored deferred for a session the host keeps working, instead of waiting to be shown", async () => {
		const { deps, held, opened, started, log } = setup([kept("child", { state: "running" })]);
		held.set("host-1:/host/sessions/child.jsonl", { tab: "tab-deferred", started: false });

		expect(await readoptHostTabs("host-1", deps)).toEqual(["tab-deferred"]);
		expect(opened).toEqual([]);
		expect(started).toEqual(["tab-deferred"]);
		expect(log).toHaveBeenCalledWith("readopt", {
			device: "host-1",
			rtab: "child",
			formerRtabs: [],
			session: "child.jsonl",
			state: "running",
			tab: "tab-deferred",
			held: true,
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
