/**
 * Windows logoff and shutdown end omp's tree with DBG_TERMINATE_PROCESS (exit code 0x40010004), while
 * OMPdesk's main process is still up for a few seconds. A fake child stands in for omp because only Windows
 * can exit with that code (POSIX truncates exit codes to 8 bits).
 */
import type * as ChildProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import type { SidecarStatusPayload } from "../shared/rpc-types";
import type { OmpResolution } from "./omp-runtime";
import { type SidecarFailureReport, SidecarManager } from "./sidecar";

const DBG_TERMINATE_PROCESS = 1073807364;

const fakeSpawn = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
	...(await importOriginal<typeof ChildProcess>()),
	spawn: fakeSpawn.spawn,
}));

class FakeChild extends EventEmitter {
	readonly stdin = new PassThrough();
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly pid = 4242;
	exitCode: number | null = null;
	signalCode: NodeJS.Signals | null = null;
	kill = vi.fn(() => true);

	exit(code: number): void {
		this.exitCode = code;
		this.emit("exit", code, null);
	}
}

const omp = async (): Promise<OmpResolution> => ({
	ok: true,
	runtime: { bin: "omp", version: "18.12.3", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
});

describe("omp ended by the Windows session", () => {
	let children: FakeChild[];

	beforeEach(() => {
		vi.useFakeTimers();
		children = [];
		fakeSpawn.spawn.mockReset();
		fakeSpawn.spawn.mockImplementation(() => {
			const child = new FakeChild();
			children.push(child);
			return child;
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	async function boot(): Promise<{
		sidecar: SidecarManager;
		statuses: SidecarStatusPayload[];
		reportFailure: Mock<(report: SidecarFailureReport) => void>;
	}> {
		const reportFailure = vi.fn<(report: SidecarFailureReport) => void>();
		const sidecar = new SidecarManager({ omp, cwd: process.cwd(), reportFailure });
		const statuses: SidecarStatusPayload[] = [];
		sidecar.on("status", payload => statuses.push(payload));
		sidecar.start();
		await vi.advanceTimersByTimeAsync(0);
		expect(children).toHaveLength(1);
		return { sidecar, statuses, reportFailure };
	}

	it("is not respawned, shows no restart loop and reports no crash", async () => {
		const { sidecar, statuses, reportFailure } = await boot();
		try {
			children[0]?.exit(DBG_TERMINATE_PROCESS);
			await vi.advanceTimersByTimeAsync(60_000);

			expect(children).toHaveLength(1);
			expect(statuses.map(payload => payload.status)).not.toContain("restarting");
			expect(statuses.at(-1)).toMatchObject({ status: "exited", sessionEnded: true });
			expect(sidecar.statusPayload).toMatchObject({ status: "exited", sessionEnded: true });
			expect(reportFailure).not.toHaveBeenCalled();
		} finally {
			sidecar.dispose();
		}
	});

	it("still respawns after any other abnormal exit", async () => {
		const { sidecar, statuses } = await boot();
		try {
			children[0]?.exit(1);
			await vi.advanceTimersByTimeAsync(10_000);

			expect(children).toHaveLength(2);
			expect(statuses.map(payload => payload.status)).toContain("restarting");
		} finally {
			sidecar.dispose();
		}
	});
});
