import { parseHTML } from "linkedom";
import { act, type ReactElement } from "react";
import type { Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";

const { document, window, HTMLElement, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	HTMLElement,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

// react-dom reads the DOM globals when it loads, so it is imported after they exist (the linkedom harness).
const { createRoot } = await import("react-dom/client");
const { Gauge } = await import("./Gauge");

let root: Root | undefined;
let container: HTMLElement;

async function mount(element: ReactElement): Promise<Element> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => root?.render(element));
	return container as unknown as Element;
}

afterEach(async () => {
	await act(async () => root?.unmount());
	document.body.replaceChildren();
});

describe("Gauge", () => {
	it("is a named progressbar whose value follows the fraction", async () => {
		const view = await mount(
			<Gauge ariaLabel="GitHub macOS: 2 of 5 slots in use" fraction={0.4} label="GitHub macOS" valueText="2/5" />,
		);
		const bar = view.querySelector('[role="progressbar"]');
		expect(bar?.getAttribute("aria-label")).toBe("GitHub macOS: 2 of 5 slots in use");
		expect(bar?.getAttribute("aria-valuenow")).toBe("40");
		expect(bar?.getAttribute("aria-valuetext")).toBe("2/5");
		expect(bar?.getAttribute("aria-valuemin")).toBe("0");
		expect(bar?.getAttribute("aria-valuemax")).toBe("100");
	});

	it("says a value in words to assistive tech when given", async () => {
		const view = await mount(
			<Gauge ariaLabel="Disk" ariaValueText="2 of 5 slots" fraction={0.4} label="Disk" valueText="2/5" />,
		);
		expect(view.querySelector('[role="progressbar"]')?.getAttribute("aria-valuetext")).toBe("2 of 5 slots");
	});

	it("clamps a fraction outside 0..1 and an unmeasurable one", async () => {
		const over = await mount(<Gauge ariaLabel="Over" fraction={1.7} label="Over" valueText="170%" />);
		expect(over.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("100");
		const under = await mount(<Gauge ariaLabel="Under" fraction={-0.2} label="Under" valueText="-20%" />);
		expect(under.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
		const unknown = await mount(<Gauge ariaLabel="NaN" fraction={Number.NaN} label="NaN" valueText="?" />);
		expect(unknown.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("0");
	});

	it("draws its label and its value text, and keeps them out of the accessible name's way", async () => {
		const view = await mount(<Gauge ariaLabel="MacBook: 2 of 3" fraction={2 / 3} label="MacBook" valueText="2/3" />);
		const text = view.querySelector('[role="progressbar"] [aria-hidden="true"]');
		expect(text?.textContent).toBe("MacBook2/3");
		expect(text?.children[0]?.textContent).toBe("MacBook");
		expect(text?.children[1]?.textContent).toBe("2/3");
	});

	it("tints the fill by state and passes data attributes to its root", async () => {
		const plain = await mount(<Gauge ariaLabel="A" data-pool="a" fraction={0.1} label="A" valueText="1" />);
		expect(plain.querySelector("[data-pool]")?.getAttribute("data-state")).toBe("ok");
		const near = await mount(<Gauge ariaLabel="B" fraction={1} label="B" state="near" valueText="5/5" />);
		expect(near.querySelector("[data-state]")?.getAttribute("data-state")).toBe("near");
	});

	it("draws a caption only when one is given", async () => {
		const without = await mount(<Gauge ariaLabel="A" fraction={0.5} label="A" valueText="1" />);
		expect(without.textContent).toBe("A1");
		const withCaption = await mount(
			<Gauge ariaLabel="A" caption="oldest wait 2h 14m" fraction={0.5} label="A" valueText="1" />,
		);
		expect(withCaption.textContent).toContain("oldest wait 2h 14m");
		expect(withCaption.querySelector('[role="img"]')).toBeNull();
	});

	it("names a caption that is only glyphs and gives it a tooltip", async () => {
		const view = await mount(
			<Gauge
				ariaLabel="5-hour limit 64%"
				caption="↻ 1h 54m"
				captionLabel="Resets in 1h 54m"
				fraction={0.64}
				label="5H"
				valueText="64%"
			/>,
		);
		const caption = view.querySelector('[role="img"]');
		expect(caption?.getAttribute("aria-label")).toBe("Resets in 1h 54m");
		expect(caption?.getAttribute("title")).toBe("Resets in 1h 54m");
		expect(caption?.textContent).toBe("↻ 1h 54m");
	});
});
