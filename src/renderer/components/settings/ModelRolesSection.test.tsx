/**
 * ModelRolesSection contract tests for the omp 18.2.7 model-roles migration:
 * the backend owns role metadata AND the eligible candidate pool per role
 * (get_model_roles returns candidates inline). Defends the observable contract —
 * the section requests roles once on mount, filters backend-hidden roles,
 * groups visible roles by section, groups each role's candidates by model kind
 * in the picker, re-reads when the sidecar reconnects, and switching a role's
 * model issues set_model_role with the canonical provider/id selector.
 * linkedom harness per AGENTS.md; stores reset in afterEach (never mock.module).
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, translate } from "../../lib/i18n";
import { useSessionStore } from "../../stores/session";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	requestAnimationFrame: (callback: () => void) => {
		callback();
		return 0;
	},
	IS_REACT_ACT_ENVIRONMENT: true,
});

// Loaded after the linkedom globals exist: react-dom reads `window`/`document` at import time.
const { createRoot } = await import("react-dom/client");
const { ModelRolesSection } = await import("./ModelRolesSection");
const { SettingsSection } = await import("./SettingsLayout");

let root: Root;

const ROLES = [
	{
		id: "default",
		name: "Default",
		tag: "DEFAULT",
		color: "success",
		section: "chat",
		source: "settings",
		model: "anthropic/claude",
		candidates: [
			{ provider: "anthropic", id: "claude", name: "Claude", kind: "chat" },
			{ provider: "openai", id: "gpt", name: "GPT", kind: "chat" },
		],
	},
	{
		id: "image",
		name: "Image generation",
		tag: "IMAGE",
		color: "accent",
		section: "kind",
		source: "default",
		candidates: [{ provider: "openai", id: "dalle", name: "DALL·E", kind: "image" }],
	},
	{ id: "secret", name: "Hidden role", section: "chat", source: "settings", hidden: true, candidates: [] },
];

const NOT_CONNECTED = translate("modelRoles.notConnected");

async function mount(element: ReactElement): Promise<void> {
	root = createRoot(document.body as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	// Flush the async getModelRoles() promise + re-render.
	await act(async () => {});
}

function installRpc(getModelRoles?: (...args: unknown[]) => Promise<unknown>, extra: Record<string, unknown> = {}) {
	const rpc = {
		getModelRoles: vi.fn(getModelRoles ?? (async () => ({ success: true, data: { roles: ROLES } }))),
		setModelRole: vi.fn(async () => ({ success: true })),
		...extra,
	};
	(window as unknown as { omp?: unknown }).omp = { rpc, events: { onConfigUpdate: () => () => {} } };
	return rpc;
}

function bodyText(): string {
	return document.body.textContent ?? "";
}

function buttonWithLabel(label: string): HTMLButtonElement | undefined {
	return [...document.body.querySelectorAll("button")].find(button => (button.textContent ?? "").trim() === label) as
		| HTMLButtonElement
		| undefined;
}

function roleTrigger(role: string): HTMLButtonElement | undefined {
	return [...document.body.querySelectorAll("button")].find(
		button => button.getAttribute("aria-label") === `Model for ${role}`,
	) as HTMLButtonElement | undefined;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	delete (window as unknown as { omp?: unknown }).omp;
	useSessionStore.getState().reset();
	vi.restoreAllMocks();
});

describe("ModelRolesSection", () => {
	it("requests roles on mount and renders visible ones, filtering backend-hidden roles", async () => {
		const { getModelRoles } = installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);

		expect(getModelRoles).toHaveBeenCalledTimes(1);
		expect(bodyText()).toContain("Default");
		expect(bodyText()).toContain("Image generation");
		expect(bodyText()).not.toContain("Hidden role");
	});

	it("shows each role's tag as a neutral tag, whatever color the backend names", async () => {
		installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);

		const tags = [...document.body.querySelectorAll("span")].filter(span =>
			["DEFAULT", "IMAGE"].includes(span.textContent ?? ""),
		);
		expect(tags).toHaveLength(2);
		for (const tag of tags) {
			expect(tag.className).toContain("bg-(--sc-surface-3)");
			expect(tag.className).not.toMatch(/--sc-(success|accent|info|warning|danger)/);
		}
	});

	it("groups visible roles by backend section (chat vs kind) under the nested section's own title", async () => {
		installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		// Nested in Models › Model the way ModelsSection renders it.
		await mount(
			<SettingsSection title="Model">
				<ModelRolesSection />
			</SettingsSection>,
		);

		expect(document.body.querySelector("h3")?.textContent).toBe("Model");
		// The description and refresh action carry the role section's name, never float unlabeled.
		expect([...document.body.querySelectorAll("h4")].map(heading => heading.textContent)).toEqual([
			translate("settings.models.roles"),
		]);
		const headings = [...document.body.querySelectorAll("h5")].map(heading => heading.textContent);
		expect(headings).toEqual(["Chat roles", "Specialized roles"]);
	});

	it("names stock's built-in roles in Korean on a Korean UI, and keeps a custom role's own name", async () => {
		installRpc(async () => ({
			success: true,
			data: {
				roles: [
					...ROLES,
					{ id: "reviewer", name: "Reviewer", section: "chat", source: "settings", candidates: [] },
				],
			},
		}));
		useSessionStore.getState().setStatus("ready", "/repo");
		const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
		Object.defineProperty(globalThis, "navigator", { configurable: true, value: { language: "ko-KR" } });
		try {
			await mount(<ModelRolesSection />);
		} finally {
			if (original) Object.defineProperty(globalThis, "navigator", original);
		}

		// Each role's picker is named after the role.
		const pickers = [...document.body.querySelectorAll("button[aria-label]")].map(
			button => button.getAttribute("aria-label") ?? "",
		);
		expect(pickers).toEqual(expect.arrayContaining(["기본 모델", "이미지 생성 모델", "Reviewer 모델"]));
		expect(document.body.textContent).not.toContain("Image generation");
	});

	it("groups each role's candidates by model kind and preselects the saved selector by name", async () => {
		installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);

		const trigger = roleTrigger("Default");
		expect(trigger?.textContent).toContain("Claude");
		await act(async () => trigger?.click());

		const listbox = document.body.querySelector('[role="listbox"]');
		expect(listbox).not.toBeNull();
		expect(listbox?.textContent).toContain("Chat");
		expect(listbox?.textContent).toContain("Claude");
		expect(listbox?.textContent).toContain("openai/gpt");
		const selected = listbox?.querySelector('[role="option"][aria-selected="true"]');
		expect(selected?.textContent).toContain("anthropic/claude");
	});

	it("says why the list cannot refresh instead of claiming no roles are configured", async () => {
		const { getModelRoles } = installRpc();
		// No ready sidecar: the read never happens, which is a different answer
		// from an empty one.

		await mount(<ModelRolesSection />);

		expect(getModelRoles).not.toHaveBeenCalled();
		expect(bodyText()).toContain(NOT_CONNECTED);
		expect(bodyText()).not.toContain("No model roles configured.");
	});

	it("reads the roles once the sidecar connects after mount", async () => {
		const { getModelRoles } = installRpc();

		await mount(<ModelRolesSection />);
		expect(getModelRoles).not.toHaveBeenCalled();

		await act(async () => {
			useSessionStore.getState().setStatus("ready", "/repo");
		});
		await act(async () => {});

		expect(getModelRoles).toHaveBeenCalledTimes(1);
		expect(bodyText()).toContain("Default");
		expect(bodyText()).not.toContain(NOT_CONNECTED);
	});

	it("shows the load failure with a retry instead of an empty role list", async () => {
		const { getModelRoles } = installRpc(async () => ({ success: false, error: "rpc socket closed" }));
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);

		expect(bodyText()).toContain(translate("modelRoles.loadFailed"));
		expect(bodyText()).toContain("rpc socket closed");
		expect(bodyText()).not.toContain("No model roles configured.");

		const retry = buttonWithLabel("Retry");
		expect(retry).toBeDefined();
		await act(async () => {
			retry?.click();
		});
		expect(getModelRoles).toHaveBeenCalledTimes(2);
	});

	it("keeps the last good roles on screen under a failed re-read after reconnect", async () => {
		installRpc()
			.getModelRoles.mockResolvedValueOnce({ success: true, data: { roles: ROLES } })
			.mockResolvedValue({ success: false, error: "timeout" });
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);
		expect(bodyText()).toContain("Default");

		// A reconnect re-reads; the second read fails and must degrade to a banner
		// over the rows the user is already looking at.
		await act(async () => {
			useSessionStore.getState().setStatus("exited", "/repo");
		});
		await act(async () => {
			useSessionStore.getState().setStatus("ready", "/repo");
		});
		await act(async () => {});

		expect(bodyText()).toContain("Default");
		expect(bodyText()).toContain("Showing the last roles that loaded successfully.");
		expect(bodyText()).toContain("timeout");
	});

	it("locks role changes when the sidecar disconnects after a successful load", async () => {
		const { getModelRoles, setModelRole } = installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);
		await act(async () => {
			useSessionStore.getState().setStatus("exited", "/repo");
		});

		const trigger = roleTrigger("Default");
		expect(trigger?.disabled).toBe(true);
		expect(trigger?.getAttribute("title")).toBe(NOT_CONNECTED);
		expect(getModelRoles).toHaveBeenCalledTimes(1);
		await act(async () => trigger?.click());
		expect(setModelRole).not.toHaveBeenCalled();
	});

	it("issues set_model_role with the canonical selector when a role's model is switched", async () => {
		const { setModelRole } = installRpc();
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);

		await act(async () => roleTrigger("Default")?.click());
		const option = [...document.body.querySelectorAll('[role="option"]')].find(button =>
			(button.textContent ?? "").includes("openai/gpt"),
		);
		expect(option).toBeDefined();
		await act(async () => option?.dispatchEvent(new Event("click", { bubbles: true })));

		expect(setModelRole).toHaveBeenCalledWith("default", "openai/gpt");
	});

	it("shows where each role's model compacts, from the bridge's resolver", async () => {
		const getCompactionPoints = vi.fn(async () => ({
			success: true,
			data: {
				models: [],
				roles: [
					{
						role: "default",
						selector: "anthropic/claude",
						autoSelected: false,
						point: { tokens: 90_000, source: "anthropic/claude", draft: "90k" },
					},
					{
						role: "image",
						selector: "openai/dalle",
						autoSelected: true,
						point: { tokens: 160_000, percent: 80, source: "global" },
					},
				],
			},
		}));
		installRpc(undefined, {
			getSettings: vi.fn(async () => ({ success: true, data: { values: { "compaction.modelThresholds": {} } } })),
			getCompactionPoints,
		});
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);
		await act(async () => {});

		const facts = [...document.body.querySelectorAll("[data-compacts-at]")].map(node => node.textContent);
		expect(facts).toEqual(["Compacts at 90.0k · anthropic/claude", "Compacts at 160.0k · 80% · global setting"]);
	});

	it("shows no compaction point on an omp whose settings lack compaction.modelThresholds", async () => {
		const getCompactionPoints = vi.fn();
		installRpc(undefined, {
			// omp 18.8.0: the setting is not in the live registry, so get_settings omits it.
			getSettings: vi.fn(async () => ({ success: true, data: { values: {} } })),
			getCompactionPoints,
		});
		useSessionStore.getState().setStatus("ready", "/repo");

		await mount(<ModelRolesSection />);
		await act(async () => {});

		expect(getCompactionPoints).not.toHaveBeenCalled();
		expect(document.body.querySelector("[data-compacts-at]")).toBeNull();
		expect(bodyText()).toContain("Default");
	});
});
