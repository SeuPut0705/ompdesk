import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SystemInfo } from "../../../shared/ipc-types";
import { I18nProvider } from "../../lib/i18n";
import { useUiStore } from "../../stores/ui";
import { FeedbackDialog } from "./FeedbackDialog";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

const info: SystemInfo = {
	appVersion: "0.9.13",
	platform: "darwin",
	arch: "arm64",
	osRelease: "25.0.0",
	electron: "36.9.5",
	chrome: "134.0",
	node: "22.0.0",
};

const openExternal = vi.fn<(url: string) => Promise<void>>(() => Promise.resolve());
const logTail = vi.fn<(lines: number) => Promise<string[]>>(() =>
	Promise.resolve(['{"report":{"source":"renderer-console","message":"toast exploded"}}']),
);
const sysInfo = vi.fn<() => Promise<SystemInfo>>(() => Promise.resolve(info));

(window as unknown as { omp: unknown }).omp = {
	system: { info: sysInfo, openExternal },
	runtime: { logTail },
};

let container: InstanceType<typeof HTMLElement>;
let root: Root;

async function mount(): Promise<void> {
	container = document.createElement("div");
	document.body.appendChild(container);
	root = createRoot(container as never);
	await act(async () => {
		root.render(
			<I18nProvider>
				<FeedbackDialog />
			</I18nProvider>,
		);
	});
}

/** The Modal portals to document.body — query there, not in the mount container. */
function field(selector: string): InstanceType<typeof HTMLElement> {
	const el = document.querySelector(selector) as InstanceType<typeof HTMLElement> | null;
	if (!el) throw new Error(`field ${selector} not found`);
	return el;
}

async function submit(): Promise<void> {
	const buttons = [...document.querySelectorAll("button")];
	const target = buttons.find(b => (b.textContent ?? "").includes("GitHub"));
	if (!target) throw new Error("submit button not found");
	await act(async () => {
		target.dispatchEvent(new Event("click", { bubbles: true, cancelable: true }));
	});
}

afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	openExternal.mockClear();
	sysInfo.mockClear();
	logTail.mockClear();
});

describe("FeedbackDialog", () => {
	it("builds a prefilled GitHub issue URL from the draft and diagnostics", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { description: "Sync button threw 405" },
		});
		await mount();
		expect((field("textarea") as unknown as { value: string }).value).toBe("Sync button threw 405");
		await submit();
		expect(openExternal).toHaveBeenCalledTimes(1);
		const url = new URL(openExternal.mock.calls[0][0]);
		expect(`${url.origin}${url.pathname}`).toBe("https://github.com/SeuPut0705/seucode/issues/new");
		expect(url.searchParams.get("labels")).toBe("gui,bug");
		const body = url.searchParams.get("body") ?? "";
		expect(body).toContain("Sync button threw 405");
		expect(body).toContain("v0.9.13");
		expect(body).toContain("toast exploded");
	});

	it("embeds a store-carried error under error details in the issue body", async () => {
		useUiStore.setState({
			feedbackOpen: true,
			feedbackPrefill: { error: "TypeError: boundary crashed", description: "界面崩了" },
		});
		await mount();
		await submit();
		const body = new URL(openExternal.mock.calls[0][0]).searchParams.get("body") ?? "";
		expect(body).toContain("界面崩了");
		expect(body).toContain("TypeError: boundary crashed");
		expect(body).toContain("Error details");
	});
});
