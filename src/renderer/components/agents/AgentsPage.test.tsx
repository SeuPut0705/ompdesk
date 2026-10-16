/**
 * Agents page: the store-driven tabs (⌥A / ⌥P / palette deep links land on
 * `agentsTab`), the Definitions settings writes (enable switch, prewalk
 * select), the per-row authoring menu (edit/delete only for files in the
 * agent folders) with delete, and the Pull requests empty state offering the
 * fixing action.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useGithubAuthStore } from "../../stores/github-auth";
import { useMachineSetupStore } from "../../stores/machine-setup";
import { usePrCenterStore } from "../../stores/pr-center";
import { useSessionStore } from "../../stores/session";
import { useSubagentsStore } from "../../stores/subagents";
import { useUiStore } from "../../stores/ui";
import { fakeGithubAuth, githubState } from "../../test-support/github-auth";
import { fakeSetupApi, setupState } from "../../test-support/machine-setup";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
	requestAnimationFrame: (callback: () => void) => setTimeout(callback, 0),
});
Object.assign(window, { setTimeout, clearTimeout });

// Deferred until after the globals above: react-dom computes DOM support
// flags at evaluation time.
const { createRoot } = await import("react-dom/client");
const { AgentsPage } = await import("./AgentsPage");

function ok(command: string, data: unknown) {
	return { type: "response" as const, command, success: true, data };
}

interface RpcMock {
	getSettings: Mock;
	getAgentDefinitions: Mock;
	setSetting: Mock;
	prRepo: Mock;
	openExternal: Mock;
}

function installOmp(): RpcMock {
	const mock: RpcMock = {
		getSettings: vi.fn(async () =>
			ok("get_settings", {
				values: { "task.disabledAgents": [], "task.agentModelOverrides": {}, "task.agentPrewalk": {} },
			}),
		),
		getAgentDefinitions: vi.fn(async () =>
			ok("get_agent_definitions", {
				agents: [
					{ name: "scout", description: "Fast read-only explorer", source: "bundled" },
					{ name: "reviewer", description: "Reviews diffs", source: "project" },
				],
			}),
		),
		setSetting: vi.fn(async (path: string, value: unknown) => ok("set_setting", { path, value })),
		prRepo: vi.fn(async () => ok("pr_repo", { available: false, reason: "gh_missing" })),
		openExternal: vi.fn(async () => {}),
	};
	Object.assign(window, {
		omp: {
			rpc: {
				getSettings: mock.getSettings,
				getAgentDefinitions: mock.getAgentDefinitions,
				setSetting: mock.setSetting,
				prRepo: mock.prRepo,
			},
			system: { openExternal: mock.openExternal },
		},
	});
	return mock;
}

interface TestElement {
	textContent: string | null;
	dispatchEvent: (event: object) => boolean;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, value: string) => void;
	removeAttribute: (name: string) => void;
	querySelectorAll: (selector: string) => TestElement[];
	remove: () => void;
}

let container: TestElement;
let root: Root;

async function flush(): Promise<void> {
	await act(async () => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 0);
		await promise;
	});
}

async function mount(): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<AgentsPage />
			</I18nProvider>,
		);
	});
	await flush();
}

function queryAll(selector: string): TestElement[] {
	return Array.from(document.querySelectorAll(selector)) as unknown as TestElement[];
}

function byText(selector: string, text: string): TestElement | undefined {
	return queryAll(selector).find(element => element.textContent?.trim().startsWith(text));
}

/** Dispatch inside act(); linkedom's Event has a getter-only eventPhase React writes to. */
async function fire(target: TestElement, type: string): Promise<void> {
	const event = new Event(type, { bubbles: true, cancelable: true });
	Object.defineProperty(event, "eventPhase", { value: 0, writable: true, configurable: true });
	await act(async () => {
		target.dispatchEvent(event);
	});
	await flush();
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useUiStore.setState({ destination: "session", agentsTab: "live" });
	useSessionStore.getState().reset();
	useSubagentsStore.getState().reset();
	usePrCenterStore.getState().reset();
});

