/**
 * A tab's omp whose exit waits on a login refresh it has to save is not killed meanwhile (the owner's rule: the provider
 * already swapped the refresh token, and a kill before the save leaves a spent token in the store every omp shares). The
 * stop is the core's (`native/ompdesk/crates/core/src/sidecar/stop.rs`, whose Rust tests hold the parsing of the wait
 * line however the pipe cut it and the cap); this case keeps the real-process half of `omp-stop.test.ts`: a lane stops a
 * real omp that says on stderr what stock's exit says, and lets it finish.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import type { OmpResolution } from "./omp-runtime";
import { SidecarManager } from "./sidecar";
import { ANSWERS_COMMANDS, RM_TEMP, writeFakeOmp } from "./test-fake-omp";

/** The stop's grace in the core (`tuning.stopGraceMs`): short, so the wait past it is real but brief. */
const STOP_GRACE_MS = 300;

it("is not killed at the stop's bound while it says it waits to save, and ends by itself once it saved", async () => {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ompdesk-stop-hold-"));
	const gate = path.join(dir, "gate");
	const saved = path.join(dir, "saved");
	const asked = path.join(dir, "asked");
	const bin = await writeFakeOmp(
		dir,
		[
			`import * as fs from "node:fs";`,
			`let asked = false;`,
			`const stop = () => {`,
			`	if (asked) return;`,
			`	asked = true;`,
			`	fs.writeFileSync(${JSON.stringify(asked)}, "asked");`,
			`	fs.writeSync(2, "Waiting for the login refresh to finish saving (up to 120 s)…\\n");`,
			`	setInterval(() => {`,
			`		if (!fs.existsSync(${JSON.stringify(gate)})) return;`,
			`		fs.writeFileSync(${JSON.stringify(saved)}, "token");`,
			`		process.exit(0);`,
			`	}, 10);`,
			`};`,
			`process.on("SIGTERM", stop);`,
			`process.stdin.on("end", stop);`,
			`process.stdout.write(JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }) + "\\n");`,
			ANSWERS_COMMANDS,
		].join("\n"),
	);
	const omp = async (): Promise<OmpResolution> => ({
		ok: true,
		runtime: { bin, version: "18.6.1", run: async () => ({ code: 0, stdout: "", stderr: "" }) },
	});
	const sidecar = new SidecarManager({ omp, cwd: dir, tuning: { stopGraceMs: STOP_GRACE_MS } });
	try {
		const ready = Promise.withResolvers<void>();
		sidecar.on("status", ({ status }: { status: string }) => {
			if (status === "ready") ready.resolve();
		});
		sidecar.start();
		await ready.promise;
		const exited = sidecar.whenExited();
		let over = false;
		void exited.then(() => {
			over = true;
		});
		sidecar.dispose();
		// The omp has said what it waits for (the stand-in writes its stderr when asked); the lane read it.
		await vi.waitFor(async () => expect(await fs.readFile(asked, "utf8")).toBe("asked"));
		// A negative check, so it waits (no event says it was not killed): two graces past the ask, the shortest time
		// after which an omp that had not asked for time would have been killed.
		await delay(STOP_GRACE_MS * 2);
		expect(over).toBe(false);
		await fs.writeFile(gate, "");
		await exited;
		expect(await fs.readFile(saved, "utf8")).toBe("token");
	} finally {
		sidecar.dispose();
		await sidecar.whenExited();
		await fs.rm(dir, RM_TEMP);
	}
}, 30_000);
