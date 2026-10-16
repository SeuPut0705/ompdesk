import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node, MutationObserver } =
	parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	MutationObserver,
	IS_REACT_ACT_ENVIRONMENT: true,
});

const { createRoot } = await import("react-dom/client");
const { WriteRenderer } = await import("./WriteRenderer");

let container: HTMLElement;
let root: Root;

async function mount(element: ReactElement): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(<I18nProvider>{element}</I18nProvider>);
	});
}

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

const DIFF = "@@ -1,2 +1,2 @@\n-1|const oldValue = true;\n+1|const newValue = true;\n 2|export {};\n";

async function expand(): Promise<void> {
	const toggle = container.querySelector('button[aria-expanded="false"]') as HTMLElement | null;
	await act(async () => {
		toggle?.click();
	});
}

describe("WriteRenderer", () => {
	it("create: content preview behind the toggle, no overwrite markers", async () => {
		await mount(<WriteRenderer args={{ path: "src/new.ts", content: "const a = 1;\n" }} result={{}} />);
		expect(container.textContent).toContain("new.ts");
		expect(container.textContent).not.toContain("Overwrote");
		expect(container.textContent).not.toContain("+1");

		await expand();
		expect(container.textContent).toContain("const a = 1;");
	});

	it("overwrite with diff: stats ride the header, toggle reveals the diff", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "src/existing.ts", content: "const newValue = true;\nexport {};\n" }}
				result={{
					content: [{ type: "text", text: "Successfully wrote 42 bytes to src/existing.ts" }],
					details: { overwritten: true, diff: DIFF, firstChangedLine: 1 },
				}}
			/>,
		);
		expect(container.textContent).toContain("+1");
		expect(container.textContent).toContain("−1");

		await expand();
		expect(container.textContent).toContain("const newValue = true;");
		// The removed line of the diff renders too — proving the diff view, not
		// the content preview, is what the toggle revealed.
		expect(container.textContent).toContain("const oldValue = true;");
	});

	it("overwrite without diff: warns instead of pretending it is a create", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "src/existing.ts", content: "same\n" }}
				result={{
					content: [{ type: "text", text: "Successfully wrote 5 bytes to src/existing.ts" }],
					details: { overwritten: true },
				}}
			/>,
		);
		expect(container.textContent).toContain("Overwrote existing file");

		// Content preview still available behind the toggle.
		await expand();
		expect(container.textContent).toContain("same");
	});

	it("accepts the file_path argument alias", async () => {
		await mount(<WriteRenderer args={{ file_path: "src/alias.ts", content: "x\n" }} result={{}} />);
		expect(container.textContent).toContain("alias.ts");
	});

	it(".svg write: sanitized data URL preview, Code switch shows the source", async () => {
		const svg =
			'<svg viewBox="0 0 4 4" onload="alert(1)"><script>alert(2)</script><rect width="4" height="4"/></svg>';
		await mount(<WriteRenderer args={{ path: "art/logo.svg", content: svg }} result={{}} />);
		await expand();
		const img = container.querySelector("[data-svg-preview] img");
		const src = img?.getAttribute("src") ?? "";
		expect(src.startsWith("data:image/svg+xml;charset=utf-8,")).toBe(true);
		const decoded = decodeURIComponent(src.slice(src.indexOf(",") + 1));
		expect(decoded).toContain('<rect width="4" height="4"/>');
		expect(decoded).not.toMatch(/script|onload|alert/);
		expect(container.textContent).not.toContain("alert(2)");

		await showCode();
		expect(container.querySelector("[data-svg-preview]")).toBeNull();
		expect(container.textContent).toContain("alert(2)");
	});

	it(".svg write that does not parse yet shows only the code", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "art/logo.svg", content: '<svg viewBox="0 0 4 4"><rect wid' }}
				isPartial
				result={{}}
			/>,
		);
		await expand();
		expect(container.querySelector("[data-svg-preview]")).toBeNull();
		expect(container.querySelector("[data-figure-mode]")).toBeNull();
		expect(container.textContent).toContain("<rect wid");
	});

	it(".svg overwrite keeps the diff behind the Code switch", async () => {
		await mount(
			<WriteRenderer
				args={{ path: "art/logo.svg", content: '<svg viewBox="0 0 1 1"/>' }}
				result={{ details: { overwritten: true, diff: DIFF } }}
			/>,
		);
		await expand();
		expect(container.querySelector("[data-svg-preview] img")).not.toBeNull();
		await showCode();
		expect(container.textContent).toContain("const oldValue = true;");
	});

	it(".mmd write renders through MermaidBlock once the content is complete", async () => {
		document.documentElement.setAttribute("data-theme", "dark");
		const diagram = "graph TD\n  A --> B\n";
		await mount(<WriteRenderer args={{ path: "docs/flow.mmd", content: diagram }} result={{}} />);
		await expand();
		const figure = container.querySelector('[data-figure="mermaid"]');
		// MermaidBlock: rendering (Preview showing), or (mermaid needs a real browser) its source in the same box.
		expect(figure?.textContent).toMatch(/Rendering diagram|Mermaid/);
		expect(figure?.querySelector("[data-figure-title]")?.textContent).toBe("flow.mmd");
		await showCode();
		expect(container.textContent).toContain("A --> B");

		await act(async () => root.unmount());
		await mount(
			<WriteRenderer args={{ path: "docs/flow.mermaid", content: "graph TD\n  A -" }} isPartial result={{}} />,
		);
		await expand();
		expect(container.querySelector("[data-figure]")).toBeNull();
		expect(container.textContent).toContain("A -");
	});
});

/** Switch the open figure to its code view (a figure whose picture has not drawn has no switch: it already shows code). */
async function showCode(): Promise<void> {
	const button = container.querySelector('[data-figure-mode-button="code"]') as HTMLElement | null;
	await act(async () => {
		button?.click();
	});
}
