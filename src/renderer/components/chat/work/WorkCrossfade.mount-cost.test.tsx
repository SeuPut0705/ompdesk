/**
 * What a live work card builds when its stage changes hands: the departing frame keeps its DOM
 * for its fade instead of being built again, and a live terminal surface mounting with a log
 * already in it marks only lines that arrive afterwards.
 */
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { act, type ReactNode, useEffect } from "react";
import type { Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "../../../lib/i18n";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });
// React DOM must initialize only after the linkedom browser globals exist.
const { createRoot } = await import("react-dom/client");
const { WorkCrossfade } = await import("./WorkCrossfade");
const { BashRenderer } = await import("../../tools/renderers/BashRenderer");

let root: Root;
let container: HTMLElement;
async function render(node: ReactNode) {
	await act(async () => root.render(<I18nProvider>{node}</I18nProvider>));
}
beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
});
afterEach(async () => {
	await act(async () => root.unmount());
	container.remove();
	vi.useRealTimers();
});

describe("crossfade", () => {
	it("fades the departing frame out on the DOM it already had, without mounting it again", async () => {
		const mounts: string[] = [];
		function Surface({ name }: { name: string }) {
			useEffect(() => {
				mounts.push(name);
			}, [name]);
			return <div className="surface">{name}</div>;
		}
		const frame = (identity: string) => (
			<WorkCrossfade identity={identity} motion>
				<Surface name={identity} />
			</WorkCrossfade>
		);
		await render(frame("a"));
		const shown = container.querySelector(".surface");
		await render(frame("b"));
		const outgoing = container.querySelector("[data-outgoing]");
		expect(outgoing?.querySelector(".surface")).toBe(shown);
		expect(outgoing?.getAttribute("aria-hidden")).toBe("true");
		expect(outgoing?.hasAttribute("inert")).toBe(true);
		expect(outgoing?.hasAttribute("data-incoming")).toBe(false);
		// The incoming frame is first in the DOM, above the outgoing one.
		expect(container.querySelector(".omp-work-crossfade")?.firstElementChild?.textContent).toBe("b");
		expect(mounts).toEqual(["a", "b"]);
		await act(async () => vi.advanceTimersByTime(220));
		expect(container.querySelector("[data-outgoing]")).toBeNull();
		expect(mounts).toEqual(["a", "b"]);
	});
});

describe("live terminal lines", () => {
	const live = (output: string) => (
		<BashRenderer
			livePreview
			isPartial
			args={{ command: "build" }}
			result={undefined}
			partialResult={{ content: [{ type: "text", text: output }] }}
		/>
	);
	const arrived = () =>
		[...container.querySelectorAll(".omp-bash-line")].map(line => [
			line.textContent,
			line.hasAttribute("data-arrived"),
		]);

	it("marks only lines that arrive after the surface mounted", async () => {
		await render(live("one\ntwo\nthr"));
		// The open last line is still arriving; the complete ones were already there.
		expect(arrived()).toEqual([
			["one", false],
			["two", false],
			["thr", true],
		]);
		await render(live("one\ntwo\nthree\nfour"));
		expect(arrived()).toEqual([
			["one", false],
			["two", false],
			["three", true],
			["four", true],
		]);
	});

	it("marks every line of a surface that mounted empty", async () => {
		await render(live(""));
		await render(live("one\ntwo"));
		expect(arrived()).toEqual([
			["one", true],
			["two", true],
		]);
	});

	it("animates arrived lines only, and reduced motion still stops them", () => {
		const css = readFileSync(new URL("../../../styles/components.css", import.meta.url), "utf8");
		const arrival = /\n([^\n{}]*)\{\s*animation: omp-work-arrival/.exec(css)?.[1]?.trim();
		expect(arrival).toBe(".omp-work-motion .omp-bash-line:where([data-arrived])");
		const reduced = css.slice(css.indexOf("@media (prefers-reduced-motion: reduce)", css.indexOf(arrival ?? "")));
		expect(reduced).toMatch(/\.omp-work-motion \.omp-bash-line,[^{]*\{\s*animation: none;/);
	});
});
