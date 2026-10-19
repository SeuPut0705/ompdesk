import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryOverview } from "./MemoryOverview";
import {
	API,
	APP,
	button,
	cleanup,
	click,
	fakeMemoryApi,
	installApi,
	memoryState,
	mount,
	PROJECT,
	q,
	qa,
	text,
} from "./memory-test-harness";

let api = fakeMemoryApi();

beforeEach(() => {
	api = fakeMemoryApi();
	installApi(api);
});
afterEach(cleanup);

describe("Memory › Overview", () => {
	it("shows status, scope, the project's counts, last capture, size and data folder when running", async () => {
		await mount(<MemoryOverview project={PROJECT} projects={[APP, API]} state={memoryState()} />);
		expect(api.overview).toHaveBeenCalledWith(PROJECT);
		expect(text("[data-memory-status]")).toContain("Running");
		expect(text("[data-memory-status]")).toContain("v3.1.1");
		expect(text("[data-memory-scope]")).toContain("work / app");
		expect(text("[data-memory-scope]")).toContain("2 projects");
		expect(text("[data-memory-counts]")).toBe("3 pages · 2 sessions · 7 observations");
		expect(text("[data-memory-disk]")).toBe("2.0 KB");
		expect(text("[data-memory-dir]")).toBe("/data");
		expect(text("[data-memory-privacy]")).toContain("Local only");
	});

	it("every row is one line: no inline description, the explanations are tooltips", async () => {
		await mount(
			<MemoryOverview
				project={PROJECT}
				projects={[APP, API]}
				state={memoryState({ wiring: { app: true, terminal: true } })}
			/>,
		);
		expect(qa("[data-setting-desc]")).toHaveLength(0);
		expect(qa("[data-setting-info]").length).toBeGreaterThanOrEqual(6);
		expect(text("[data-memory-terminal]")).toBe("Connected");
	});

	it("never says ai-memory in what it shows", async () => {
		await mount(
			<MemoryOverview
				project={PROJECT}
				projects={[APP]}
				state={memoryState({ wiring: { app: true, terminal: true } })}
			/>,
		);
		expect((document.body.textContent ?? "").toLowerCase().replace(".ai-memory.toml", "")).not.toContain("ai-memory");
	});

	it("the web console button is labelled and opens the console", async () => {
		await mount(<MemoryOverview project={PROJECT} projects={[APP]} state={memoryState()} />);
		await click(button("Open web console"));
		expect(api.openWeb).toHaveBeenCalledOnce();
		await click(button("Copy password"));
		expect(api.copyWebPassword).toHaveBeenCalledOnce();
	});

	it("the switch calls setEnabled", async () => {
		await mount(<MemoryOverview project={PROJECT} projects={[APP]} state={memoryState()} />);
		const toggle = q("[role=switch]");
		await click(toggle);
		expect(api.setEnabled).toHaveBeenCalledWith(false);
	});

	it("off shows only the switch, status and privacy", async () => {
		await mount(
			<MemoryOverview
				project={null}
				projects={[]}
				state={memoryState({ enabled: false, phase: "off", stats: null })}
			/>,
		);
		expect(text("[data-memory-status]")).toContain("Off");
		expect(q("[data-memory-scope]")).toBeNull();
		expect(q("[data-memory-counts]")).toBeNull();
		expect(q("[data-memory-privacy]")).not.toBeNull();
		expect(api.overview).not.toHaveBeenCalled();
	});

	it("a failed start shows the cause and Try again", async () => {
		await mount(
			<MemoryOverview
				project={null}
				projects={[]}
				state={memoryState({ phase: "failed", detail: "port taken", stats: null })}
			/>,
		);
		expect(document.body.textContent).toContain("port taken");
		await click(button("Try again"));
		expect(api.retry).toHaveBeenCalledOnce();
	});

	it("the terminal row connects and removes", async () => {
		await mount(<MemoryOverview project={PROJECT} projects={[APP]} state={memoryState()} />);
		await click(button("Also use in the terminal omp"));
		expect(api.setTerminal).toHaveBeenCalledWith(true);
	});
});
