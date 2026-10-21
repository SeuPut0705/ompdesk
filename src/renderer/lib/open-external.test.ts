import { afterEach, describe, expect, it, vi } from "vitest";
import { useToastStore } from "../stores/toast";
import { translate } from "./i18n";
import { openExternal } from "./open-external";

afterEach(() => {
	useToastStore.setState({ toasts: [] });
	vi.unstubAllGlobals();
});

describe("openExternal", () => {
	it("says a link could not open instead of leaving a rejection unhandled", async () => {
		const open = vi.fn(async () => {
			throw new Error("The link to the computer dropped");
		});
		vi.stubGlobal("window", { omp: { system: { openExternal: open } } });
		const unhandled: unknown[] = [];
		const listen = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", listen);
		try {
			openExternal("https://example.com");
			await new Promise(resolve => setTimeout(resolve, 0));
		} finally {
			process.off("unhandledRejection", listen);
		}
		expect(open).toHaveBeenCalledWith("https://example.com");
		expect(unhandled).toEqual([]);
		const [toast] = useToastStore.getState().toasts;
		expect(toast?.title).toBe(translate("link.openFailed"));
	});
});
