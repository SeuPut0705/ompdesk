/**
 * The bot's identity, memory, side chats, activity and notice routing as the owner edits them: each control sends one
 * `BOT_DESK_EDIT` with the change, and the screen shows what the desk holds.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { BOT_ACTIVITY_ACTIONS, type BotActivity, type BotActivityPage } from "../../../shared/bot-activity";
import { type BotDeskState, EMPTY_BOT_DESK } from "../../../shared/bot-desk";
import type { BotDeskEdit } from "../../../shared/bot-desk-edit";
import { I18nProvider } from "../../lib/i18n";
import { en } from "../../locales/en";
import { ko } from "../../locales/ko";
import { useBotActivityStore } from "../../stores/bot-activity";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useSessionStore } from "../../stores/session";
import { useToastStore } from "../../stores/toast";
import { BotIdentitySettings } from "../settings/BotIdentitySettings";
import { BotBar, BotBoardSections } from "./BotDesk";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface Api {
	get: Mock<(device?: string) => Promise<BotDeskState>>;
	edit: Mock<(payload: BotDeskEdit, device?: string) => Promise<void>>;
	activity: Mock<(device?: string) => Promise<BotActivityPage>>;
	onChanged: Mock<() => () => void>;
}

function installApi(page: BotActivityPage = { entries: [], revision: 0 }): Api {
	const api: Api = {
		get: vi.fn(async () => EMPTY_BOT_DESK),
		edit: vi.fn(async () => {}),
		activity: vi.fn(async () => page),
		onChanged: vi.fn(() => () => {}),
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: api } };
	return api;
}

let container: Element;
let root: Root;

async function mount(element: ReactElement, desk: Partial<BotDeskState> = {}): Promise<void> {
	useBotDeskStore.getState().apply({ ...EMPTY_BOT_DESK, ...desk });
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

function props<T>(element: Element | null): T {
	if (!element) throw new Error("props: element is null");
	const record = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("props: React props missing");
	return record[key] as T;
}

const query = (selector: string) => container.querySelector(selector);
const queryAll = (selector: string) => [...container.querySelectorAll(selector)];
const click = (element: Element | null) =>
	act(async () => props<{ onClick: (event: unknown) => void }>(element).onClick({ preventDefault() {} }));
const change = (element: Element | null, value: unknown) =>
	act(async () => props<{ onChange: (event: unknown) => void }>(element).onChange({ target: value }));
const enter = (element: Element | null) =>
	act(async () =>
		props<{ onKeyDown: (event: unknown) => void }>(element).onKeyDown({ key: "Enter", preventDefault() {} }),
	);

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	useBotDeskStore.getState().reset();
	useBotActivityStore.getState().reset();
	useSessionStore.getState().reset();
	useToastStore.setState({ toasts: [] } as never);
	delete (window as unknown as { omp?: unknown }).omp;
});

const entry = (over: Partial<BotActivity> & Pick<BotActivity, "id" | "kind" | "action" | "text">): BotActivity => ({
	at: "2026-11-01T09:00:00.000Z",
	by: "bot",
	...over,
});

describe("the bot's memory", () => {
	it("lists what it keeps with who wrote it, and adds, edits and imports through main", async () => {
		const api = installApi();
		await mount(<BotBoardSections tabId="tbot" />, {
			memories: [
				{ id: "m1", text: "Deploys on Fridays only", by: "bot", at: "2026-11-01T08:00:00.000Z" },
				{ id: "m2", text: "Prefers Korean replies", by: "owner", at: "2026-11-01T08:01:00.000Z" },
			],
		});
		expect(
			queryAll("[data-bot-memory]").map(row => [row.textContent, row.getAttribute("data-bot-memory-by")]),
		).toEqual([
			["Deploys on Fridays only", "bot"],
			["Prefers Korean replies", "owner"],
		]);

		await change(query("[data-bot-memory-input]"), { value: "Lives in Seoul" });
		await enter(query("[data-bot-memory-input]"));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "memory_add", text: "Lives in Seoul" });

		const file = { name: "Memory.md", text: async () => "# Mine\n\n- Ships on Fridays\n- Lives in Seoul\n" };
		await change(query("[data-bot-memory-file]"), { files: [file], value: "Memory.md" });
		expect(document.body.textContent).toContain("Memory.md");
		await click(document.querySelector("[data-bot-memory-import-replace]"));
		expect(api.edit).toHaveBeenLastCalledWith({
			op: "memory_import",
			texts: ["Ships on Fridays", "Lives in Seoul"],
			replace: true,
		});
	});
});

describe("the bot's activity", () => {
	it("names every action the log can hold, in both languages", () => {
		for (const action of BOT_ACTIVITY_ACTIONS) {
			const key = `botActivity.action.${action}`;
			expect(en[key], key).toBeTruthy();
			expect(ko[key], key).toBeTruthy();
		}
	});

	it("lists newest first, filters to what it read, and undoes a change once", async () => {
		const api = installApi({
			revision: 3,
			entries: [
				entry({
					id: "a1",
					kind: "read",
					action: "tool",
					text: "read src/main/index.ts",
					target: { type: "file", value: "src/main/index.ts" },
				}),
				entry({ id: "a2", kind: "run", action: "tool", text: "bash git log -3" }),
				entry({
					id: "a3",
					kind: "desk",
					action: "memory_forget",
					by: "owner",
					text: "Deploys on Fridays only",
					undo: {
						op: "memory_restore",
						memory: { id: "m1", text: "Deploys on Fridays only", by: "bot", at: "2026-11-01T08:00:00.000Z" },
					},
				}),
			],
		});
		await mount(<BotBoardSections tabId="tbot" />);
		await act(async () => {});
		expect(queryAll("[data-bot-activity]").map(row => row.getAttribute("data-bot-activity"))).toEqual([
			"a3",
			"a2",
			"a1",
		]);

		await click(query("[data-bot-activity-undo='a3']"));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "undo", activity: "a3" });

		const reads = queryAll("[data-bot-activity-filter]").find(
			button => button.getAttribute("data-bot-activity-filter") === "reads",
		);
		await click(reads ?? null);
		expect(queryAll("[data-bot-activity]").map(row => row.getAttribute("data-bot-activity"))).toEqual(["a1"]);
	});
});

describe("the bot's side chats", () => {
	it("starts one by its topic and lists the ones the desk holds", async () => {
		const api = installApi();
		await mount(<BotBoardSections tabId="tbot" />, {
			channels: [{ id: "c1", title: "Release notes", sessionPath: "/s/c1.jsonl", at: "2026-11-01T08:00:00.000Z" }],
		});
		expect(query("[data-bot-channel-open='c1']")?.textContent).toBe("Release notes");
		await change(query("[data-bot-channel-input]"), { value: "Hiring" });
		await enter(query("[data-bot-channel-input]"));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "channel_add", title: "Hiring" });
	});
});

describe("the bot's identity and notices", () => {
	it("shows the avatar and tagline on its bar", async () => {
		installApi();
		await mount(<BotBar tabId="tbot" />, {
			identity: { tagline: "Night shift", persona: "", avatar: { kind: "mark", shape: "cat", color: "info" } },
		});
		expect(query("[data-bot-avatar]")?.getAttribute("data-bot-avatar")).toBe("cat");
		expect(query("[data-bot-tagline]")?.textContent).toBe("Night shift");
	});

	it("writes the avatar, tagline, routing and spoken replies the owner picks", async () => {
		const api = installApi();
		await mount(<BotIdentitySettings />);

		await click(query("[data-bot-avatar-shape='rocket']"));
		expect(api.edit).toHaveBeenLastCalledWith({
			op: "identity",
			avatar: { kind: "mark", shape: "rocket", color: "accent" },
		});
		await click(query("[data-bot-avatar-color='success']"));
		expect(api.edit).toHaveBeenLastCalledWith({
			op: "identity",
			avatar: { kind: "mark", shape: "bot", color: "success" },
		});

		const tagline = query("[data-bot-tagline-field]");
		await change(tagline, { value: "Keeps CI green" });
		await act(async () =>
			props<{ onBlur: (event: unknown) => void }>(tagline).onBlur({ currentTarget: { value: "Keeps CI green" } }),
		);
		expect(api.edit).toHaveBeenLastCalledWith({ op: "identity", tagline: "Keeps CI green" });

		await change(query("[data-bot-notify='done']"), { value: "quiet" });
		expect(api.edit).toHaveBeenLastCalledWith({ op: "notify", done: "quiet" });
		await change(query("[data-bot-notify-every]"), { value: "hourly" });
		expect(api.edit).toHaveBeenLastCalledWith({ op: "notify", progressEvery: "hourly" });

		await click(query("[data-bot-avatar-generate]"));
		await change(document.querySelector("[data-bot-avatar-description]"), { value: "a calm blue fox" });
		await click(document.querySelector("[data-bot-avatar-generate-send]"));
		expect(api.edit).toHaveBeenLastCalledWith({ op: "avatar_generate", description: "a calm blue fox" });
	});
});
