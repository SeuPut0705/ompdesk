/**
 * Windows logoff and shutdown end omp's tree with DBG_TERMINATE_PROCESS (exit code 0x40010004), while
 * OMPdesk's main process is still up for a few seconds. Only Windows can exit with that code (POSIX truncates exit
 * codes to 8 bits), so a fake omp that exits with it runs through the real core (`sidecar/`), which owns the exit's
 * classification. The case reached into the TypeScript spawn before (a mocked `node:child_process`); the core spawns
 * now, so the fake is a real process and the respawn delays are the lane's `tuning`.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import type { SidecarStatusPayload } from "../shared/rpc-types";
import type { OmpResolution } from "./omp-runtime";
import { type SidecarFailureReport, SidecarManager } from "./sidecar";
import { RM_TEMP } from "./test-fake-omp";

const DBG_TERMINATE_PROCESS = 1073807364;

const ompAt = (bin: string) => async (): Promise<OmpResolution> => ({
	ok: true,
	runtime: { bin, version: "18.12.3", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
});

/**
 * An omp that reaches `ready`, then ends with `code` right after its first answer; every start leaves a line in `spawns`. It runs under
 * node, not bun: bun keeps only the low 8 bits of an exit code, node on Windows exits with all 32 (`ExitProcess`).
 */
async function endingOmp(
	code: number,
): Promise<{ tempDir: string; binaryPath: string; spawns: () => Promise<number> }> {
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-gui-os-shutdown-"));
	const log = path.join(tempDir, "spawns.txt");
	const script = path.join(tempDir, "omp.cjs");
	await fs.writeFile(
		script,
		[
			`require("node:fs").appendFileSync(${JSON.stringify(log)}, "spawn\\n");`,
			`const write = frame => process.stdout.write(JSON.stringify(frame) + "\\n");`,
			`write({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });`,
			`require("node:readline").createInterface({ input: process.stdin }).on("line", line => {`,
			`	const command = JSON.parse(line);`,
			`	// The tab's first answer is what makes it ready; the omp ends right behind it.`,
			`	process.stdout.write(JSON.stringify({ type: "response", id: command.id, command: command.type, success: true, data: {} }) + "\\n", () => process.exit(${code}));`,
			`});`,
			"",
		].join("\n"),
	);
	// The shim npm's Windows install makes (`omp.cmd`); elsewhere the script runs by its shebang.
	let binaryPath = script;
	if (process.platform === "win32") {
		binaryPath = path.join(tempDir, "omp.cmd");
		await fs.writeFile(binaryPath, `@"${process.execPath}" "${script}" %*\r\n`);
	} else {
		await fs.writeFile(script, `#!/usr/bin/env node\n${await fs.readFile(script, "utf8")}`);
		await fs.chmod(script, 0o755);
	}
	const spawns = async () => (await fs.readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
	return { tempDir, binaryPath, spawns };
}

function boot(binaryPath: string, tempDir: string) {
	const reportFailure = vi.fn<(report: SidecarFailureReport) => void>();
	const sidecar = new SidecarManager({
		omp: ompAt(binaryPath),
		cwd: tempDir,
		reportFailure,
		tuning: { restartDelaysMs: [50, 50, 50] },
	});
	const statuses: SidecarStatusPayload[] = [];
	sidecar.on("status", payload => statuses.push(payload));
	sidecar.start();
	return { sidecar, statuses, reportFailure };
}

describe("omp ended by the Windows session", () => {
	it.skipIf(process.platform !== "win32")(
		"is not respawned, shows no restart loop and reports no crash",
		async () => {
			const { tempDir, binaryPath, spawns } = await endingOmp(DBG_TERMINATE_PROCESS);
			const { sidecar, statuses, reportFailure } = boot(binaryPath, tempDir);
			try {
				await vi.waitFor(() => expect(statuses.at(-1)?.status).toBe("exited"), { timeout: 30_000 });
				// A negative check, so it waits: a respawn would come within the ladder's first delay (`tuning`, 50 ms), and
				// no event says that one will not.
				await delay(500);

				expect(await spawns()).toBe(1);
				expect(statuses.map(payload => payload.status)).not.toContain("restarting");
				expect(statuses.at(-1)).toMatchObject({ status: "exited", sessionEnded: true });
				expect(sidecar.statusPayload).toMatchObject({ status: "exited", sessionEnded: true });
				expect(reportFailure).not.toHaveBeenCalled();
			} finally {
				sidecar.dispose();
				await fs.rm(tempDir, RM_TEMP);
			}
		},
		60_000,
	);

	it("still respawns after any other abnormal exit", async () => {
		const { tempDir, binaryPath, spawns } = await endingOmp(1);
		const { sidecar, statuses } = boot(binaryPath, tempDir);
		try {
			await vi.waitFor(async () => expect(await spawns()).toBeGreaterThanOrEqual(2), { timeout: 30_000 });
			expect(statuses.map(payload => payload.status)).toContain("restarting");
		} finally {
			sidecar.dispose();
			await fs.rm(tempDir, RM_TEMP);
		}
	}, 60_000);
});
