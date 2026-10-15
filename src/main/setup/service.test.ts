import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SetupItemId, SetupPlatform, SetupPresence, SetupState } from "../../shared/setup";
import { RM_TEMP, writeFakeOmp } from "../test-fake-omp";
import type { Detection } from "./detect";
import type { DownloadFetch } from "./download";
import type { SpawnSpec } from "./plans";
import { SetupRunner, type SupervisedChild } from "./runner";
import { BACKOFF_MS, SetupService, type SetupServiceDeps } from "./service";

const present = (version = "1.0.0"): SetupPresence => ({ kind: "present", version, path: "/bin/x" });
const missing: SetupPresence = { kind: "missing" };

class FakeChild extends EventEmitter implements SupervisedChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = { end: () => this.close(130) };
	close(code: number): void {
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code);
	}
}

interface Machine {
	presence: Record<SetupItemId, SetupPresence>;
	brew: string | null;
	winget: string | null;
}

let dir: string;
beforeEach(async () => {
	dir = await mkdtemp(join(tmpdir(), "ompdesk-setup-service-"));
});
afterEach(async () => {
	await rm(dir, RM_TEMP);
});

/**
 * A service over a fake machine. Each install's outcome comes from `exits`
 * (default 0); a successful one makes the item present, as a real install would.
 * `hold` keeps that item's installer running until a cancel.
 */
function harness(
	machine: Machine,
	options: {
		platform?: SetupPlatform;
		automatic?: boolean;
		testInstaller?: string | null;
		exits?: Partial<Record<SetupItemId, number>>;
		stillMissing?: SetupItemId[];
		hold?: SetupItemId;
		now?: () => number;
		testDownload?: { url: string; sha256: string };
		fetch?: DownloadFetch;
		spawnEnv?: NodeJS.ProcessEnv;
		/** The version a successful install leaves behind (default 1.0.0). */
		installedVersion?: string;
		/** Where detection finds omp (default /home/u/.bun/bin/omp). */
		ompBin?: string;
	} = {},
) {
	const spawned: { spec: SpawnSpec; env: NodeJS.ProcessEnv }[] = [];
	const states: SetupState[] = [];
	const onOmpReady = vi.fn();
	const itemOf = (spec: SpawnSpec): SetupItemId => {
		const id = spec.args[0];
		if (id === "bun" || id === "omp" || id === "git" || id === "gh" || id === "node") return id;
		throw new Error(`unexpected spec ${JSON.stringify(spec)}`);
	};
	const runner = new SetupRunner((spec, env) => {
		spawned.push({ spec, env });
		const child = new FakeChild();
		const item = itemOf(spec);
		if (item !== options.hold) {
			setImmediate(() => {
				child.stdout.write(`installing ${item}\n`);
				const code = options.exits?.[item] ?? 0;
				if (code === 0 && !options.stillMissing?.includes(item))
					machine.presence[item] = present(options.installedVersion);
				setImmediate(() => child.close(code));
			});
		}
		return child;
	});
	const detect = async (): Promise<Detection> => ({
		presence: { ...machine.presence },
		bun: machine.presence.bun.kind === "present" ? "/home/u/.bun/bin/bun" : null,
		omp:
			machine.presence.omp.kind === "outdated" || machine.presence.omp.kind === "present"
				? (options.ompBin ?? "/home/u/.bun/bin/omp")
				: null,
		brew: machine.brew,
		winget: machine.winget,
	});
	const deps: SetupServiceDeps = {
		platform: options.platform ?? "darwin",
		arch: "arm64",
		systemRoot: "C:\\Windows",
		toolsDir: join(dir, "tools"),
		bunInstall: "/home/u/.bun",
		statePath: join(dir, "setup-state.json"),
		automatic: options.automatic ?? true,
		testInstaller: options.testInstaller === undefined ? "/fake/installer" : options.testInstaller,
		spawnEnv: async () => options.spawnEnv ?? { PATH: "/usr/bin" },
		onState: state => states.push(state),
		onOmpReady,
		detect,
		runner,
		refreshPath: async () => {},
		fetchText: async url => {
			throw new Error(`no network in tests: ${url}`);
		},
		fetch:
			options.fetch ??
			(async url => {
				throw new Error(`no network in tests: ${url}`);
			}),
		...(options.testDownload ? { testDownload: options.testDownload } : {}),
		...(options.now ? { now: options.now } : {}),
	};
	const service = new SetupService(deps);
	const phase = (id: SetupItemId) => service.state().items.find(item => item.id === id)?.phase;
	return { service, spawned, states, onOmpReady, phase, items: () => spawned.map(entry => itemOf(entry.spec)) };
}

