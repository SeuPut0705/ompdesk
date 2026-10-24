import { afterEach, describe, expect, it, vi } from "vitest";
import type { NextPromptUpdate } from "../../../resources/gui-bridge/modes/next-prompt-contracts";
import { useNextPromptStore } from "./next-prompt";
import { useTabsStore } from "./tabs";

const widget = (text: string) => [`\x1b[2m↹ Tab  ${text}\x1b[22m`];
const update = (patch: Partial<NextPromptUpdate>): NextPromptUpdate => ({
	type: "next_prompt_update",
	status: "ready",
	...patch,
});
const texts = () =>
	Object.fromEntries(Object.entries(useNextPromptStore.getState().suggestions).map(([key, v]) => [key, v.candidates]));

afterEach(() => {
	useNextPromptStore.getState().reset();
	useTabsStore.getState().reset();
});

describe("next-prompt store", () => {
	it("keeps each session's suggestion and ignores the extension's clears", () => {
		const store = useNextPromptStore.getState();
		store.recordWidget("/a.jsonl", widget("first"));
		store.recordWidget("/b.jsonl", widget("second"));
		store.recordWidget("/a.jsonl", undefined);
		expect(texts()).toEqual({ "/a.jsonl": ["first"], "/b.jsonl": ["second"] });
	});

	it("records one widget publication once, so a consumed suggestion never comes back", () => {
		const lines = widget("once");
		useNextPromptStore.getState().recordWidget("/a.jsonl", lines);
		useNextPromptStore.getState().clear("/a.jsonl");
		useNextPromptStore.getState().recordWidget("/a.jsonl", lines);
		expect(useNextPromptStore.getState().suggestions).toEqual({});
	});

	it("remembers a bounded number of sessions, dropping the oldest", () => {
		for (let index = 0; index < 60; index += 1)
			useNextPromptStore.getState().recordWidget(`/s${index}.jsonl`, widget(`p${index}`));
		const suggestions = useNextPromptStore.getState().suggestions;
		expect(Object.keys(suggestions)).toHaveLength(50);
		expect(suggestions["/s9.jsonl"]).toBeUndefined();
		expect(suggestions["/s59.jsonl"]?.candidates).toEqual(["p59"]);
	});

	it("drops a session's suggestion when its tab starts a run", () => {
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false, sessionPath: "/a.jsonl" }],
		});
		useNextPromptStore.getState().recordWidget("/a.jsonl", widget("stale soon"));
		useNextPromptStore.getState().recordWidget("/b.jsonl", widget("other"));
		useTabsStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, status: "running" as const })) }));
		expect(texts()).toEqual({ "/b.jsonl": ["other"] });
	});

	it("keeps it when a paired host's tab comes back from a lost link still running its turn", () => {
		useTabsStore.setState({
			tabs: [
				{ kind: "agent", id: "t0", cwd: "/tmp", status: "starting", unreadDone: false, sessionPath: "/a.jsonl" },
			],
		});
		useNextPromptStore.getState().recordWidget("/a.jsonl", widget("still good"));
		useTabsStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, status: "running" as const })) }));
		expect(texts()).toEqual({ "/a.jsonl": ["still good"] });
	});

	describe("recordLast (what a hydration read from the session's bridge)", () => {
		const last = (candidates: string[], at: number) => ({ candidates, at, sessionFile: "/a.jsonl" });

		it("brings back a suggestion the page missed, and drops one a run made stale", () => {
			const store = useNextPromptStore.getState();
			store.recordLast("/a.jsonl", last(["missed it"], 1_000), Date.now());
			expect(texts()).toEqual({ "/a.jsonl": ["missed it"] });
			store.recordLast("/a.jsonl", last([], 2_000), Date.now() + 1);
			expect(texts()).toEqual({});
		});

		it("never undoes what the page did after the read started", () => {
			vi.useFakeTimers({ now: 10_000 });
			try {
				const store = useNextPromptStore.getState();
				const since = Date.now();
				vi.setSystemTime(10_500);
				// A frame landed while the read was on its way: it is newer.
				store.recordUpdate("/a.jsonl", update({ candidates: ["live frame"] }));
				store.recordLast("/a.jsonl", last(["read answer"], 9_000), since);
				expect(texts()).toEqual({ "/a.jsonl": ["live frame"] });
				// The person sent something after the suggestion was made: it never comes back.
				vi.setSystemTime(11_000);
				store.clear("/a.jsonl");
				store.recordLast("/a.jsonl", last(["live frame"], 10_400), 11_200);
				expect(texts()).toEqual({});
				// A newer suggestion, made after that, does.
				store.recordLast("/a.jsonl", last(["after the run"], 12_000), 12_100);
				expect(texts()).toEqual({ "/a.jsonl": ["after the run"] });
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("recordUpdate", () => {
		it("stores ready candidates with the model used", () => {
			const used = { model: "p/small", role: "smol" };
			useNextPromptStore.getState().recordUpdate("/a.jsonl", update({ candidates: ["one", "two"], used }));
			const entry = useNextPromptStore.getState().suggestions["/a.jsonl"];
			expect(entry?.candidates).toEqual(["one", "two"]);
			expect(entry?.used).toEqual(used);
		});

		it("clears the session on ready without candidates", () => {
			const store = useNextPromptStore.getState();
			store.recordUpdate("/a.jsonl", update({ candidates: ["one"] }));
			store.recordUpdate("/a.jsonl", update({ candidates: [] }));
			expect(texts()).toEqual({});
		});

		it("clears the session on cleared", () => {
			const store = useNextPromptStore.getState();
			store.recordUpdate("/a.jsonl", update({ candidates: ["one"] }));
			store.recordUpdate("/b.jsonl", update({ candidates: ["two"] }));
			store.recordUpdate("/a.jsonl", update({ status: "cleared" }));
			expect(texts()).toEqual({ "/b.jsonl": ["two"] });
		});

		it("leaves the memory alone on unavailable", () => {
			const store = useNextPromptStore.getState();
			store.recordUpdate("/a.jsonl", update({ candidates: ["one"] }));
			store.recordUpdate("/a.jsonl", update({ status: "unavailable", reason: "offline" }));
			expect(texts()).toEqual({ "/a.jsonl": ["one"] });
		});

		it("records one update object once", () => {
			const frame = update({ candidates: ["once"] });
			useNextPromptStore.getState().recordUpdate("/a.jsonl", frame);
			useNextPromptStore.getState().clear("/a.jsonl");
			useNextPromptStore.getState().recordUpdate("/a.jsonl", frame);
			expect(useNextPromptStore.getState().suggestions).toEqual({});
		});
	});
});
