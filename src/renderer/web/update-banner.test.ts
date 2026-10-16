import { parseHTML } from "linkedom";
import { describe, expect, it, vi } from "vitest";
import { mountUpdateBanner } from "./update-banner";

function page() {
	const { document, Event } = parseHTML("<html><body></body></html>");
	return { doc: document as unknown as Document, Event };
}

function source(available: boolean) {
	const listeners = new Set<() => void>();
	const handle = {
		available,
		apply: vi.fn(),
		onChange: (listener: () => void) => {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
	};
	return {
		handle,
		becomeAvailable: () => {
			handle.available = true;
			for (const listener of listeners) listener();
		},
	};
}

describe("the update banner", () => {
	it("shows nothing until an update waits, then 'Update available' with a Reload action", () => {
		const { doc, Event } = page();
		const { handle, becomeAvailable } = source(false);
		mountUpdateBanner(handle, doc, key => key);
		expect(doc.getElementById("omp-web-update")).toBeNull();
		becomeAvailable();
		const bar = doc.getElementById("omp-web-update");
		expect(bar?.querySelector("span")?.textContent).toBe("web.update.available");
		const button = bar?.querySelector("button");
		expect(button?.textContent).toBe("web.update.reload");
		button?.dispatchEvent(new Event("click"));
		expect(handle.apply).toHaveBeenCalledTimes(1);
	});

	it("shows at once when an update already waits and never doubles the bar", () => {
		const { doc } = page();
		const { handle, becomeAvailable } = source(true);
		mountUpdateBanner(handle, doc, key => key);
		becomeAvailable();
		expect(doc.querySelectorAll("#omp-web-update")).toHaveLength(1);
	});
});
