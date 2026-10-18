import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OmpApi } from "../../../shared/ipc-types";
import { useChunkFailureStore } from "../../lib/chunk-load";
import { RootErrorBoundary } from "./RootErrorBoundary";

// A paired web page reloads through its runtime, which logs the reason (web/reload-reason.ts).
const web = vi.hoisted(() => ({ reload: vi.fn(), on: true }));
vi.mock("../../web/runtime", () => ({ webRuntime: () => (web.on ? { reload: web.reload } : null) }));

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

interface TestElement {
	remove(): void;
	textContent: string | null;
	querySelectorAll(selector: string): ArrayLike<{ textContent: string | null; click(): void }>;
}

let container: TestElement;
let root: Root;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

function Broken(): ReactNode {
	throw new Error("broken root surface");
}

function StaleChunk(): ReactNode {
	// WebKit's message for a dynamic import whose file the server no longer has (v0.38.1 on a phone).
	throw new TypeError("Importing a module script failed.");
}

async function mount(child: ReactNode): Promise<void> {
	(window as unknown as { omp: OmpApi }).omp = {
		runtime: { report: vi.fn(), logPath: vi.fn(async () => "/tmp/gui-runtime.jsonl") },
	} as unknown as OmpApi;
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element, { onCaughtError: () => {} });
	await act(async () => {
		root.render(<RootErrorBoundary>{child}</RootErrorBoundary>);
	});
}

const buttons = () => Array.from(container.querySelectorAll("button"));

describe("RootErrorBoundary", () => {
	it("replaces a root render crash with a reload surface and exposes the log path", async () => {
		const logPath = vi.fn(async () => "/tmp/gui-runtime.jsonl");
		(window as unknown as { omp: OmpApi }).omp = {
			runtime: { report: vi.fn(), logPath },
		} as unknown as OmpApi;
		container = document.createElement("div") as unknown as TestElement;
		document.body.appendChild(container as never);
		root = createRoot(container as unknown as Element, { onCaughtError: () => {} });

		await act(async () => {
			root.render(
				<RootErrorBoundary>
					<Broken />
				</RootErrorBoundary>,
			);
		});

		expect(container.textContent).toContain("broken root surface");
		expect(container.textContent).toContain("Reload interface");
		expect(container.textContent).toContain("/tmp/gui-runtime.jsonl");
		expect(logPath).toHaveBeenCalledOnce();
	});

	it("stays quiet on a web page for a chunk the server no longer has: no prompt, the build marked stale for the update gate", async () => {
		web.on = true;
		useChunkFailureStore.setState({ failed: false, appGone: false });
		await mount(<StaleChunk />);
		expect(container.textContent).toBe("");
		expect(buttons()).toEqual([]);
		expect(useChunkFailureStore.getState()).toEqual({ failed: true, appGone: true });
	});

	it("shows the ordinary crash screen for a chunk error in a desktop window, which marks nothing", async () => {
		web.on = false;
		useChunkFailureStore.setState({ failed: false, appGone: false });
		try {
			await mount(<StaleChunk />);
			expect(container.textContent).toContain("Reload interface");
			expect(useChunkFailureStore.getState().failed).toBe(false);
		} finally {
			web.on = true;
		}
	});

	it("reloads a web page through its runtime, so the reason reaches the host's log", async () => {
		web.reload.mockClear();
		await mount(<Broken />);
		await act(async () => buttons()[0]?.click());
		expect(web.reload).toHaveBeenCalledWith("error-boundary");
	});
});
