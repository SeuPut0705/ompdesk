import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import {
	EMPTY_PREVIEW,
	type PreviewPageRequest,
	type PreviewRequest,
	type PreviewState,
} from "../../../shared/preview";
import { I18nProvider, translate } from "../../lib/i18n";
import { PreviewFeedbackBar, previewFeedbackMessage, usePreviewFeedback } from "./PreviewFeedback";

const { document, window, Event, HTMLElement, Element, Node, CustomEvent } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
globals.document = document;
globals.window = window;
globals.Event = Event;
globals.CustomEvent = CustomEvent;
globals.HTMLElement = HTMLElement;
globals.Element = Element;
globals.Node = Node;
globals.IS_REACT_ACT_ENVIRONMENT = true;
globals.requestAnimationFrame = (callback: () => void) => setTimeout(callback, 0);

interface TestElement {
	textContent: string | null;
	remove: () => void;
	click: () => void;
	getAttribute: (name: string) => string | null;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

const VISUAL_STATE: PreviewState = {
	...EMPTY_PREVIEW,
	url: "omp-visual://v2-0123456789abcdef/index.html",
	title: "Dashboard",
	visual: {
		id: "0123456789abcdef",
		label: "Dashboard",
		version: 2,
		versions: [
			{ version: 1, createdAt: 1 },
			{ version: 2, createdAt: 2 },
		],
	},
	tabs: [{ id: "p1", title: "Dashboard", url: "omp-visual://v2-0123456789abcdef/index.html", loading: false }],
	activeTab: "p1",
};

let container: TestElement;
let root: Root | undefined;
let page: Mock<(request: PreviewPageRequest) => Promise<unknown>>;
const commands: PreviewRequest[] = [];

function Harness({ state }: { state: PreviewState }) {
	const feedback = usePreviewFeedback(state, "tab-1");
	return (
		<PreviewFeedbackBar
			state={state}
			feedback={feedback}
			command={request => commands.push(request)}
			tabId="tab-1"
			pageReady
		/>
	);
}

async function mount(state: PreviewState): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	const created = createRoot(container as unknown as globalThis.Element);
	root = created;
	await act(async () => {
		created.render(
			<I18nProvider>
				<Harness state={state} />
			</I18nProvider>,
		);
	});
}

const button = (label: string) => {
	const found = container.querySelector(`button[aria-label="${label}"]`);
	if (!found) throw new Error(`No button ${label}`);
	return found;
};

beforeEach(() => {
	page = vi.fn(async (request: PreviewPageRequest) =>
		request.action === "pick" ? { selector: "#total", tag: "div", text: "42 users" } : null,
	);
	Object.assign(window, { omp: { preview: { page } } });
	commands.length = 0;
});
afterEach(async () => {
	if (!root) return;
	const mounted = root;
	root = undefined;
	await act(async () => mounted.unmount());
	container.remove();
});

describe("preview feedback", () => {
	it("words the composer message: numbered elements and regions, then changed CSS variables", () => {
		const message = previewFeedbackMessage(
			translate,
			{ title: "Dashboard", url: "http://localhost:3000/" },
			[
				{
					n: 1,
					kind: "element",
					elements: [{ selector: "#total", tag: "div", text: "42 users" }],
					comment: " Bigger ",
				},
				{
					n: 2,
					kind: "region",
					elements: [
						{ selector: "header", tag: "header", text: "" },
						{ selector: "nav", tag: "nav", text: "" },
					],
					image: "AAAA",
					comment: "",
				},
			],
			{ "--accent": ["#00f", "#f00"], "--same": ["1px", "1px"] },
		);
		expect(message.text).toBe(
			[
				'Feedback on the page "Dashboard" (http://localhost:3000/):',
				'1. <div> `#total` "42 users" — Bigger',
				"2. Region (screenshot 1) over `header`, `nav`",
				"CSS variables I changed:",
				"- --accent: #00f → #f00",
			].join("\n"),
		);
		expect(message.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	});

	it("shows the visual's versions and turns a picked element into a pin the composer receives", async () => {
		await mount(VISUAL_STATE);
		expect(container.querySelector("[data-preview-visual]")?.textContent).toContain("Dashboard");
		const options = container.querySelectorAll('select[aria-label="Visual version"] option');
		expect(options.map(option => option.textContent)).toEqual(["Version 2 of 2", "Version 1 of 2"]);

		await act(async () => button("Comment on an element").click());
		expect(page).toHaveBeenCalledWith({ action: "pick" });
		const note = container.querySelector('[data-preview-note="1"]');
		expect(note?.textContent).toContain("<div> 42 users");
		expect(page).toHaveBeenCalledWith({ action: "pins", pins: [{ n: 1, selector: "#total" }] });

		await act(async () => button("Show 1 on the page").click());
		expect(page).toHaveBeenCalledWith({ action: "highlight", selector: "#total" });

		const filled: unknown[] = [];
		const listen = (event: globalThis.Event) => filled.push((event as globalThis.CustomEvent).detail);
		window.addEventListener("omp:fill-composer", listen);
		try {
			const send = container
				.querySelectorAll("button")
				.find(candidate => candidate.textContent === "Add to message");
			await act(async () => send?.click());
		} finally {
			window.removeEventListener("omp:fill-composer", listen);
		}
		expect(filled).toEqual([
			{
				text: 'Feedback on the page "Dashboard" (omp-visual://v2-0123456789abcdef/index.html):\n1. <div> `#total` "42 users"',
				images: [],
				prepend: true,
				tabId: "tab-1",
			},
		]);
		expect(container.querySelector("[data-preview-note]")).toBeNull();
	});

	it("stays out of the way on a plain page with nothing picked", async () => {
		await mount({ ...EMPTY_PREVIEW, url: "http://localhost:3000/", activeTab: "p1" });
		expect(container.querySelector("[data-preview-feedback]")).toBeNull();
	});
});
