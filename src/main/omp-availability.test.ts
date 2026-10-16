import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SetupPresence, SetupState } from "../shared/setup";
import { followSetupState, OmpUnavailableError, ompAvailability, resetOmpAvailability } from "./omp-availability";
import * as ompRuntime from "./omp-runtime";
import { SessionIndex } from "./session-index";
import { stockHelperRequest } from "./stock-helper";

/** Machine setup's state with omp at `presence` (null: before the first detection). */
function setup(presence: SetupPresence | null, phase: "present" | "running" | "failed" = "present"): SetupState {
	return {
		platform: "darwin",
		automatic: true,
		ompReady: presence?.kind === "present",
		requiredRunning: phase === "running",
		items: [
			{
				id: "omp",
				required: true,
				phase,
				presence,
				method: null,
				command: null,
				location: null,
				prompt: null,
				progress: null,
				output: "",
				failure: null,
				manualCommands: [],
				manualUrl: "https://example.test/omp",
			},
		],
	};
}

const PRESENT: SetupPresence = { kind: "present", version: "18.11.0", path: "/usr/local/bin/omp" };
const MISSING: SetupPresence = { kind: "missing" };

afterEach(() => {
	resetOmpAvailability();
	vi.restoreAllMocks();
});

describe("followSetupState", () => {
	it("is unknown until setup's first detection, so a normal launch never waits for it", () => {
		expect(followSetupState(setup(null, "running"))).toBeNull();
		expect(ompAvailability()).toBe("unknown");
	});

	it("reports once that omp became usable after it was missing, with the refused readers to wake", () => {
		expect(followSetupState(setup(MISSING, "running"))).toBeNull();
		expect(ompAvailability()).toBe("missing");
		expect(followSetupState(setup(MISSING, "failed"))).toBeNull();
		expect(followSetupState(setup(PRESENT))).toEqual({ refused: true });
		expect(ompAvailability()).toBe("usable");
		// Later pushes (optional installs' progress) change nothing.
		expect(followSetupState(setup(PRESENT))).toBeNull();
	});

	it("wakes no reader on a normal launch, where omp was there all along", () => {
		expect(followSetupState(setup(PRESENT))).toEqual({ refused: false });
	});
});

describe("while omp is missing", () => {
	it("starts no stock-helper worker: the request is refused at once, and the refusal wakes its readers later", async () => {
		const resolve = vi.spyOn(ompRuntime, "systemOmp");
		followSetupState(setup(MISSING, "running"));
		await expect(stockHelperRequest("sessions.list", {})).rejects.toBeInstanceOf(OmpUnavailableError);
		expect(resolve).not.toHaveBeenCalled();
		followSetupState(setup(PRESENT));
		expect(ompAvailability()).toBe("usable");
	});

	it("lists no sessions instead of failing", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-availability-"));
		try {
			followSetupState(setup(MISSING, "running"));
			const index = new SessionIndex(dir, dir);
			await expect(index.list("global")).resolves.toEqual([]);
			index.stop();
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	it("treats an omp that does not resolve before setup's detection the same way", async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-availability-"));
		vi.spyOn(ompRuntime, "systemOmp").mockResolvedValue({
			ok: false,
			error: "omp not found",
			reason: { kind: "not-found" },
		});
		try {
			const index = new SessionIndex(dir, dir);
			await expect(index.list("global")).resolves.toEqual([]);
			index.stop();
			// The refusal is remembered: once setup sees omp, the session list is read again.
			expect(followSetupState(setup(PRESENT))).toEqual({ refused: true });
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});
});
