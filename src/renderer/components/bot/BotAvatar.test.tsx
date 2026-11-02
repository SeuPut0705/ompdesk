import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { BOT_AVATAR_SHAPES, type BotAvatar as BotAvatarValue } from "../../../shared/bot-desk";
import type { RemoteLinkState } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { publishCallLevel, useBotCallStore } from "../../stores/bot-call";
import { useRemoteStore } from "../../stores/remote";
import { BotAvatar } from "./BotAvatar";
import { type BotMotion, useBotMotion } from "./bot-motion";
import type { BotState } from "./bot-status";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");

const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;

interface TestElement {
	className: string;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
	style: { getPropertyValue: (name: string) => string };
	remove: () => void;
}

const MOTIONS: BotMotion[] = ["idle", "working", "waiting", "asleep", "speaking", "reconnecting"];
const MARK: BotAvatarValue = { kind: "mark", shape: "bot", color: "accent" };
const IMAGE: BotAvatarValue = {
	kind: "image",
	dataUrl: "data:image/png;base64,iVBORw0KGgo=",
};

let container: TestElement;
let root: Root;

/** Mounts `element`; the avatar it drew, when it drew one. */
async function mount(element: ReactElement): Promise<TestElement> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
	return container.querySelector("[data-bot-avatar]") as TestElement;
}

async function rerender(element: ReactElement): Promise<void> {
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	useBotCallStore.setState({ tabId: null, speaking: false });
	useRemoteStore.setState({ state: null });
});