function machine(partial: Partial<Record<SetupItemId, SetupPresence>>, managers: Partial<Machine> = {}): Machine {
	return {
		presence: {
			bun: present(),
			git: present(),
			omp: present("18.9.0"),
			gh: present(),
			node: present("v24.11.0"),
			...partial,
		},
		brew: "/opt/homebrew/bin/brew",
		winget: null,
		...managers,
	};
}

describe("SetupService", () => {
	it("installs Bun then omp on its own at launch, then reports omp ready once", async () => {
		const h = harness(machine({ bun: missing, omp: missing }));
		await h.service.start();
		expect(h.items()).toEqual(["bun", "omp"]);
		expect(h.spawned[0]?.spec).toEqual({ file: "/fake/installer", args: ["bun", "bun-script"], shell: false });
		expect(h.spawned[1]?.spec.args).toEqual(["omp", "bun-global"]);
		expect(h.spawned[0]?.env).toMatchObject({ PATH: "/usr/bin", BUN_INSTALL: "/home/u/.bun" });
		expect(h.service.state()).toMatchObject({ ompReady: true, requiredRunning: false, automatic: true });
		expect(h.phase("omp")).toBe("present");
		expect(h.onOmpReady).toHaveBeenCalledTimes(1);
		// The renderer saw the install run with its command and output.
		const running = h.states.find(state => state.items.find(item => item.id === "bun")?.phase === "running");
		expect(running?.requiredRunning).toBe(true);
		expect(running?.items.find(item => item.id === "bun")?.command).toBe("curl -fsSL https://bun.sh/install | bash");
		expect(h.states.at(-1)?.items.find(item => item.id === "bun")?.output).toContain("installing bun");
	});

	it("runs the real plan's process when no test installer is set", async () => {
		const h = harness(machine({ omp: { kind: "outdated", version: "18.0.0", minimum: "18.8.7", path: "/x" } }), {
			testInstaller: null,
		});
		// The fake spawner records the spec, then cannot map the real one to an item and fails the spawn.
		await h.service.start();
		expect(h.spawned.map(entry => entry.spec)).toEqual([
			{ file: "/home/u/.bun/bin/omp", args: ["update"], shell: false },
		]);
		expect(h.service.state().items.find(item => item.id === "omp")?.failure).toMatchObject({ reason: "spawn" });
	});

	it("skips present items and installs nothing when automatic setup is off", async () => {
		const h = harness(machine({ gh: missing }), { automatic: false });
		await h.service.start();
		expect(h.spawned).toEqual([]);
		expect(h.phase("gh")).toBe("idle");
		expect(h.phase("bun")).toBe("present");
		expect(h.onOmpReady).not.toHaveBeenCalled();
	});

	it("installs missing optional items in the background after the required ones, skipping present ones", async () => {
		const h = harness(machine({ omp: missing, git: missing, node: missing }));
		await h.service.start();
		expect(h.items()).toEqual(["omp", "git", "node"]);
		expect(h.spawned[1]?.spec.args).toEqual(["git", "xcode-select"]);
		expect(h.spawned[2]?.spec.args).toEqual(["node", "brew"]);
		expect(h.onOmpReady).toHaveBeenCalledTimes(1);
	});

	it("leaves the Xcode tools to macOS's dialog and says so", async () => {
		const h = harness(machine({ git: missing }), { stillMissing: ["git"] });
		await h.service.start();
		expect(h.phase("git")).toBe("requested");
		expect(h.service.state().items.find(item => item.id === "git")?.prompt).toBe("dialog");
	});

	it("reports a failure with its exit code, does not try omp without Bun, and does not retry on its own", async () => {
		const exits: Partial<Record<SetupItemId, number>> = { bun: 6 };
		const h = harness(machine({ bun: missing, omp: missing, gh: missing }), { exits });
		await h.service.start();
		expect(h.items()).toEqual(["bun"]);
		const state = h.service.state();
		expect(state.items.find(item => item.id === "bun")).toMatchObject({
			phase: "failed",
			failure: { reason: "exit", exitCode: 6, detail: "installing bun" },
		});
		expect(state.items.find(item => item.id === "omp")).toMatchObject({
			phase: "failed",
			failure: { reason: "prerequisite" },
		});
		// Optional items wait until omp works.
		expect(h.phase("gh")).toBe("idle");
		expect(h.onOmpReady).not.toHaveBeenCalled();
		// A second start in the same launch attempts nothing.
		await h.service.start();
		expect(h.items()).toEqual(["bun"]);
		// The user's retry does, and on success the optional ones follow.
		delete exits.bun;
		await h.service.retry("omp");
		expect(h.items()).toEqual(["bun", "bun", "omp", "gh"]);
		expect(h.onOmpReady).toHaveBeenCalledTimes(1);
	});

	it("calls an install that ends without the item a failure", async () => {
		const h = harness(machine({ omp: missing }), { stillMissing: ["omp"] });
		await h.service.start();
		expect(h.service.state().items.find(item => item.id === "omp")?.failure).toEqual({ reason: "not-detected" });
	});

	it("cancels the running install and the rest of its pipeline, as cancelled", async () => {
		const h = harness(machine({ bun: missing, omp: missing }), { hold: "bun" });
		const run = h.service.start();
		await vi.waitFor(() => expect(h.phase("bun")).toBe("running"));
		expect(h.phase("omp")).toBe("queued");
		expect(h.service.cancel()).toBe(true);
		await run;
		expect(h.items()).toEqual(["bun"]);
		expect(h.service.state().items.find(item => item.id === "bun")).toMatchObject({
			phase: "cancelled",
			failure: null,
		});
		expect(h.phase("omp")).toBe("idle");
		expect(h.service.state().requiredRunning).toBe(false);
		expect(h.service.cancel()).toBe(false);
	});

	it("kills the running install on dispose and starts nothing after it", async () => {
		const h = harness(machine({ bun: missing, omp: missing }), { hold: "bun" });
		const run = h.service.start();
		await vi.waitFor(() => expect(h.phase("bun")).toBe("running"));
		h.service.dispose();
		await run;
		await h.service.retry("bun");
		expect(h.items()).toEqual(["bun"]);
	});

	it("backs off after three automatic misses for a day, but a retry always runs", async () => {
		let now = 1_000_000;
		await writeFile(join(dir, "setup-state.json"), JSON.stringify({ gh: { failures: 3, lastAttempt: now - 1000 } }));
		const h = harness(machine({ gh: missing }), { now: () => now });
		await h.service.start();
		expect(h.spawned).toEqual([]);
		expect(h.phase("gh")).toBe("backoff");
		now += BACKOFF_MS;
		const later = harness(machine({ gh: missing }), { now: () => now, exits: { gh: 1 } });
		await later.service.start();
		expect(later.items()).toEqual(["gh"]);
		expect(JSON.parse(await readFile(join(dir, "setup-state.json"), "utf8"))).toEqual({
			gh: { failures: 4, lastAttempt: now },
		});
		await later.service.retry("gh");
		expect(later.items()).toEqual(["gh", "gh"]);
	});

	it("forgets the misses once the item is found", async () => {
		await writeFile(join(dir, "setup-state.json"), JSON.stringify({ node: { failures: 2, lastAttempt: 1 } }));
		const h = harness(machine({}));
		await h.service.start();
		expect(JSON.parse(await readFile(join(dir, "setup-state.json"), "utf8"))).toEqual({});
	});

	it("requires Git on Windows (before omp) and marks optional items without winget unavailable", async () => {
		const h = harness(
			machine({ bun: missing, git: missing, omp: missing, gh: missing, node: missing }, { brew: null }),
			{
				platform: "win32",
			},
		);
		await h.service.start();
		expect(h.items()).toEqual(["bun", "git", "omp"]);
		expect(h.spawned[1]?.spec.args).toEqual(["git", "portable-git"]);
		const state = h.service.state();
		expect(state.items.filter(item => item.required).map(item => item.id)).toEqual(["bun", "git", "omp"]);
		expect(h.phase("gh")).toBe("unavailable");
		expect(h.phase("node")).toBe("unavailable");
	});

	it("starts Windows installers without an inherited PSModulePath, so Windows PowerShell builds its own", async () => {
		const h = harness(machine({ bun: missing, git: present(), omp: present("18.9.0") }), {
			platform: "win32",
			spawnEnv: {
				Path: "C:\\Windows\\System32",
				PSModulePath:
					"C:\\Program Files\\PowerShell\\7\\Modules;C:\\Windows\\system32\\WindowsPowerShell\\v1.0\\Modules",
			},
		});
		await h.service.start();
		expect(h.items()).toEqual(["bun"]);
		expect(h.spawned[0]?.env).toEqual({ Path: "C:\\Windows\\System32", BUN_INSTALL: "/home/u/.bun" });
	});

	it("installs gh and Node from verified archives on a Mac without Homebrew", async () => {
		const h = harness(machine({ gh: missing }, { brew: null }), { testInstaller: null });
		await h.service.start();
		// The release lookup failed (no network here): a download failure, nothing spawned.
		expect(h.spawned).toEqual([]);
		expect(h.service.state().items.find(item => item.id === "gh")).toMatchObject({
			phase: "failed",
			method: "archive",
			failure: { reason: "download" },
		});
	});

	it("numbers each install in its run and stamps when it started, then clears that once it ended", async () => {
		const h = harness(machine({ omp: missing, gh: missing, node: missing }), { now: () => 5000 });
		await h.service.start();
		const progressWhileRunning = (id: SetupItemId) =>
			h.states.map(state => state.items.find(item => item.id === id)).find(item => item?.phase === "running")
				?.progress;
		// omp is the required run's only install; gh and Node are the background run's two.
		expect(progressWhileRunning("omp")).toEqual({ step: 1, steps: 1, startedAt: 5000, download: null });
		expect(progressWhileRunning("gh")).toEqual({ step: 1, steps: 2, startedAt: 5000, download: null });
		expect(progressWhileRunning("node")).toEqual({ step: 2, steps: 2, startedAt: 5000, download: null });
		expect(h.service.state().items.map(item => item.progress)).toEqual([null, null, null, null, null]);
	});

	it("downloads a plan's file itself with byte progress before its installer runs, then removes it", async () => {
		const a = new Uint8Array(3000).fill(1);
		const b = new Uint8Array(1000).fill(2);
		const sha256 = createHash("sha256")
			.update(new Uint8Array([...a, ...b]))
			.digest("hex");
		const rest = Promise.withResolvers<void>();
		const requested: string[] = [];
		const fetch: DownloadFetch = async url => {
			requested.push(url);
			let pulls = 0;
			const body = new ReadableStream<Uint8Array>({
				async pull(controller) {
					pulls += 1;
					if (pulls === 1) return controller.enqueue(a);
					await rest.promise;
					controller.enqueue(b);
					controller.close();
				},
			});
			return new Response(body, { headers: { "content-length": "4000" } });
		};
		const h = harness(machine({ omp: missing }), {
			testDownload: { url: "https://example.test/omp.bin", sha256 },
			fetch,
			hold: "omp",
		});
		const run = h.service.start();
		const omp = () => h.service.state().items.find(item => item.id === "omp");
		await vi.waitFor(() => expect(omp()?.progress?.download).toEqual({ received: 3000, total: 4000 }));
		expect(omp()).toMatchObject({ phase: "running", progress: { step: 1, steps: 1 } });
		expect(h.spawned).toEqual([]);
		rest.resolve();
		// The installer runs only once the file is complete and verified.
		await vi.waitFor(() => expect(h.items()).toEqual(["omp"]));
		expect(omp()?.progress).toMatchObject({ step: 1, steps: 1, download: null });
		const file = join(dir, "tools", ".downloads", "test-download");
		expect(existsSync(file)).toBe(true);
		expect(requested).toEqual(["https://example.test/omp.bin"]);
		h.service.cancel();
		await run;
		expect(existsSync(file)).toBe(false);
	});

	it("fails a download that answers an error or does not match its SHA-256, without running anything", async () => {
		const respond = (status: number) => async () => new Response("bytes", { status });
		const refused = harness(machine({ omp: missing }), {
			testDownload: { url: "https://example.test/omp.bin", sha256: "0".repeat(64) },
			fetch: respond(404),
		});
		await refused.service.start();
		expect(refused.spawned).toEqual([]);
		expect(refused.service.state().items.find(item => item.id === "omp")).toMatchObject({
			phase: "failed",
			progress: null,
			failure: { reason: "download", detail: "https://example.test/omp.bin answered 404" },
		});
		const tampered = harness(machine({ omp: missing }), {
			testDownload: { url: "https://example.test/omp.bin", sha256: "0".repeat(64) },
			fetch: respond(200),
		});
		await tampered.service.start();
		expect(tampered.spawned).toEqual([]);
		expect(tampered.service.state().items.find(item => item.id === "omp")).toMatchObject({
			phase: "failed",
			failure: { reason: "checksum", detail: expect.stringMatching(/^SHA-256 mismatch: expected 0{64}, got /) },
		});
	});

	it("cancels a running download as cancelled, and runs nothing after it", async () => {
		const fetch: DownloadFetch = async (_url, init) => {
			const body = new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(new Uint8Array(10));
					init.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
				},
			});
			return new Response(body, { headers: { "content-length": "100" } });
		};
		const h = harness(machine({ bun: missing, omp: missing }), {
			testDownload: { url: "https://example.test/x", sha256: "0".repeat(64) },
			fetch,
		});
		const run = h.service.start();
		await vi.waitFor(() =>
			expect(h.service.state().items.find(item => item.id === "bun")?.progress?.download?.received).toBe(10),
		);
		expect(h.service.cancel()).toBe(true);
		await run;
		expect(h.spawned).toEqual([]);
		expect(h.service.state().items.find(item => item.id === "bun")).toMatchObject({
			phase: "cancelled",
			failure: null,
			progress: null,
		});
		expect(h.phase("omp")).toBe("idle");
	});

	it("refuses an unknown item id", async () => {
		const h = harness(machine({}));
		await expect(h.service.retry("rm -rf /")).rejects.toThrow(/Unknown setup item/);
		await expect(h.service.retry(undefined)).rejects.toThrow(/Unknown setup item/);
		expect(h.spawned).toEqual([]);
	});

	describe("updateOmp", () => {
		it("runs the omp-update plan under the supervisor after the pre-install hook, without touching the ledger or announcing omp ready", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { installedVersion: "18.9.0" });
			const order: string[] = [];
			const outcome = await h.service.updateOmp("18.9.0", async () => {
				order.push(`hook (spawned ${h.spawned.length})`);
			});
			expect(outcome).toEqual({ kind: "updated", version: "18.9.0" });
			expect(order).toEqual(["hook (spawned 0)"]);
			expect(h.spawned.map(entry => entry.spec.args)).toEqual([["omp", "omp-update"]]);
			const omp = h.service.state().items.find(item => item.id === "omp");
			expect(omp).toMatchObject({ phase: "present", method: "omp-update", progress: null, failure: null });
			expect(omp?.presence).toMatchObject({ kind: "present", version: "18.9.0" });
			expect(h.states.some(state => state.items.find(item => item.id === "omp")?.phase === "running")).toBe(true);
			expect(h.onOmpReady).not.toHaveBeenCalled();
			expect(existsSync(join(dir, "setup-state.json"))).toBe(false);
		});

		it("runs stock `omp update` on the detected omp when no test installer is set", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { testInstaller: null });
			// The fake spawner records the spec, then cannot map the real one to an item and fails the spawn.
			const outcome = await h.service.updateOmp("18.9.0");
			expect(h.spawned.map(entry => entry.spec)).toEqual([
				{ file: "/home/u/.bun/bin/omp", args: ["update"], shell: false },
			]);
			expect(outcome).toMatchObject({ kind: "failed", failure: { reason: "install" } });
		});

		it("reports a failing installer with its exit code and last output, and leaves omp as it was", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { exits: { omp: 1 } });
			const outcome = await h.service.updateOmp("18.9.0");
			expect(outcome).toEqual({
				kind: "failed",
				failure: { reason: "install", detail: "exit 1 — installing omp" },
			});
			const omp = h.service.state().items.find(item => item.id === "omp");
			expect(omp?.phase).toBe("present");
			expect(omp?.presence).toMatchObject({ kind: "present", version: "18.8.7" });
		});

		it("calls a clean exit that leaves omp older than the announced version a failure", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { stillMissing: ["omp"] });
			const outcome = await h.service.updateOmp("18.9.0");
			expect(outcome).toMatchObject({ kind: "failed", failure: { reason: "not-updated" } });
		});

		it("skips when omp is missing (the install pipeline owns that) without running the hook", async () => {
			const h = harness(machine({ omp: missing }));
			const hook = vi.fn(async () => {});
			expect(await h.service.updateOmp("18.9.0", hook)).toEqual({ kind: "skipped" });
			expect(hook).not.toHaveBeenCalled();
			expect(h.spawned).toEqual([]);
		});

		it("skips on a platform without setup", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { platform: "other" });
			expect(await h.service.updateOmp("18.9.0")).toEqual({ kind: "skipped" });
			expect(h.spawned).toEqual([]);
		});

		it("a cancel from This computer ends the update as cancelled", async () => {
			const h = harness(machine({ omp: present("18.8.7") }), { hold: "omp" });
			const run = h.service.updateOmp("18.9.0");
			await vi.waitFor(() => expect(h.phase("omp")).toBe("running"));
			expect(h.service.cancel()).toBe(true);
			expect(await run).toEqual({ kind: "failed", failure: { reason: "cancelled" } });
			expect(h.phase("omp")).toBe("present");
		});

		it("runs `omp update` with the detected omp's folder first on PATH, so stock updates that omp", async () => {
			const ownDir = join("/home/u", ".bun", "bin");
			const h = harness(machine({ omp: present("18.8.7") }), {
				installedVersion: "18.9.0",
				ompBin: join(ownDir, "omp"),
				spawnEnv: { PATH: ["/usr/local/bin", ownDir, "/usr/bin"].join(delimiter) },
			});
			await h.service.updateOmp("18.9.0");
			const entries = h.spawned[0]?.env.PATH?.split(delimiter) ?? [];
			expect(entries.slice(0, 3)).toEqual([ownDir, "/usr/local/bin", "/usr/bin"]);
			expect(entries.filter(entry => entry === ownDir)).toHaveLength(1);
		});
	});

	describe("latestOmp", () => {
		async function checkingOmp(script: string) {
			const log = join(dir, "check.log");
			const omp = await writeFakeOmp(
				dir,
				`import { appendFileSync } from "node:fs";
appendFileSync(process.env.CHECK_LOG, JSON.stringify({ args: process.argv.slice(2), first: (process.env.PATH ?? "").split(${JSON.stringify(delimiter)})[0], noColor: process.env.NO_COLOR }) + "\\n");
${script}`,
			);
			const h = harness(machine({ omp: present("18.8.7") }), {
				automatic: false,
				ompBin: omp,
				spawnEnv: { ...process.env, CHECK_LOG: log },
			});
			await h.service.start();
			const calls = async () =>
				(await readFile(log, "utf8"))
					.split("\n")
					.filter(Boolean)
					.map(line => JSON.parse(line) as { args: string[]; first: string; noColor?: string });
			return { h, omp, calls };
		}

		it("is stock `omp update --check` on the detected omp, with that omp's folder first on PATH", async () => {
			const { h, omp, calls } = await checkingOmp(
				`console.log("Current version: 18.8.7\\nNew version available: 18.9.0");`,
			);
			await expect(h.service.latestOmp()).resolves.toBe("18.9.0");
			expect(await calls()).toEqual([{ args: ["update", "--check"], first: dirname(omp), noColor: "1" }]);
		});

		it("answers the installed version when stock says it is up to date", async () => {
			const { h } = await checkingOmp(`console.log("Current version: 18.8.7\\n✔ Already up to date");`);
			await expect(h.service.latestOmp()).resolves.toBe("18.8.7");
		});

		it("rejects with stock's own reason when the check fails, and while omp is missing", async () => {
			const { h } = await checkingOmp(
				`console.log("Current version: 18.8.7");
console.error("Failed to check for updates: 401 Unauthorized; check the registry credentials in your .npmrc");
process.exit(1);`,
			);
			await expect(h.service.latestOmp()).rejects.toThrow(/401 Unauthorized; check the registry credentials/);
			const none = harness(machine({ omp: missing }), { automatic: false });
			await none.service.start();
			await expect(none.service.latestOmp()).rejects.toThrow("omp is not installed");
		});
	});
});
