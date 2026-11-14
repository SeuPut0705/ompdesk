import { expect, it, vi } from "vitest";
import { noteOmpExit, ompsExitedIn } from "./omp-exits";

it("keeps a folder ineligible for removal after its exit confirmation fails", async () => {
	const exit = Promise.withResolvers<void>();
	const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
	try {
		noteOmpExit("/synthetic/unconfirmed-folder", exit.promise);
		exit.reject(new Error("exit could not be confirmed"));
		await Promise.allSettled([exit.promise]);
		expect(await ompsExitedIn("/synthetic/unconfirmed-folder", 1_000)).toBe(false);
		expect(await ompsExitedIn("/synthetic/unconfirmed-folder", 1_000)).toBe(false);
		expect(await ompsExitedIn("/synthetic/independent-folder", 1_000)).toBe(true);
	} finally {
		warning.mockRestore();
	}
});

it("permits removal only after every recorded execution in the folder exits", async () => {
	const first = Promise.withResolvers<void>();
	const second = Promise.withResolvers<void>();
	noteOmpExit("/synthetic/confirmed-folder", first.promise);
	noteOmpExit("/synthetic/confirmed-folder/child", second.promise);
	const waiting = ompsExitedIn("/synthetic/confirmed-folder", 1_000);
	first.resolve();
	second.resolve();
	expect(await waiting).toBe(true);
	expect(await ompsExitedIn("/synthetic/confirmed-folder", 1_000)).toBe(true);
});