describe("AgentsPage", () => {
	it("opens on the store's tab and switches tabs through openAgents", async () => {
		installOmp();
		useUiStore.getState().openAgents("live");
		await mount();
		expect(byText('[role="tab"]', "Live")?.getAttribute("aria-selected")).toBe("true");
		expect(document.body.textContent).toContain("No subagents yet");

		await fire(byText('[role="tab"]', "Definitions")!, "click");
		expect(useUiStore.getState().agentsTab).toBe("definitions");
		expect(byText('[role="tab"]', "Definitions")?.getAttribute("aria-selected")).toBe("true");
	});

	it("writes the enable switch and prewalk choice to the task.* settings", async () => {
		const omp = installOmp();
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openAgents("definitions");
		await mount();
		expect(document.body.textContent).toContain("scout");
		expect(document.body.textContent).toContain("reviewer");
		// Inspect uses the app's chevron disclosure, not the native triangle.
		const inspect = queryAll("details > summary")[0];
		expect(inspect?.getAttribute("class")).toContain("list-none");
		expect(inspect?.querySelectorAll("svg[aria-hidden]")).toHaveLength(1);

		// Rows sort by name: reviewer, scout.
		const switches = queryAll('[role="switch"]');
		expect(switches.map(element => element.getAttribute("aria-label"))).toEqual(["Use reviewer", "Use scout"]);
		await fire(switches[1]!, "click");
		expect(omp.setSetting).toHaveBeenCalledWith("task.disabledAgents", ["scout"]);
		expect(document.body.textContent).toContain("Disabled");

		// linkedom's select.value is getter-only: pick the option, then fire change.
		const prewalk = queryAll("select")[0]!;
		for (const option of prewalk.querySelectorAll("option")) {
			if (option.getAttribute("value") === "on") option.setAttribute("selected", "");
			else option.removeAttribute("selected");
		}
		await fire(prewalk, "change");
		expect(omp.setSetting).toHaveBeenCalledWith("task.agentPrewalk", { reviewer: "on" });
	});

	it("connects right in the PR center when GitHub CLI is missing: the card's sign-in installs it, no download page", async () => {
		const omp = installOmp();
		const github = fakeGithubAuth(
			githubState({
				status: { installed: false, version: null, authenticated: false, login: null, otherAccounts: [] },
			}),
		);
		const setup = fakeSetupApi(
			setupState(
				"darwin",
				{ gh: { phase: "idle", presence: { kind: "missing" }, method: "brew" } },
				{ automatic: true },
			),
		);
		Object.assign(window.omp, { githubAuth: github.api, setup: setup.api });
		try {
			useUiStore.getState().openAgents("prs");
			await mount();
			expect(omp.prRepo).toHaveBeenCalled();
			expect(document.body.textContent).toContain("GitHub CLI (gh) is not installed");
			expect(document.body.textContent).toContain(translate("prCenter.unavailableHint.gh_missing_local"));
			expect(byText("button", translate("prCenter.installGh"))).toBeUndefined();
			expect(document.querySelector('[data-testid="github-sign-in"]')).not.toBeNull();
			await fire(byText("button", translate("githubAuth.signIn"))!, "click");
			expect(github.api.startLogin).toHaveBeenCalledOnce();
			expect(omp.openExternal).not.toHaveBeenCalled();
		} finally {
			useGithubAuthStore.getState().reset();
			useMachineSetupStore.getState().reset();
		}
	});

	it("signs in to GitHub right in the PR center and checks the repo again once signed in", async () => {
		const omp = installOmp();
		omp.prRepo.mockImplementation(async () => ok("pr_repo", { available: false, reason: "gh_unauthenticated" }));
		const github = fakeGithubAuth();
		Object.assign(window.omp, { githubAuth: github.api });
		Object.assign(window.omp.rpc, { prList: vi.fn(async () => ok("pr_list", [])) });
		try {
			useUiStore.getState().openAgents("prs");
			await mount();
			expect(document.body.textContent).toContain(translate("prCenter.unavailable.gh_unauthenticated"));
			expect(document.querySelector('[data-testid="github-sign-in"]')).not.toBeNull();
			await fire(byText("button", translate("githubAuth.signIn"))!, "click");
			expect(github.api.startLogin).toHaveBeenCalledOnce();

			const probes = omp.prRepo.mock.calls.length;
			omp.prRepo.mockImplementation(async () =>
				ok("pr_repo", { available: true, repo: "octo/hello", defaultBranch: "main" }),
			);
			await act(async () =>
				github.push(
					githubState({
						status: {
							installed: true,
							version: "2.62.0",
							authenticated: true,
							login: "octocat",
							otherAccounts: [],
						},
					}),
				),
			);
			await flush();
			expect(omp.prRepo.mock.calls.length).toBeGreaterThan(probes);
		} finally {
			useGithubAuthStore.getState().reset();
		}
	});

	it("offers edit and delete only for files in the agent folders, and deletes through the main process", async () => {
		const omp = installOmp();
		omp.getAgentDefinitions.mockImplementation(async () =>
			ok("get_agent_definitions", {
				agents: [
					{ name: "mine", description: "Mine", source: "user", scope: "user", filePath: "/u/agents/mine.md" },
					{ name: "plug", description: "Plugin", source: "user", filePath: "/plugins/p/agents/plug.md" },
					{ name: "scout", description: "Explorer", source: "bundled", filePath: "embedded:scout.md" },
				],
			}),
		);
		const deleteAgentFile = vi.fn(async (filePath: string) => ok("delete_agent_file", { deleted: filePath }));
		Object.assign(window.omp.rpc, { deleteAgentFile });
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openAgents("definitions");
		await mount();

		const trigger = (name: string) =>
			queryAll("button").find(button => button.getAttribute("aria-label") === `Actions for ${name}`)!;
		const menuLabels = async (name: string) => {
			await fire(trigger(name), "click");
			return queryAll(`[role="menu"][aria-label="Actions for ${name}"] [role="menuitem"]`).map(item =>
				item.textContent?.trim(),
			);
		};
		expect(await menuLabels("scout")).toEqual(["Customize a copy"]);
		expect(await menuLabels("plug")).toEqual(["Customize a copy", "Open in editor", "Show in folder"]);
		expect(await menuLabels("mine")).toEqual(["Edit", "Duplicate", "Open in editor", "Show in folder", "Delete"]);

		await fire(queryAll("button").find(button => button.getAttribute("aria-label") === "Actions for mine")!, "click");
		await fire(queryAll('[role="menuitem"]').find(item => item.textContent?.trim() === "Delete")!, "click");
		expect(document.body.textContent).toContain("Delete mine?");
		const loadsBefore = omp.getAgentDefinitions.mock.calls.length;
		const confirm = queryAll('[role="dialog"] button').filter(button => button.textContent?.trim() === "Delete");
		await fire(confirm.at(-1)!, "click");
		expect(deleteAgentFile).toHaveBeenCalledWith("/u/agents/mine.md");
		expect(omp.getAgentDefinitions.mock.calls.length).toBeGreaterThan(loadsBefore);
	});

	it("offers a template agent the role-based model, shows the one-line diff, and writes only after Update", async () => {
		const omp = installOmp();
		const file = [
			"---",
			"# kept",
			"name: debugger",
			"description: mine",
			'model: [ "@slow", "@task" ]',
			"tools: [read]",
			"---",
			"",
			"Body",
			"",
		].join("\n");
		omp.getAgentDefinitions.mockImplementation(async () =>
			ok("get_agent_definitions", {
				agents: [
					{
						name: "debugger",
						description: "Debugs",
						source: "user",
						scope: "user",
						filePath: "/u/agents/debugger.md",
						model: ["@slow", "@task"],
					},
					{
						name: "docs-writer",
						description: "Docs",
						source: "user",
						scope: "user",
						filePath: "/u/agents/docs-writer.md",
						model: ["@docs", "@smol", "@task"],
					},
					{
						name: "mine",
						description: "Mine",
						source: "user",
						scope: "user",
						filePath: "/u/agents/mine.md",
						model: ["@task"],
					},
				],
			}),
		);
		const readAgentFile = vi.fn(async (filePath: string) =>
			ok("read_agent_file", {
				filePath,
				scope: "user",
				content: file,
				parsed: { fields: { name: "debugger", description: "mine", model: ["@slow", "@task"] }, body: "Body" },
			}),
		);
		const writeAgentFile = vi.fn(async (params: { name: string }) =>
			ok("write_agent_file", { filePath: `/u/agents/${params.name}.md` }),
		);
		Object.assign(window.omp.rpc, { readAgentFile, writeAgentFile });
		useSessionStore.getState().setStatus("ready", "/repo");
		useUiStore.getState().openAgents("definitions");
		await mount();

		// Only the stale template agent is offered; a current one and an unrelated one are not.
		const updates = queryAll("button").filter(button => button.textContent?.trim() === "Update to role-based model");
		expect(updates).toHaveLength(1);
		await fire(updates[0]!, "click");
		expect(readAgentFile).toHaveBeenCalledWith("/u/agents/debugger.md");
		expect(writeAgentFile).not.toHaveBeenCalled();

		const dialog = queryAll('[role="dialog"]')[0]!;
		expect(dialog.textContent).toContain("Update debugger's model line");
		expect(dialog.textContent).toContain('model: [ "@slow", "@task" ]');
		expect(dialog.textContent).toContain('model: [ "@debug", "@slow", "@task" ]');
		expect(dialog.textContent).not.toContain("You changed this line yourself");

		await fire(
			queryAll('[role="dialog"] button').find(button => button.textContent?.trim() === "Update model line")!,
			"click",
		);
		expect(writeAgentFile).toHaveBeenCalledWith({
			scope: "user",
			name: "debugger",
			content: file.replace('model: [ "@slow", "@task" ]', 'model: [ "@debug", "@slow", "@task" ]'),
			replacePath: "/u/agents/debugger.md",
		});
	});
});
