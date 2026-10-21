import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { useAiMemoryStore } from "../../../stores/ai-memory";
import { useMemoryPageStore } from "../../../stores/memory-page";
import { SettingsNavigationProvider } from "../settings-navigation";
import { MemorySection, resolveProject } from "./MemorySection";
import {
	API,
	APP,
	button,
	cleanup,
	click,
	fakeMemoryApi,
	handoff,
	installApi,
	memoryState,
	mount,
	PROJECT,
	q,
	qa,
	settle,
	text,
} from "./memory-test-harness";

let api = fakeMemoryApi();
let navigated: string[] = [];

async function show(sub: string | undefined, state = memoryState()) {
	api.getState.mockResolvedValue(state);
	useAiMemoryStore.setState({ state });
	await mount(
		<SettingsNavigationProvider value={target => navigated.push(target)}>
			<MemorySection sub={sub} />
		</SettingsNavigationProvider>,
	);
}

beforeEach(() => {
	navigated = [];
	api = fakeMemoryApi();
	api.handoffs.mockResolvedValue([handoff("h1", "open")]);
	installApi(api);
});
afterEach(cleanup);

describe("resolveProject", () => {
	it("prefers the pick, then the project named after the folder, then the newest", () => {
		const projects = [APP, API, { workspace: "default", project: "owner-ompdesk", pages: 1, lastUpdated: null }];
		expect(resolveProject(projects, API, "/x/ompdesk")).toBe(API);
		expect(resolveProject(projects, null, "/Users/me/ompdesk")).toEqual({
			workspace: "default",
			project: "owner-ompdesk",
		});
		expect(resolveProject(projects, null, "/Users/me/other")).toEqual(PROJECT);
		expect(resolveProject(projects, { workspace: "gone", project: "x" }, "")).toEqual(PROJECT);
		expect(resolveProject([], null, "/x")).toBeNull();
	});
});

describe("Memory page", () => {
	it("has seven tabs and the open-handoff count", async () => {
		await show(undefined);
		const tabs = qa("[role=tab]").map(tab => tab.textContent?.replace(/\d+$/, "").trim());
		expect(tabs).toEqual(["Overview", "Search", "Pages", "Handoffs", "Sessions", "Profile", "Maintenance"]);
		expect(text("[data-memory-tab]")).toContain("Remember across sessions");
	});

	it("a tab is the settings sub-target", async () => {
		await show("handoffs");
		expect(q('[data-memory-tab="handoffs"]')).not.toBeNull();
		expect(api.handoffs).toHaveBeenCalledWith(PROJECT);
		await click(button("Pages"));
		expect(navigated).toContain("memory:pages");
	});

	it("a section's request to open a page moves to Pages", async () => {
		await show("search");
		await act(async () => useMemoryPageStore.getState().openPage({ ...PROJECT, path: "notes/a.md" }));
		await settle();
		expect(navigated).toContain("memory:pages");
	});

	it("off shows the overview only, with no tabs", async () => {
		await show("pages", memoryState({ enabled: false, phase: "off", stats: null }));
		expect(qa("[role=tab]")).toHaveLength(0);
		expect(q("[data-memory-status]")).not.toBeNull();
		expect(api.projects).not.toHaveBeenCalled();
	});

	it("the project selector changes what the tabs read", async () => {
		await show("pages");
		expect(api.pages).toHaveBeenLastCalledWith(PROJECT);
		const select = q("[data-memory-project]");
		await act(async () => {
			const key = Object.getOwnPropertyNames(select).find(name => name.startsWith("__reactProps$")) as string;
			const props = (select as unknown as Record<string, { onChange: (event: unknown) => void }>)[key];
			props?.onChange({ target: { value: "work/api" } });
		});
		await settle();
		expect(api.pages).toHaveBeenLastCalledWith({ workspace: "work", project: "api" });
	});
});
