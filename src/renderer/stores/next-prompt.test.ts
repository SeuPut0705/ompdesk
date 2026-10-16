import { afterEach, describe, expect, it } from "vitest";
import type { NextPromptUpdate } from "../../../resources/gui-bridge/next-prompt-contracts";
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
