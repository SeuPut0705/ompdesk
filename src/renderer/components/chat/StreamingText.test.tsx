import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { I18nProvider } from "../../lib/i18n";
import { preloadMarkdownPipeline } from "../../lib/markdown";
import { useMessagesStore } from "../../stores/messages";
import { useToolsStore } from "../../stores/tools";
import { useUiStore } from "../../stores/ui";
import { StreamingRows } from "./ChatStream";
import { StreamingText } from "./StreamingText";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
const globals = globalThis as Record<string, unknown>;
Object.assign(globals, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
// KaTeX is a lazy pipeline step; load it up front so typesetting is synchronous here.
beforeAll(() => preloadMarkdownPipeline());

interface TestElement {
	textContent: string | null;
	remove: () => void;
	getAttribute: (name: string) => string | null;
	setAttribute: (name: string, value: string) => void;
	querySelector: (selector: string) => TestElement | null;
	querySelectorAll: (selector: string) => TestElement[];
}

let frameId = 0;
let frameTime = 0;
const frameCallbacks = new Map<number, FrameRequestCallback>();
const testWindow = window as unknown as Record<string, unknown>;
testWindow.requestAnimationFrame = (callback: FrameRequestCallback) => {
	const id = ++frameId;
	frameCallbacks.set(id, callback);
	return id;
};
testWindow.cancelAnimationFrame = (id: number) => frameCallbacks.delete(id);

let container: TestElement;
let root: Root;

async function mount(text: string, element: ReactElement = <StreamingText />): Promise<void> {
	useMessagesStore.setState({ streamingText: text });
	container = document.createElement("div") as unknown as TestElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

async function flushFrame(elapsed = 50): Promise<void> {
	frameTime += elapsed;
	const callbacks = [...frameCallbacks.values()];
	frameCallbacks.clear();
	await act(async () => {
		for (const callback of callbacks) callback(frameTime);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
	useMessagesStore.getState().reset();
	useToolsStore.getState().reset();
	useUiStore.setState({ transcriptDetail: "compact" });
	frameCallbacks.clear();
	frameTime = 0;
});

describe("StreamingText presentation", () => {
	it("keeps the live reply on the same assistant surface as restored output", async () => {
		useMessagesStore.setState({
			streamingMessage: { role: "assistant", content: [], timestamp: "2026-08-22T00:00:00Z" },
		});
		useUiStore.setState({ transcriptDetail: "full" });
		await mount("Live answer", <StreamingRows />);

		const turn = container.querySelector(".omp-streaming-turn");
		expect(turn?.getAttribute("class")).toContain("omp-assistant-turn");
		expect(turn?.querySelector(".omp-transcript-content")).not.toBeNull();
		expect(turn?.querySelector(".omp-streaming-tail")?.textContent).toContain("Live answer");
	});

	it("coalesces multiple incoming prefixes into one visible animation frame", async () => {
		await mount("A");

		await act(async () => {
			useMessagesStore.setState({ streamingText: "AB" });
			useMessagesStore.setState({ streamingText: "ABC" });
		});
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("A");

		await flushFrame();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("ABC");
	});

	it("renders the unfinished tail as markdown, never as raw markers", async () => {
		await mount("A **bold** start and `code` with a [link](https://example.com)");
		const tail = container.querySelector(".omp-streaming-tail");
		expect(tail?.querySelector("strong")?.textContent).toBe("bold");
		expect(tail?.querySelector("code")?.textContent).toBe("code");
		expect(tail?.querySelector("a")?.getAttribute("href")).toBe("https://example.com");
		expect(tail?.textContent).not.toContain("**");
	});

	it("sanitizes the tail like any reply", async () => {
		await mount('Hi <span class="fixed inset-0">x</span><script>alert(1)</script>');
		const tail = container.querySelector(".omp-streaming-tail");
		expect(tail?.querySelector("script")).toBeNull();
		expect(tail?.querySelector(".fixed")).toBeNull();
		expect(tail?.textContent).not.toContain("alert");
	});

	it("holds back a lone marker line instead of flashing a heading", async () => {
		await mount("Some text\n-");
		const tail = container.querySelector(".omp-streaming-tail");
		expect(tail?.querySelector("h2")).toBeNull();
		expect(tail?.textContent).toBe("Some text");

		await act(async () => {
			useMessagesStore.setState({ streamingText: "Some text\n- item" });
		});
		await flushFrame();
		expect(container.querySelector(".omp-streaming-tail li")?.textContent).toBe("item");
	});

	it("parses a completed paragraph once and keeps rendering the growing tail", async () => {
		const paragraph = "First **complete** paragraph.";
		await mount(paragraph);

		await act(async () => {
			useMessagesStore.setState({ streamingText: `${paragraph}\n\nTail *still* growing` });
		});
		await flushFrame();

		expect(container.querySelectorAll(".omp-streaming-block")).toHaveLength(1);
		expect(container.querySelector(".omp-streaming-block strong")?.textContent).toBe("complete");
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("Tail still growing");
		expect(container.querySelector(".omp-streaming-tail em")?.textContent).toBe("still");
	});

	it("shows a streamed fence as plain code, highlighted once it closes", async () => {
		const unfinished = "```ts\nconst answer = 42;\n";
		const completed = `${unfinished}\`\`\`\n`;
		await mount(unfinished);
		const live = container.querySelector(".omp-streaming-tail pre code");
		expect(live?.textContent).toContain("const answer = 42;");
		expect(live?.textContent).not.toContain("```");
		expect(live?.querySelector("[class^='hljs-']")).toBeNull();

		await act(async () => {
			useMessagesStore.setState({ streamingText: completed });
		});
		await flushFrame();

		expect(container.querySelector(".omp-streaming-block code.language-typescript")?.textContent).toContain(
			"const answer = 42;",
		);
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("");
	});

	it("keeps an unfinished bracket equation together and typesets it when it closes", async () => {
		const unfinished = String.raw`\[
TPS_{\text{decode}}

=
\frac{500-1}{12-2}
=
49.9
`;
		await mount(unfinished);
		expect(container.querySelector(".omp-streaming-block")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe(unfinished);

		await act(async () => {
			useMessagesStore.setState({ streamingText: `${unfinished}\\]\nExplanation` });
		});
		await flushFrame();

		expect(container.querySelectorAll(".katex-display")).toHaveLength(1);
		expect(container.querySelector("h1, h2, .katex-error")).toBeNull();
		expect(container.querySelector(".omp-streaming-tail")?.textContent).toBe("Explanation");
	});
});
