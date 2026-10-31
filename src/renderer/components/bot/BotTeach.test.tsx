/**
 * Showing the bot a workflow from its desk: Record starts it, the elapsed time comes from the desk's `teaching.since`,
 * Stop and Cancel end it, Stop with nothing recorded says so, a paired host's bot gets the calls, failures toast.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { type BotDeskState, EMPTY_BOT_DESK } from "../../../shared/bot-desk";
import type { BotTeachRequest, BotTeachResult } from "../../../shared/bot-teach";
import { formatElapsed } from "../../lib/format";
import { I18nProvider, translate } from "../../lib/i18n";
import { useBotDeskStore } from "../../stores/bot-desk";
import { useToastStore } from "../../stores/toast";
import { BotTeachControl } from "./BotTeach";

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

const SINCE = "2026-11-01T09:00:00.000Z";
const HOST = "host-1";

interface Api {
	get: Mock<(device?: string) => Promise<BotDeskState>>;
	teach: Mock<(payload: BotTeachRequest, device?: string) => Promise<BotTeachResult>>;
}

function installApi(overrides: Partial<Api> = {}): Api {
	const api: Api = {
		get: vi.fn(async () => EMPTY_BOT_DESK),
		teach: vi.fn(async () => ({ delivered: true })),
		...overrides,
	};
	(window as unknown as { omp: unknown }).omp = { sessions: { botDesk: { ...api, onChanged: () => () => {} } } };
	return api;
}

const desk = (teaching?: { since: string } | null): BotDeskState => ({
	...EMPTY_BOT_DESK,
	...(teaching === undefined ? {} : { teaching }),
});

let container: Element;
let root: Root;

async function mount(device?: string): Promise<void> {
	container = document.createElement("div") as unknown as Element;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root.render(
			<I18nProvider>
				<BotTeachControl device={device} />
			</I18nProvider>,
		);
	});
}

interface ClickProps {
	onClick: (event: unknown) => void;
}

/** React's props of a rendered element: the harness has no DOM events to dispatch. */
function reactProps(element: Element): ClickProps {
	const record: Record<string, unknown> = element as unknown as Record<string, unknown>;
	const key = Object.getOwnPropertyNames(record).find(name => name.startsWith("__reactProps$"));
	if (!key) throw new Error("reactProps: React props missing");
	return record[key] as ClickProps;
}

async function click(selector: string): Promise<void> {
	const element = container.querySelector(selector);
	if (!element) throw new Error(`click: ${selector} is not there`);
	await act(async () => reactProps(element).onClick({ preventDefault() {} }));
}

const query = (selector: string) => container.querySelector(selector);
const toasts = () => useToastStore.getState().toasts;

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(Date.parse(SINCE) + 125_000);
});

afterEach(async () => {
	await act(async () => {
		root.unmount();
	});
	container.remove();
	vi.useRealTimers();
	useBotDeskStore.getState().reset();
	useToastStore.setState({ toasts: [] } as never);
	delete (window as unknown as { omp?: unknown }).omp;
});

describe("BotTeachControl", () => {
	it("offers Record while nothing is recorded and starts it on this computer", async () => {
		const api = installApi();
		useBotDeskStore.getState().apply(desk(null));
		await mount();

		expect(query("[data-bot-teach-stop]")).toBeNull();
		expect(query("[data-bot-teach-record]")?.textContent).toContain(translate("botTeach.record"));
		await click("[data-bot-teach-record]");
		expect(api.teach.mock.calls).toEqual([[{ action: "start" }]]);
	});

	it("shows the time since the recording began, as the desk says it, and ends it with Stop or Cancel", async () => {
		const api = installApi();
		useBotDeskStore.getState().apply(desk({ since: SINCE }));
		await mount();

		expect(query("[data-bot-teach-record]")).toBeNull();
		expect(query("[data-bot-teach-elapsed]")?.textContent).toBe(
			translate("botTeach.recording", { time: formatElapsed(125_000) }),
		);
		await click("[data-bot-teach-cancel]");
		await click("[data-bot-teach-stop]");
		expect(api.teach.mock.calls).toEqual([[{ action: "cancel" }], [{ action: "stop" }]]);
		expect(toasts().map(toast => [toast.variant, toast.message])).toEqual([
			["success", translate("botTeach.handedOver")],
		]);
	});

	it("says so when Stop found nothing recorded", async () => {
		installApi({ teach: vi.fn(async () => ({ delivered: false })) });
		useBotDeskStore.getState().apply(desk({ since: SINCE }));
		await mount();

		await click("[data-bot-teach-stop]");
		expect(toasts().map(toast => [toast.variant, toast.message])).toEqual([["info", translate("botTeach.empty")]]);
	});

	it("follows a paired host's desk and sends its calls to that host, reading its desk again", async () => {
		const api = installApi();
		useBotDeskStore.getState().apply(desk(null));
		useBotDeskStore.getState().apply(desk({ since: SINCE }), HOST);
		await mount(HOST);

		expect(query("[data-bot-teach-elapsed]")).not.toBeNull();
		await click("[data-bot-teach-stop]");
		expect(api.teach.mock.calls).toEqual([[{ action: "stop" }, HOST]]);
		expect(api.get.mock.calls).toEqual([[HOST]]);
	});

	it("toasts a refusal, and the control stays usable", async () => {
		const api = installApi({
			teach: vi.fn(async () => {
				throw new Error("The bot is off");
			}),
		});
		useBotDeskStore.getState().apply(desk(null));
		await mount();

		await click("[data-bot-teach-record]");
		expect(toasts().map(toast => [toast.variant, toast.title])).toEqual([
			["error", translate("botTeach.startFailed")],
		]);
		const record = query("[data-bot-teach-record]") as unknown as { disabled: boolean };
		expect(record.disabled).toBe(false);
		await click("[data-bot-teach-record]");
		expect(api.teach).toHaveBeenCalledTimes(2);
	});
});
