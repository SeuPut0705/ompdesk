import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DiskFullState } from "../../shared/ipc-types";
import { useToastStore } from "../stores/toast";
import { createDiskFullToaster, subscribeDiskFull } from "./disk-full";
import { translate } from "./i18n";

const active = () => useToastStore.getState().toasts.filter(entry => entry.exitingAt === undefined);

describe("the disk-full toast", () => {
	beforeEach(() => useToastStore.setState({ toasts: [] }));
	afterEach(() => useToastStore.setState({ toasts: [] }));

	it("is one warning that stays and names the files, however often main repeats it", () => {
		const toaster = createDiskFullToaster();
		toaster.apply({ files: ["web-devices.json"] });
		toaster.apply({ files: ["web-devices.json"] });

		expect(active()).toHaveLength(1);
		const [shown] = active();
		expect(shown?.variant).toBe("warning");
		expect(shown?.expiresAt).toBe(Number.POSITIVE_INFINITY);
		expect(shown?.title).toBe(translate("diskFull.toastTitle"));
		expect(shown?.message).toBe(translate("diskFull.toastBody", { files: "web-devices.json" }));
		expect(shown?.message).toContain("web-devices.json");
	});

	it("is replaced when the files change and gone once they are saved", () => {
		const toaster = createDiskFullToaster();
		toaster.apply({ files: ["web-devices.json"] });
		toaster.apply({ files: ["web-devices.json", "prefs.json"] });
		expect(active()).toHaveLength(1);
		expect(active()[0]?.message).toContain("web-devices.json, prefs.json");

		toaster.apply({ files: [] });
		expect(active()).toHaveLength(0);
	});

	it("shows nothing for an empty list, and its toast goes with the window", () => {
		const toaster = createDiskFullToaster();
		toaster.apply({ files: [] });
		expect(active()).toHaveLength(0);
		toaster.apply({ files: ["prefs.json"] });
		toaster.dispose();
		expect(active()).toHaveLength(0);
	});
});

describe("subscribeDiskFull", () => {
	let push: (state: DiskFullState) => void = () => {};
	let answer: (state: DiskFullState) => void = () => {};
	let unsubscribed = 0;

	beforeEach(() => {
		useToastStore.setState({ toasts: [] });
		vi.stubGlobal("window", {
			omp: {
				events: {
					onDiskFull: (callback: (state: DiskFullState) => void) => {
						push = callback;
						return () => unsubscribed++;
					},
				},
				diskFull: {
					get: () =>
						new Promise<DiskFullState>(resolve => {
							answer = resolve;
						}),
				},
			},
		});
		unsubscribed = 0;
	});
	afterEach(() => {
		vi.unstubAllGlobals();
		useToastStore.setState({ toasts: [] });
	});

	it("shows what main already holds when the window mounts", async () => {
		const stop = subscribeDiskFull();
		answer({ files: ["prefs.json"] });
		await vi.waitFor(() => expect(active()).toHaveLength(1));
		expect(active()[0]?.message).toContain("prefs.json");
		stop();
		expect(active()).toHaveLength(0);
		expect(unsubscribed).toBe(1);
	});

	it("follows a push, and a push that came while the read was out is newer than its answer", async () => {
		const stop = subscribeDiskFull();
		push({ files: [] });
		answer({ files: ["prefs.json"] });
		await Promise.resolve();
		await Promise.resolve();
		expect(active()).toHaveLength(0);

		push({ files: ["web-devices.json"] });
		expect(active()).toHaveLength(1);
		expect(active()[0]?.message).toContain("web-devices.json");
		stop();
	});
});
