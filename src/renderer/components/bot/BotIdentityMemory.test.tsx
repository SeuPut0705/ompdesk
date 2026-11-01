/**
 * The bot's identity, side chats, activity and notice routing as the owner edits them: each control sends one
 * `BOT_DESK_EDIT` with the change, and the screen shows what the desk holds. Its memory is the bot's alone: the owner
 * sees what it remembered or forgot in the activity log and corrects it in chat.
 */
import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import type { BotAvatarAnswer } from "../../../../resources/gui-bridge/bot-avatar-contracts";
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
import { useUiStore } from "../../stores/ui";
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
	avatarStatus: Mock<() => Promise<BotAvatarAnswer>>;
	generateAvatar: Mock<(prompt: string) => Promise<void>>;
}

function installApi(
	page: BotActivityPage = { entries: [], revision: 0 },
	status: BotAvatarAnswer = { available: true, model: "openai/gpt-image-1" },
): Api {
	const api: Api = {
		get: vi.fn(async () => EMPTY_BOT_DESK),
		edit: vi.fn(async () => {}),
		activity: vi.fn(async () => page),
		onChanged: vi.fn(() => () => {}),
		avatarStatus: vi.fn(async () => status),
		generateAvatar: vi.fn(async () => {}),
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: api } };
	return api;
}

let container: Element;
/** Unset for a test that mounts nothing (the labels check). */
let root: Root | undefined;

async function mount(element: ReactElement, desk: Partial<BotDeskState> = {}): Promise<void> {
	useBotDeskStore.getState().apply({ ...EMPTY_BOT_DESK, ...desk });
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	const created = createRoot(container);
	root = created;
	await act(async () => {
		created.render(<I18nProvider>{element}</I18nProvider>);
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
	if (root) {
		const mounted = root;
		await act(async () => mounted.unmount());
		container.remove();
		root = undefined;
	}
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

describe("the bot's activity", () => {
	it("names every action the log can hold, in both languages", () => {
		for (const action of BOT_ACTIVITY_ACTIONS) {
			const key = `botActivity.action.${action}`;
			expect(en[key], key).toBeTruthy();
			expect(ko[key], key).toBeTruthy();
		}
	});

	it("lists newest first what the bot did, its memory changes included, with no reads and nothing to take back", async () => {
		installApi({
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
				entry({ id: "a3", kind: "desk", action: "memory_add", text: "Deploys on Fridays only" }),
				entry({ id: "a4", kind: "desk", action: "memory_forget", text: "Deploys on Mondays" }),
			],
		});
		await mount(<BotBoardSections tabId="tbot" />, {
			memories: [{ id: "m1", text: "Deploys on Fridays only", by: "bot", at: "2026-11-01T08:00:00.000Z" }],
		});
		await act(async () => {});
		expect(queryAll("[data-bot-activity]").map(row => row.getAttribute("data-bot-activity"))).toEqual([
			"a4",
			"a3",
			"a2",
		]);
		expect(query("[data-bot-activity='a3']")?.textContent).toContain(
			`${en["botActivity.action.memory_add"]}: Deploys on Fridays only`,
		);
		// The bot keeps its memory itself: no section lists or edits it, and no row of the log offers an undo.
		expect(query('[data-board-section="memory"]')).toBeNull();
		expect(query("[data-bot-activity] button, [data-board-section='activity'] select")).toBeNull();
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
		expect(api.generateAvatar).toHaveBeenLastCalledWith("a calm blue fox");
		expect(api.edit).not.toHaveBeenCalledWith(expect.objectContaining({ op: "avatar_generate" }));
	});
});

describe("Generate on the image model", () => {
	const disabled = (element: Element | null) => props<{ disabled?: boolean }>(element).disabled === true;

	it("is off with the reason and a link to the image role while no image model can draw", async () => {
		const api = installApi(undefined, { available: false, reason: "no_model" });
		await mount(<BotIdentitySettings />);
		expect(api.avatarStatus).toHaveBeenCalledOnce();
		expect(disabled(query("[data-bot-avatar-generate]"))).toBe(true);
		expect(query("[data-bot-avatar-reason]")?.textContent).toContain(en["botAvatar.reason.no_model"]);
		const openSettings = vi.fn();
		const original = useUiStore.getState().openSettings;
		useUiStore.setState({ openSettings });
		try {
			await click(query("[data-bot-avatar-role-link]"));
		} finally {
			useUiStore.setState({ openSettings: original });
		}
		expect(openSettings).toHaveBeenCalledWith("models:roles");
	});

	it("says to open a session first, without a link to the role, when none can be asked", async () => {
		installApi(undefined, { available: false, reason: "no_session" });
		await mount(<BotIdentitySettings />);
		expect(disabled(query("[data-bot-avatar-generate]"))).toBe(true);
		expect(query("[data-bot-avatar-reason]")?.textContent).toBe(en["botAvatar.reason.no_session"]);
		expect(query("[data-bot-avatar-role-link]")).toBeNull();
	});

	it("is on when the image model can draw, shows pending on its button, and closes once drawn", async () => {
		const drawn = Promise.withResolvers<void>();
		const api = installApi();
		api.generateAvatar.mockReturnValue(drawn.promise);
		await mount(<BotIdentitySettings />);
		expect(disabled(query("[data-bot-avatar-generate]"))).toBe(false);
		expect(query("[data-bot-avatar-reason]")).toBeNull();

		await click(query("[data-bot-avatar-generate]"));
		await change(document.querySelector("[data-bot-avatar-description]"), { value: "  a calm blue fox " });
		await click(document.querySelector("[data-bot-avatar-generate-send]"));
		expect(api.generateAvatar).toHaveBeenCalledWith("a calm blue fox");
		expect(props<{ disabled?: boolean }>(document.querySelector("[data-bot-avatar-generate-send]")).disabled).toBe(
			true,
		);

		await act(async () => drawn.resolve());
		expect(document.querySelector("[role='dialog']")).toBeNull();
	});

	it("toasts a failure and keeps the dialog open for another try", async () => {
		const api = installApi();
		api.generateAvatar.mockRejectedValue(new Error("Image generation exhausted the resolved image chain"));
		await mount(<BotIdentitySettings />);
		await click(query("[data-bot-avatar-generate]"));
		await change(document.querySelector("[data-bot-avatar-description]"), { value: "a fox" });
		await click(document.querySelector("[data-bot-avatar-generate-send]"));
		expect(useToastStore.getState().toasts.map(toast => toast.title)).toContain(en["botAvatar.failed"]);
		expect(document.querySelector("[role='dialog']")).not.toBeNull();
		expect(document.querySelector("[data-bot-avatar-description]")).not.toBeNull();
		expect(props<{ disabled?: boolean }>(document.querySelector("[data-bot-avatar-generate-send]")).disabled).toBe(
			false,
		);
	});
});
