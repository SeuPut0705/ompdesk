import { afterEach, describe, expect, it } from "vitest";
import { useNextPromptStore } from "./next-prompt";
import { useTabsStore } from "./tabs";

const widget = (text: string) => [`\x1b[2m↹ Tab  ${text}\x1b[22m`];

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
		expect(useNextPromptStore.getState().suggestions).toEqual({ "/a.jsonl": "first", "/b.jsonl": "second" });
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
		expect(suggestions["/s59.jsonl"]).toBe("p59");
	});

	it("drops a session's suggestion when its tab starts a run", () => {
		useTabsStore.setState({
			tabs: [{ kind: "agent", id: "t0", cwd: "/tmp", status: "ready", unreadDone: false, sessionPath: "/a.jsonl" }],
		});
		useNextPromptStore.getState().recordWidget("/a.jsonl", widget("stale soon"));
		useNextPromptStore.getState().recordWidget("/b.jsonl", widget("other"));
		useTabsStore.setState(state => ({ tabs: state.tabs.map(tab => ({ ...tab, status: "running" as const })) }));
		expect(useNextPromptStore.getState().suggestions).toEqual({ "/b.jsonl": "other" });
	});
});
