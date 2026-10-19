import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentMessage } from "../../../shared/rpc-types";
import { I18nProvider } from "../../lib/i18n";
import { resetMailOpenForTest } from "../../lib/mail-open";
import { MailNote } from "./CustomMessageCard";

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
	textContent: string | null;
	getAttribute: (name: string) => string | null;
	click: () => void;
	remove: () => void;
	querySelector: (selector: string) => TestElement | null;
}

const done: AgentMessage = {
	role: "custom",
	customType: "ompdesk.mail",
	content: "<ompdesk-mail …>",
	display: true,
	details: {
		id: "mail-1",
		kind: "done",
		from: "abc",
		fromTitle: "Part A",
		text: "A finished",
		files: ["src/a.ts"],
		checks: [{ command: "bun test", passed: false }],
	},
	timestamp: 1,
};

let container: TestElement;
let root: Root;

async function mount(message: AgentMessage): Promise<void> {
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<MailNote message={message} />
			</I18nProvider>,
		);
	});
}

async function unmount(): Promise<void> {
	await act(async () => root.unmount());
	container.remove();
}

const toggle = () => container.querySelector("button[aria-expanded]");

beforeEach(() => {
	resetMailOpenForTest();
	window.sessionStorage?.clear?.();
});

afterEach(async () => {
	await unmount();
});

describe("session report disclosure", () => {
	it("opens the body (text, files, checks) on a press and closes it again", async () => {
		await mount(done);
		expect(container.querySelector("[data-agent-mail-body]")).toBeNull();

		await act(async () => toggle()?.click());
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		const body = container.querySelector("[data-agent-mail-body]");
		expect(body?.textContent).toContain("A finished");
		expect(body?.textContent).toContain("src/a.ts");
		expect(body?.textContent).toContain("bun test");
		expect(body?.textContent).toContain("failed");

		await act(async () => toggle()?.click());
		expect(container.querySelector("[data-agent-mail-body]")).toBeNull();
	});

	it("keeps the person's choice when the same report mounts again", async () => {
		await mount(done);
		await act(async () => toggle()?.click());
		await unmount();

		await mount(done);
		expect(toggle()?.getAttribute("aria-expanded")).toBe("true");
		expect(container.querySelector("[data-agent-mail-body]")?.textContent).toContain("A finished");
	});

	it("lets the person close a question that started open", async () => {
		await mount({ ...done, details: { id: "mail-q", kind: "question", from: "abc", text: "Keep it?" } });
		expect(container.querySelector("[data-agent-mail-body]")?.textContent).toContain("Keep it?");
		await act(async () => toggle()?.click());
		expect(container.querySelector("[data-agent-mail-body]")).toBeNull();
	});
});
