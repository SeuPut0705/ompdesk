import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcSkillDetail, RpcSkillInfo } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetTabRoute } from "../../lib/tab-routing";
import { useSessionStore } from "../../stores/session";
import { useTabsStore } from "../../stores/tabs";
import { filterSkills, SkillsSettingsPage } from "./SkillsSettingsPage";

const { document, window, Event, HTMLElement, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	textContent: string | null;
	remove(): void;
	dispatchEvent(event: object): boolean;
}

let root: Root | null = null;
let container: TestElement | null = null;

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

afterEach(async () => {
	if (root) await act(async () => root?.unmount());
	container?.remove();
	root = null;
	container = null;
	useSessionStore.getState().reset();
	useTabsStore.getState().reset();
	resetTabRoute();
	vi.restoreAllMocks();
});

function skill(partial: Partial<RpcSkillInfo> & { name: string }): RpcSkillInfo {
	return {
		description: "",
		source: "native:user",
		enabled: true,
		location: "/tmp/SKILL.md",
		provider: "native",
		providerName: "OMP",
		level: "user",
		managed: false,
		hidden: false,
		...partial,
	};
}

describe("Skills settings filtering", () => {
	const skills = [
		skill({ name: "release-review", description: "Review releases", level: "project" }),
		skill({
			name: "managed-notes",
			description: "Capture notes",
			provider: "omp-managed",
			providerName: "Managed Skills",
			managed: true,
		}),
		skill({ name: "disabled-research", description: "Search the web", enabled: false, provider: "codex" }),
	];

	it("combines global search with the selected status/source filter", () => {
		expect(filterSkills(skills, "review", "project").map(item => item.name)).toEqual(["release-review"]);
		expect(filterSkills(skills, "notes", "managed").map(item => item.name)).toEqual(["managed-notes"]);
		expect(filterSkills(skills, "web", "enabled")).toEqual([]);
	});

	it("distinguishes disabled, managed, project, and user views", () => {
		expect(filterSkills(skills, "", "disabled").map(item => item.name)).toEqual(["disabled-research"]);
		expect(filterSkills(skills, "", "managed").map(item => item.name)).toEqual(["managed-notes"]);
		expect(filterSkills(skills, "", "project").map(item => item.name)).toEqual(["release-review"]);
		expect(filterSkills(skills, "", "user").map(item => item.name)).toEqual(["managed-notes", "disabled-research"]);
	});
});

describe("Skills settings management", () => {
	it("keeps the managed-skill editor open when the New action clears the current selection", async () => {
		const listed = skill({ name: "existing-skill", description: "Existing skill" });
		const detail: RpcSkillDetail = { ...listed, body: "# Existing" };
		const getSkills = vi.fn(async () => ({ success: true as const, data: { skills: [listed] } }));
		const getSkillDetail = vi.fn(async () => ({ success: true as const, data: detail }));
		const ompWindow = window as unknown as {
			omp: { rpc: { getSkills: typeof getSkills; getSkillDetail: typeof getSkillDetail } };
		};
		ompWindow.omp = { rpc: { getSkills, getSkillDetail } };
		useSessionStore.setState({ status: "ready", cwd: "/repo" });
		useTabsStore.setState({
			activeTabId: "tab-1",
			tabs: [{ id: "tab-1", cwd: "/repo", status: "ready", kind: "agent", unreadDone: false }],
			bundles: new Map(),
		});
		resetTabRoute();

		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element);
		await act(async () => {
			root?.render(createElement(I18nProvider, null, createElement(SkillsSettingsPage, { query: "" })));
		});
		await flush();

		const buttons = Array.from(document.querySelectorAll("button")) as unknown as TestElement[];
		const createButton = buttons.find(button => button.textContent?.includes("New managed skill"));
		if (!createButton) throw new Error("missing New managed skill button");
		await act(async () => {
			createButton.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
		});
		await flush();

		expect(document.body.textContent).toContain("Create managed skill");
		expect(document.querySelector("textarea")).not.toBeNull();
	});
});