describe("BotAvatar motion", () => {
	it("names its motion on the root, and none while still", async () => {
		const still = await mount(<BotAvatar avatar={MARK} size="md" />);
		expect(still.getAttribute("data-bot-motion")).toBeNull();
		for (const motion of MOTIONS) {
			await rerender(<BotAvatar avatar={MARK} motion={motion} size="md" />);
			expect(container.querySelector("[data-bot-avatar]")?.getAttribute("data-bot-motion")).toBe(motion);
		}
	});

	it("draws a face on every mark: eyes, and a mouth where the shape has one", async () => {
		await mount(<BotAvatar avatar={MARK} motion="idle" size="lg" />);
		for (const shape of BOT_AVATAR_SHAPES) {
			await rerender(<BotAvatar avatar={{ kind: "mark", shape, color: "info" }} motion="idle" size="lg" />);
			const avatar = container.querySelector("[data-bot-avatar]");
			expect(avatar?.getAttribute("data-bot-avatar")).toBe(shape);
			const eyes = container.querySelectorAll("[data-bot-eye]").length;
			expect(eyes, shape).toBeGreaterThanOrEqual(1);
			expect(eyes, shape).toBeLessThanOrEqual(2);
			expect(container.querySelector("svg"), shape).not.toBeNull();
		}
		await rerender(<BotAvatar avatar={MARK} motion="idle" size="lg" />);
		expect(container.querySelectorAll("[data-bot-eye]")).toHaveLength(2);
		expect(container.querySelector("[data-bot-mouth]")).not.toBeNull();
	});

	it("closes the eyes while asleep, and only then", async () => {
		await mount(<BotAvatar avatar={MARK} motion="asleep" size="md" />);
		const kinds = () =>
			[...container.querySelectorAll("[data-bot-eye]")].map(eye => eye.getAttribute("data-bot-eye"));
		expect(kinds()).toEqual(["closed", "closed"]);
		for (const motion of MOTIONS.filter(candidate => candidate !== "asleep")) {
			await rerender(<BotAvatar avatar={MARK} motion={motion} size="md" />);
			expect(kinds(), motion).toEqual(["open", "open"]);
		}
		await rerender(<BotAvatar avatar={MARK} size="md" />);
		expect(kinds()).toEqual(["open", "open"]);
	});

	it("gives an image its ring, outside the picture, and keeps the picture", async () => {
		const avatar = await mount(<BotAvatar avatar={IMAGE} motion="working" size="md" />);
		expect(avatar.getAttribute("data-bot-avatar")).toBe("image");
		const ring = container.querySelector("[data-bot-ring]");
		expect(ring).not.toBeNull();
		expect(ring?.getAttribute("aria-hidden")).toBe("true");
		expect(container.querySelector("img")?.getAttribute("src")).toBe(IMAGE.kind === "image" ? IMAGE.dataUrl : "");
		// The ring is a sibling of the clipped picture, so the picture's overflow never cuts it.
		expect(ring?.querySelector("img")).toBeNull();
	});

	it("keeps the root's class identical across every motion, for every size and kind", async () => {
		for (const size of ["inline", "md", "lg"] as const) {
			for (const avatar of [MARK, IMAGE]) {
				const still = await mount(<BotAvatar avatar={avatar} size={size} />);
				const stillClass = still.className;
				for (const motion of MOTIONS) {
					await rerender(<BotAvatar avatar={avatar} motion={motion} size={size} />);
					const moving = container.querySelector("[data-bot-avatar]");
					expect(moving?.className, `${avatar.kind} ${size} ${motion}`).toBe(stillClass);
				}
				await act(async () => {
					root.unmount();
				});
				container.remove();
			}
		}
		await mount(<BotAvatar avatar={MARK} size="md" />);
	});

	it("follows the call's playback level while speaking, and lets go of it after", async () => {
		const avatar = await mount(<BotAvatar avatar={MARK} motion="speaking" size="md" />);
		await act(async () => {
			publishCallLevel(0.6);
		});
		expect(avatar.style.getPropertyValue("--bot-voice")).toBe("0.6");
		await act(async () => {
			publishCallLevel(0.25);
		});
		expect(avatar.style.getPropertyValue("--bot-voice")).toBe("0.25");
		await rerender(<BotAvatar avatar={MARK} motion="idle" size="md" />);
		await act(async () => {
			publishCallLevel(0.9);
		});
		expect(container.querySelector("[data-bot-avatar]")?.style.getPropertyValue("--bot-voice")).toBe("");
	});

	it("rests its loops while the window is hidden", async () => {
		const avatar = await mount(<BotAvatar avatar={MARK} motion="working" size="md" />);
		expect(avatar.getAttribute("data-paused")).toBeNull();
		Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
		await act(async () => {
			document.dispatchEvent(new Event("visibilitychange"));
		});
		expect(container.querySelector("[data-bot-avatar]")?.getAttribute("data-paused")).toBe("");
		Reflect.deleteProperty(document, "visibilityState");
	});

	it("still carries label and data attributes", async () => {
		const avatar = await mount(<BotAvatar avatar={MARK} data-sidebar-bot label="Bot" motion="idle" size="inline" />);
		expect(avatar.getAttribute("role")).toBe("img");
		expect(avatar.getAttribute("aria-label")).toBe("Bot");
		expect(avatar.getAttribute("data-sidebar-bot")).toBe("true");
	});
});

function Probe({ state, device, tabId }: { state: BotState; device?: string; tabId?: string }) {
	return <span data-probe={useBotMotion({ state, device, tabId })} />;
}

describe("useBotMotion", () => {
	const probe = () => container.querySelector("[data-probe]")?.getAttribute("data-probe");
	const hosts = (state: RemoteLinkState) =>
		useRemoteStore.setState({ state: { hosts: [{ deviceId: "mac", name: "Mac", state }] } as never });

	it("reads the state, the paired host's link and the call's speech", async () => {
		await mount(<Probe state="working" tabId="t1" />);
		expect(probe()).toBe("working");

		await act(async () => {
			useBotCallStore.getState().start("t1");
			useBotCallStore.getState().setSpeaking("t1", true);
		});
		expect(probe()).toBe("speaking");

		await rerender(<Probe state="working" tabId="other" />);
		expect(probe()).toBe("working");

		await act(async () => {
			hosts("online");
		});
		await rerender(<Probe device="mac" state="waiting" tabId="other" />);
		expect(probe()).toBe("waiting");
		await act(async () => {
			hosts("connecting");
		});
		expect(probe()).toBe("reconnecting");
		await rerender(<Probe device="gone" state="waiting" tabId="t1" />);
		expect(probe()).toBe("speaking");
	});
});
