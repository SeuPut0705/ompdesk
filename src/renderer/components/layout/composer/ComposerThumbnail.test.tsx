/**
 * A picture the browser cannot draw (a phone's HEIC in Chromium) shows as a compact photo chip — format and
 * size — never as a broken image; one it can draw stays a thumbnail.
 */
import { parseHTML } from "linkedom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { I18nProvider } from "../../../lib/i18n";
import { ComposerThumbnail } from "./ComposerThumbnail";

const { document, window, Event, HTMLElement, Element, Node } = parseHTML("<html><body></body></html>");
Object.assign(globalThis as Record<string, unknown>, {
	document,
	window,
	Event,
	HTMLElement,
	Element,
	Node,
	IS_REACT_ACT_ENVIRONMENT: true,
});

let container: HTMLElement;
let root: Root;

afterEach(async () => {
	await act(async () => root?.unmount());
	container?.remove();
});

async function mount(mimeType: string, data: string): Promise<void> {
	container = document.createElement("div") as unknown as HTMLElement;
	document.body.appendChild(container as never);
	root = createRoot(container as unknown as Element);
	await act(async () => {
		root.render(
			<I18nProvider>
				<ComposerThumbnail
					alt="Attached image 1"
					data={data}
					mimeType={mimeType}
					src={`data:${mimeType};base64,${data}`}
				/>
			</I18nProvider>,
		);
	});
}

describe("ComposerThumbnail", () => {
	it("turns an undrawable HEIC into a photo chip with its format and size", async () => {
		await mount("image/heic", "A".repeat(2_000_000));
		const img = container.querySelector("img");
		expect(img).not.toBeNull();
		await act(async () => {
			img?.dispatchEvent(new Event("error"));
		});
		expect(container.querySelector("img")).toBeNull();
		const chip = container.querySelector("[data-composer-photo-chip]");
		expect(chip?.getAttribute("aria-label")).toBe("HEIC photo");
		expect(chip?.textContent).toContain("1.4 MB");
	});

	it("keeps a picture that draws as a thumbnail", async () => {
		await mount("image/jpeg", "AQID");
		expect(container.querySelector("img")?.getAttribute("src")).toBe("data:image/jpeg;base64,AQID");
		expect(container.querySelector("[data-composer-photo-chip]")).toBeNull();
	});
});
