import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { useSubagentsStore } from "../../../stores/subagents";
import { type ToolEntry, toolEntriesState, useToolsStore } from "../../../stores/tools";
import { WorkMedia } from "./WorkMedia";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis, { document, window, Event, HTMLElement, Element, Node, IS_REACT_ACT_ENVIRONMENT: true });

let root: Root | undefined;
let container: HTMLElement | undefined;
let sequence = 0;
function entry(toolName: string, args: Record<string, unknown>): ToolEntry {
	return {
		toolName,
		args,
		status: "done",
		streamingArgs: "",
		result: { content: [{ type: "text", text: "Success" }], details: {} },
		isError: false,
		startTime: ++sequence,
		endTime: sequence + 1,
	};
}
async function mount(entries: ToolEntry[]) {
	const ids = entries.map((_, index) => `call-${index}`);
	useToolsStore.setState(toolEntriesState(entries.map((item, index) => [ids[index], item])));
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container);
	await act(async () => {
		root?.render(
			<I18nProvider>
				<WorkMedia toolCallIds={ids} />
			</I18nProvider>,
		);
	});
	return container;
}
afterEach(async () => {
	await act(async () => root?.unmount());
	root = undefined;
	container?.remove();
	useToolsStore.getState().reset();
	useSubagentsStore.getState().reset();
	sequence = 0;
});

describe("work media", () => {
	it("draws nothing for a run that made no picture", async () => {
		const view = await mount([entry("bash", { command: "ls" })]);
		expect(view.querySelector(".omp-work-images")).toBeNull();
	});
	it("caps images and expands the remaining accessible zoom thumbnails on click", async () => {
		let imageExtractions = 0;
		const reads = Array.from({ length: 5 }, (_, index) => ({
			...entry("read", { path: `shots/image-${index}.png` }),
			result: {
				get content() {
					imageExtractions++;
					return [{ type: "image", mimeType: "image/png", data: `image${index}` }];
				},
			},
		}));
		const view = await mount(reads);
		const initialExtractions = imageExtractions;
		expect(view.querySelectorAll("[data-zoomable-image]")).toHaveLength(4);
		const more = view.querySelector(".omp-work-images > button");
		expect(more?.textContent).toBe("+1 more");
		await act(async () => more?.dispatchEvent(new Event("click", { bubbles: true })));
		expect(view.querySelectorAll("[data-zoomable-image]")).toHaveLength(5);
		expect(more?.getAttribute("aria-expanded")).toBe("true");
		expect(imageExtractions).toBe(initialExtractions);
		// Named by the file, never a raw path as alt text.
		expect(view.querySelector("img")?.getAttribute("alt")).toBe("image-0.png");
		expect(view.querySelector("details")).toBeNull();
	});
	it("draws a stored read image and shows one whose bytes are gone as its file, never a broken image", async () => {
		// Stock's read of a PNG as a subagent journal persists it: the bytes live in the blob store.
		const read = (path: string, data: string): ToolEntry => ({
			...entry("read", { path }),
			result: {
				content: [
					{ type: "text", text: "Read image file [image/png]" },
					{ type: "image", data, mimeType: "image/png" },
				],
				details: { fileSize: 120207, meta: { source: { type: "path", value: path } }, mediaPath: path },
			},
		});
		const view = await mount([
			read("/tmp/ReloadTruth-real/scenarios/ko-group-1.png", "iVBORw0KGgo="),
			read("/tmp/final2/real/scenarios/ko-group-1.png", `blob:sha256:${"0".repeat(64)}`),
		]);
		const images = [...view.querySelectorAll(".omp-work-images img")];
		expect(images.map(image => image.getAttribute("src"))).toEqual(["data:image/png;base64,iVBORw0KGgo="]);
		for (const image of view.querySelectorAll("img")) {
			expect(image.getAttribute("src")).not.toContain("blob:sha256:");
			expect(image.getAttribute("alt")).not.toContain("/");
		}
		const chip = view.querySelector(".omp-work-images [data-image-unavailable]");
		expect(chip?.textContent).toContain("ko-group-1.png");
		expect(chip?.querySelector("button")?.getAttribute("title")).toBe("/tmp/final2/real/scenarios/ko-group-1.png");
	});
});
