import { describe, expect, it, vi } from "vitest";
import { drainOnExit, type ExitDrainDeps, type ExitingProcess } from "../../resources/gui-bridge/exit-drain-core";

const NATIVE = Symbol("native");

/** A process and a `postmortem` whose cleanup pass ends when the test says, and whose `quit` exits as stock's does. */
function world() {
	const pass = Promise.withResolvers<void>();
	const native = vi.fn();
	const proc: ExitingProcess = { exit: native as unknown as ExitingProcess["exit"] };
	const exited: number[] = [];
	const deps: ExitDrainDeps = {
		quit: vi.fn(async (code: number) => {
			await pass.promise;
			proc.exit(code);
		}),
		exitProcess: code => void exited.push(code),
		NATIVE_PROCESS_EXIT: NATIVE,
	};
	return { proc, deps, pass, native, exited };
}

describe("an exit that waits for omp's cleanup", () => {
	it("ends the process only once the cleanup pass settled, with the code the exit gave", async () => {
		const { proc, deps, pass, native, exited } = world();
		drainOnExit(proc, deps);
		proc.exit(3);
		await Promise.resolve();
		expect(exited).toEqual([]);
		pass.resolve();
		await vi.waitFor(() => expect(exited).toEqual([3]));
		expect(native).not.toHaveBeenCalled();
	});

	it("starts one pass however many exits come while it runs", async () => {
		const { proc, deps, pass, exited } = world();
		drainOnExit(proc, deps);
		proc.exit(0);
		proc.exit(1);
		pass.resolve();
		await vi.waitFor(() => expect(exited).toEqual([0]));
		expect(deps.quit).toHaveBeenCalledTimes(1);
	});

	it("still ends the process when the cleanup pass fails", async () => {
		const { proc, deps, pass, exited } = world();
		drainOnExit(proc, deps);
		proc.exit();
		pass.reject(new Error("a cleanup threw"));
		await vi.waitFor(() => expect(exited).toEqual([0]));
	});

	it("names the exit it stands in for, so stock's own hard exit reaches it, and installs once", () => {
		const { proc, deps, native } = world();
		drainOnExit(proc, deps);
		const first = proc.exit;
		expect(Reflect.get(first, NATIVE)).toBe(native);
		drainOnExit(proc, deps);
		expect(proc.exit).toBe(first);
	});
});
