import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { AI_MEMORY_VERSION, type AiMemoryState } from "../../shared/ai-memory";
import type { SpawnSpec } from "../setup/plans";
import { SetupRunner, type SupervisedChild } from "../setup/runner";
import { SUPERVISOR_STOPPED_CODE } from "../setup/supervisor";
import { RM_TEMP } from "../test-fake-omp";
import { AiMemoryClient } from "./client";
import { AiMemoryService, type AiMemoryServiceDeps, EXTENSION_FILE, MCP_FILE, parsePlan, parseProblems } from "./service";

const BIN = "/fake/bin/ai-memory";
const SERVER = "http://127.0.0.1:50123";
const HANG = Symbol("hang");
/** What ai-memory's `init` writes: its template, with the embedding opt-out as a comment. */
const INIT_CONFIG = 'bind = "127.0.0.1:50123"\n# embedding_provider = "none"   # template\n';

interface Result {
	code: number;
	output?: string;
}
interface Call {
	file: string;
	args: string[];
	cwd: string | undefined;
	shell: boolean;
}

class FakeChild extends EventEmitter implements SupervisedChild {
	readonly stdout = new PassThrough();
	readonly stderr = new PassThrough();
	readonly stdin = { end: vi.fn(() => this.finish(SUPERVISOR_STOPPED_CODE, "")) };
	finish(code: number, output: string): void {
		this.stdout.write(output);
		this.stdout.end();
		this.stderr.end();
		this.emit("close", code);
	}
}

/** Everything one test needs: temp agent/data/home dirs, a scripted `ai-memory`, a fake server and the service. */
interface Behavior {
	/** Whether `setup --yes` really leaves the files behind. */
	wire: boolean;
	setup: () => Result;
	init: () => Result;
	uninstall: (args: string[]) => Result;
	/** Whether a successful uninstall stops the server (`/healthz` stops answering until the next setup). */
	stopsServer: boolean;
	plan: () => Result;
	/** A command's own hook, run before it answers (a hang, a spawn error). */
	gate: ((args: string[]) => Promise<GateResult | undefined>) | undefined;
}

interface World {
	root: string;
	agentDir: string;
	dataDir: string;
	home: string;
	toolsDir: string;
	calls: Call[];
	commands: () => string[];
	behavior: Behavior;
	health: { up: boolean; healthCalls: number; stopped: boolean };
	state: { enabled: boolean };
	states: AiMemoryState[];
	persistEnabled: Mock<(enabled: boolean) => void>;
	clock: { now: number };
	service: AiMemoryService;
}

async function world(overrides: Partial<AiMemoryServiceDeps> = {}): Promise<World> {
	const root = await mkdtemp(join(tmpdir(), "ai-memory-service-"));
	const agentDir = join(root, "agent");
	const dataDir = join(root, "data");
	const home = join(root, "home");
	const toolsDir = join(root, "tools");
	await Promise.all([agentDir, join(dataDir, "auth-tokens"), home].map(dir => mkdir(dir, { recursive: true })));
	await writeFile(join(dataDir, "auth-tokens", "default"), "tok\n");
	await writeFile(join(agentDir, "config.yml"), "theme: dark\n");

	const calls: Call[] = [];
	const behavior: Behavior = {
		/** Whether `setup --yes` really leaves the files behind. */
		wire: true,
		setup: (): Result => ({ code: 0, output: "setup done\n" }),
		init: (): Result => ({ code: 0, output: "initialized\n" }),
		uninstall: (_args: string[]): Result => ({ code: 0, output: "removed\n" }),
		stopsServer: true,
		plan: (): Result => ({
			code: 0,
			output: `INFO ai_memory: plan\n${JSON.stringify({
				format: 1,
				data_dir: dataDir,
				config_path: join(dataDir, "config.toml"),
				fresh: !existsSync(join(dataDir, "config.toml")),
				service: { action: "install", manager: "launchd", path: "/x.plist" },
				agents: [{ agent: "omp", found: null, wiring: "mcp+hooks+skills" }],
			})}\n`,
		}),
		/** A command's own hook, run before it answers (a hang, a spawn error). */
		gate: undefined,
	};
	const health = { up: true, healthCalls: 0, stopped: false };

	const spawner = (spec: SpawnSpec, _env: NodeJS.ProcessEnv, cwd?: string): SupervisedChild => {
		const child = new FakeChild();
		calls.push({ file: spec.file, args: spec.args, cwd, shell: spec.shell });
		setImmediate(async () => {
			const gated = await behavior.gate?.(spec.args);
			if (gated === HANG) return;
			if (gated === "spawn-error") {
				child.emit("error", new Error("EACCES"));
				return;
			}
			if (gated) {
				child.finish(gated.code, gated.output ?? "");
				return;
			}
			const [verb] = spec.args;
			let result: Result;
			if (verb === "init") {
				result = behavior.init();
				if (result.code === 0) await writeFile(join(dataDir, "config.toml"), INIT_CONFIG);
			} else if (verb === "setup" && spec.args.includes("--plan")) result = behavior.plan();
			else if (verb === "setup") {
				result = behavior.setup();
				if (health.stopped) {
					health.up = true;
					health.stopped = false;
				}
				if (behavior.wire) {
					await mkdir(join(agentDir, "extensions"), { recursive: true });
					await writeFile(join(agentDir, EXTENSION_FILE), "// generated\n");
					await writeFile(
						join(agentDir, MCP_FILE),
						JSON.stringify({ mcpServers: { "ai-memory": { command: spec.file, args: ["mcp-bridge"] } } }),
					);
				}
				if (!existsSync(join(dataDir, "config.toml"))) {
					await writeFile(join(dataDir, "config.toml"), 'bind = "127.0.0.1:50123"\n');
				}
			} else {
				result = behavior.uninstall(spec.args);
				if (result.code === 0 && behavior.stopsServer) {
					health.up = false;
					health.stopped = true;
				}
				if (result.code === 0) {
					await rm(join(agentDir, EXTENSION_FILE), { force: true });
					await rm(join(agentDir, MCP_FILE), { force: true });
				}
			}
			child.finish(result.code, result.output ?? "");
		});
		return child;
	};

	const client = new AiMemoryClient({
		url: () => SERVER,
		dataDir: () => dataDir,
		fetch: async url => {
			if (url.endsWith("/healthz")) {
				health.healthCalls += 1;
				return new Response(health.up ? "ok" : "down", { status: health.up ? 200 : 503 });
			}
			if (url.endsWith("/admin/status")) {
				return Response.json({
					version: "3.1.1",
					counts: { pages_latest: 4, sessions: 2, observations: 30 },
					storage: { database_bytes: 2048 },
				});
			}
			throw new TypeError("unexpected request");
		},
	});

	const state = { enabled: true };
	const states: AiMemoryState[] = [];
	const persistEnabled = vi.fn((enabled: boolean) => {
		state.enabled = enabled;
	});
	const clock = { now: 1_800_000_000_000 };
	const service = new AiMemoryService({
		platform: "darwin",
		arch: "arm64",
		automatic: true,
		toolsDir,
		bundledDir: null,
		binaryOverride: BIN,
		home,
		agentDir: () => agentDir,
		enabled: () => state.enabled,
		persistEnabled,
		spawnEnv: async () => ({ PATH: "" }),
		onState: snapshot => states.push(snapshot),
		runner: new SetupRunner(spawner),
		client,
		healthWaitMs: 0,
		pollMs: 10,
		now: () => clock.now,
		...overrides,
	});
	const commands = () => calls.map(call => call.args.join(" "));
	return { root, agentDir, dataDir, home, toolsDir, calls, commands, behavior, health, state, states, persistEnabled, clock, service };
}

type GateResult = Result | typeof HANG | "spawn-error";

const SETUP = "setup --yes --agent omp";
const PLAN = "setup --plan --json --agent omp";
const INIT = "init";

describe("AiMemoryService", () => {
	let w: World | undefined;
	const make = async (overrides?: Partial<AiMemoryServiceDeps>) => (w = await world(overrides));

	afterEach(async () => {
		w?.service.dispose();
		if (w) await rm(w.root, RM_TEMP);
		w = undefined;
	});

	describe("pure parsers", () => {
		it("parseProblems reads only `problem:` lines", () => {
			expect(parseProblems("ok\n  problem: self-check: healthz did not answer\r\nINFO x\nproblem: config: bad\n")).toEqual([
				"self-check: healthz did not answer",
				"config: bad",
			]);
			expect(parseProblems("nothing")).toEqual([]);
		});

		it("parsePlan skips a leading log line and reads data_dir and config_path", () => {
			expect(
				parsePlan('INFO a {b}\n{"format":1,"data_dir":"/d","config_path":"/d/config.toml","fresh":true}\n'),
			).toEqual({ dataDir: "/d", configPath: "/d/config.toml", fresh: true });
			expect(parsePlan('{"format":1,"fresh":false}')).toMatchObject({ fresh: false });
			expect(parsePlan("no json")).toBeNull();
			expect(parsePlan("{broken")).toBeNull();
			expect(parsePlan('{"format":1}')).toEqual({ dataDir: null, configPath: null, fresh: false });
		});
	});

	describe("start when on", () => {
		it("stages, wires with ai-memory's own commands in order, checks and becomes ready", async () => {
			const { service, commands, calls, states, home, dataDir, agentDir } = await make();
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, SETUP]);
			for (const call of calls) {
				expect(call.file).toBe(BIN);
				expect(call.shell).toBe(false);
				// A neutral working directory: ai-memory reads cwd as "this project".
				expect(call.cwd).toBe(home);
			}
			const steps = states
				.filter(snapshot => snapshot.phase === "starting" || snapshot.phase === "ready")
				.map(snapshot => `${snapshot.phase}:${snapshot.step}`)
				.filter((step, index, all) => step !== all[index - 1]);
			expect(steps).toEqual(["starting:stage", "starting:wire", "starting:check", "ready:null"]);
			expect(service.state()).toMatchObject({
				enabled: true,
				phase: "ready",
				step: null,
				source: "bundled",
				binary: BIN,
				dataDir,
				serverUrl: SERVER,
				webUrl: `${SERVER}/web`,
				wiring: { extension: true, mcp: true },
				stats: { pages: 4, sessions: 2, observations: 30, diskBytes: 2048 },
				detail: null,
				version: "3.1.1",
			});
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
		});

		it("waits for beforeStart before the first command", async () => {
			const gate = Promise.withResolvers<void>();
			const { service, commands } = await make({ beforeStart: () => gate.promise });
			const started = service.start();
			await vi.waitFor(() => expect(service.state().phase).toBe("starting"));
			// The first command would be spawned on the next macrotask; none was.
			const { promise: turn, resolve: next } = Promise.withResolvers<void>();
			setImmediate(next);
			await turn;
			expect(commands()).toEqual([]);
			gate.resolve();
			await started;
			expect(commands()).toEqual([PLAN, INIT, SETUP]);
		});

		it("passes --no-service to setup only", async () => {
			const { service, commands } = await make({ noService: true });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, `${SETUP} --no-service`]);
		});

		it("a fresh data dir runs ai-memory's own init and opts out of the local embedding model before setup", async () => {
			const { service, commands, dataDir } = await make();
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, SETUP]);
			const config = await readFile(join(dataDir, "config.toml"), "utf8");
			expect(config).toMatch(/^embedding_provider = "none"/m);
			expect(config).not.toMatch(/^# embedding_provider/m);
		});

		it("an existing config is never touched: no init, no edit", async () => {
			const { service, commands, dataDir } = await make();
			await mkdir(dataDir, { recursive: true });
			const mine = 'bind = "127.0.0.1:50123"\n# embedding_provider = "none"  # the user left hybrid search on\n';
			await writeFile(join(dataDir, "config.toml"), mine);
			await service.start();
			expect(commands()).toEqual([PLAN, SETUP]);
			expect(await readFile(join(dataDir, "config.toml"), "utf8")).toBe(mine);
		});

		it("a failing init fails the step with its text and never runs setup", async () => {
			const { service, behavior, commands } = await make();
			behavior.init = () => ({ code: 1, output: "cannot create the data dir\n" });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT]);
			expect(service.state()).toMatchObject({ phase: "failed", detail: "init failed: cannot create the data dir" });
		});

		it("a server that never answers leaves memory wired but unreachable", async () => {
			const { service, health } = await make();
			health.up = false;
			await service.start();
			expect(service.state()).toMatchObject({
				phase: "unreachable",
				detail: "The server does not answer yet.",
				wiring: { extension: true, mcp: true },
			});
		});
	});

	describe("setup problems", () => {
		it("a lone self-check problem is not fatal: a healthy server makes it ready", async () => {
			const { service, behavior } = await make();
			behavior.setup = () => ({ code: 1, output: "problem: self-check: healthz did not answer\n" });
			await service.start();
			expect(service.state().phase).toBe("ready");
		});

		it("a lone self-check problem with a server that stays down is unreachable, not failed", async () => {
			const { service, behavior, health } = await make();
			health.up = false;
			behavior.setup = () => ({ code: 1, output: "problem: self-check: healthz did not answer\n" });
			await service.start();
			expect(service.state().phase).toBe("unreachable");
		});

		it("any other problem fails with its text, even beside a self-check one", async () => {
			const { service, behavior } = await make();
			behavior.setup = () => ({
				code: 1,
				output: "problem: self-check: healthz did not answer\nproblem: config: cannot write /data\n",
			});
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed", detail: "setup failed: config: cannot write /data" });
		});

		it("a non-zero exit with no problem line fails with the output's tail, without log lines", async () => {
			const { service, behavior } = await make();
			behavior.setup = () => ({ code: 2, output: "INFO starting\nboom\n" });
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed", detail: "setup failed: boom" });
		});

		it("a setup that leaves no extension fails and names the agent dir", async () => {
			const { service, behavior, agentDir } = await make();
			behavior.wire = false;
			await service.start();
			expect(service.state()).toMatchObject({
				phase: "failed",
				detail: `setup finished but omp's extension is not in ${agentDir}`,
				wiring: { extension: false, mcp: false },
			});
		});

		it("a setup that leaves an extension but no MCP entry names the MCP entry", async () => {
			const { service, behavior, agentDir } = await make();
			behavior.wire = false;
			behavior.setup = () => ({ code: 0 });
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await writeFile(join(agentDir, EXTENSION_FILE), "// there\n");
			await service.start();
			expect(service.state().detail).toBe(`setup finished but omp's MCP entry is not in ${agentDir}`);
		});

		it("a binary that cannot start is a failure with its own message", async () => {
			const { service, behavior } = await make();
			behavior.gate = async () => "spawn-error";
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed" });
			expect(service.state().detail).toContain("ai-memory could not start");
		});

		it("a failed state is retried by retry()", async () => {
			const { service, behavior, commands } = await make();
			behavior.wire = false;
			await service.start();
			expect(service.state().phase).toBe("failed");
			behavior.wire = true;
			await service.retry();
			expect(service.state().phase).toBe("ready");
			expect(commands()).toEqual([PLAN, INIT, SETUP, PLAN, SETUP]);
		});
	});

	describe("off, on and purge", () => {
		it("off runs `uninstall --apply --yes`, persists first, and removes nothing else", async () => {
			const { service, commands, persistEnabled, agentDir, dataDir, state } = await make();
			await service.start();
			await service.setEnabled(false);
			expect(persistEnabled).toHaveBeenCalledWith(false);
			expect(state.enabled).toBe(false);
			expect(commands()).toEqual([PLAN, INIT, SETUP, "uninstall --apply --yes"]);
			expect(service.state()).toMatchObject({
				enabled: false,
				phase: "off",
				step: null,
				stats: null,
				wiring: { extension: false, mcp: false },
			});
			// Not OMPdesk's to delete: omp's own config and ai-memory's data stay.
			expect(await readFile(join(agentDir, "config.yml"), "utf8")).toBe("theme: dark\n");
			expect(existsSync(join(dataDir, "auth-tokens", "default"))).toBe(true);
		});

		it("on again wires again", async () => {
			const { service, commands } = await make();
			await service.start();
			await service.setEnabled(false);
			await service.setEnabled(true);
			expect(commands()).toEqual([PLAN, INIT, SETUP, "uninstall --apply --yes", PLAN, SETUP]);
			expect(service.state()).toMatchObject({ enabled: true, phase: "ready", wiring: { extension: true, mcp: true } });
		});

		it("a stored `false` at launch starts off and runs no command", async () => {
			const { service, commands, state } = await make();
			state.enabled = false;
			await service.start();
			expect(commands()).toEqual([]);
			expect(service.state()).toMatchObject({ enabled: false, phase: "off" });
		});

		it("a failing uninstall puts the service in failed with the output", async () => {
			const { service, behavior } = await make();
			await service.start();
			behavior.uninstall = () => ({ code: 1, output: "could not stop the service\n" });
			await expect(service.setEnabled(false)).rejects.toThrow("Turning memory off failed: could not stop the service");
			expect(service.state()).toMatchObject({ phase: "failed", detail: "Turning memory off failed: could not stop the service" });
		});

		async function seedData(dataDir: string): Promise<void> {
			for (const folder of ["wiki", "db", "raw"]) {
				await mkdir(join(dataDir, folder), { recursive: true });
				await writeFile(join(dataDir, folder, "x"), "data");
			}
		}

		it("purge uninstalls, deletes wiki/db/raw itself once the server is gone, then wires again", async () => {
			const { service, commands, dataDir } = await make();
			await service.start();
			await seedData(dataDir);
			await service.purge();
			// Never `--purge-data`: ai-memory refuses it while any live omp session runs an mcp-bridge.
			expect(commands()).toEqual([PLAN, INIT, SETUP, "uninstall --apply --yes", PLAN, SETUP]);
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(join(dataDir, folder))).toBe(false);
			// The config and the token are not memory.
			expect(existsSync(join(dataDir, "config.toml"))).toBe(true);
			expect(existsSync(join(dataDir, "auth-tokens", "default"))).toBe(true);
			expect(service.state()).toMatchObject({ enabled: true, phase: "ready" });
		});

		it("a server that still answers after the uninstall deletes nothing and fails the purge; memory stays on", async () => {
			const { service, behavior, commands, dataDir } = await make();
			await service.start();
			await seedData(dataDir);
			behavior.stopsServer = false;
			await expect(service.purge()).rejects.toThrow("An ai-memory server still answers");
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(join(dataDir, folder))).toBe(true);
			expect(commands()).toEqual([PLAN, INIT, SETUP, "uninstall --apply --yes", PLAN, SETUP]);
			expect(service.state()).toMatchObject({ enabled: true, phase: "ready", detail: null });
		});

		it("a purge before the data directory is known deletes nothing", async () => {
			const { service, commands, state } = await make();
			state.enabled = false;
			await service.start();
			await expect(service.purge()).rejects.toThrow("data directory is not known");
			expect(commands()).toEqual(["uninstall --apply --yes"]);
		});

		it("a failing uninstall during a purge surfaces its text and wipes nothing", async () => {
			const { service, behavior, dataDir } = await make();
			await service.start();
			await seedData(dataDir);
			behavior.uninstall = () => ({ code: 1, output: "could not stop the service\n" });
			await expect(service.purge()).rejects.toThrow("Purge failed: could not stop the service");
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(join(dataDir, folder))).toBe(true);
		});
	});

	describe("builds without a managed binary", () => {
		it("a dev build never runs a command: unsupported while on, off while off", async () => {
			const { service, commands, state, persistEnabled } = await make({ automatic: false });
			await service.start();
			expect(service.state()).toMatchObject({ phase: "unsupported", enabled: true });
			expect(service.state().detail).toContain("OMP_GUI_AI_MEMORY_BIN");
			await service.setEnabled(false);
			await service.retry();
			await expect(service.purge()).rejects.toThrow("not managed by this build");
			expect(persistEnabled).toHaveBeenCalledWith(false);
			expect(state.enabled).toBe(false);
			expect(commands()).toEqual([]);
			state.enabled = false;
			await service.start();
			expect(service.state()).toMatchObject({ phase: "off", detail: null });
		});

		it("an unsupported platform reports it and runs nothing", async () => {
			for (const [platform, arch] of [
				["other", "x64"],
				["darwin", "x64"],
			] as const) {
				const { service, commands } = await make({ platform, arch, binaryOverride: null });
				await service.start();
				expect(service.state()).toMatchObject({ phase: "unsupported", detail: "ai-memory has no build for this platform." });
				expect(commands()).toEqual([]);
				service.dispose();
				await rm(w?.root ?? "", RM_TEMP);
			}
		});

		it("an override runs even on an architecture the pin has no build for", async () => {
			const { service, commands } = await make({ platform: "darwin", arch: "x64" });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, SETUP]);
		});
	});

	describe("which binary", () => {
		async function externalWorld(version: string) {
			const w2 = await make({
				binaryOverride: null,
				bundledDir: join(tmpdir(), "ai-memory-no-such-shipped-dir"),
				externalProbe: async () => version,
			});
			const bin = join(w2.home, ".local", "bin", "ai-memory");
			await mkdir(join(w2.home, ".local", "bin"), { recursive: true });
			await writeFile(bin, "#!/bin/sh\n");
			return { w2, bin };
		}

		it("a NEWER user install wins and is the binary every command runs", async () => {
			const { w2, bin } = await externalWorld("99.0.0");
			await w2.service.start();
			expect(w2.calls.map(call => call.file)).toEqual([bin, bin, bin]);
			expect(w2.service.state()).toMatchObject({ source: "external", binary: bin, phase: "ready" });
		});

		it("an equal user install is left alone: the app's own copy is staged, and its absence fails clearly", async () => {
			const { w2 } = await externalWorld(AI_MEMORY_VERSION);
			await w2.service.start();
			expect(w2.calls).toEqual([]);
			expect(w2.service.state()).toMatchObject({ phase: "failed" });
			expect(w2.service.state().detail).toMatch(/bundled ai-memory is missing/);
		});

		it("an app that carries no ai-memory folder fails before running anything", async () => {
			const { service, calls } = await make({ binaryOverride: null, bundledDir: null });
			await service.start();
			expect(calls).toEqual([]);
			expect(service.state()).toMatchObject({
				phase: "failed",
				detail: "The app carries no ai-memory binary. Reinstall OMPdesk.",
			});
		});

		it("a shipped binary that does not match the pin fails with that message and runs nothing", async () => {
			const shipped = await mkdtemp(join(tmpdir(), "ai-memory-shipped-"));
			try {
				await writeFile(join(shipped, "ai-memory"), "not the pinned build");
				const { service, calls } = await make({
					binaryOverride: null,
					bundledDir: shipped,
					externalProbe: async () => "0.0.1",
				});
				await service.start();
				expect(service.state().phase).toBe("failed");
				expect(service.state().detail).toMatch(/does not match its pin/);
				expect(calls).toEqual([]);
			} finally {
				await rm(shipped, RM_TEMP);
			}
		});
	});

	describe("polling", () => {
		it("down twice re-runs setup once, then the cooldown holds; after it, setup runs again", async () => {
			const { service, health, commands, clock } = await make();
			await service.start();
			const setups = () => commands().filter(command => command === SETUP).length;
			expect(setups()).toBe(1);
			health.up = false;
			await vi.waitFor(() => expect(setups()).toBe(2));
			// Many more down polls: the cooldown keeps the count at two.
			const seen = health.healthCalls;
			await vi.waitFor(() => expect(health.healthCalls).toBeGreaterThan(seen + 6));
			expect(setups()).toBe(2);
			expect(service.state().phase).toBe("unreachable");
			clock.now += 11 * 60_000;
			await vi.waitFor(() => expect(setups()).toBe(3));
		});

		it("a poll that finds the server back makes it ready again without a setup", async () => {
			const { service, health, commands } = await make();
			await service.start();
			health.up = false;
			await vi.waitFor(() => expect(service.state().phase).toBe("unreachable"));
			health.up = true;
			await vi.waitFor(() => expect(service.state().phase).toBe("ready"));
			expect(commands().filter(command => command === SETUP).length).toBeLessThanOrEqual(2);
		});

		it("a missing extension file is healed by running setup again", async () => {
			const { service, agentDir, commands } = await make();
			await service.start();
			await rm(join(agentDir, EXTENSION_FILE));
			await vi.waitFor(() => expect(commands().filter(command => command === SETUP)).toHaveLength(2));
			await vi.waitFor(() => expect(service.state()).toMatchObject({ phase: "ready", wiring: { extension: true, mcp: true } }));
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
		});

		it("polling stops while memory is off", async () => {
			vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
			try {
				const { service, health } = await make();
				await service.start();
				expect(vi.getTimerCount()).toBe(1);
				await service.setEnabled(false);
				expect(vi.getTimerCount()).toBe(0);
				const seen = health.healthCalls;
				vi.advanceTimersByTime(60_000);
				expect(health.healthCalls).toBe(seen);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("state pushes", () => {
		it("every push is a whole, independent snapshot", async () => {
			const { service, states } = await make();
			await service.start();
			await service.setEnabled(false);
			const keys = Object.keys(service.state()).sort();
			expect(states.length).toBeGreaterThan(4);
			for (const snapshot of states) expect(Object.keys(snapshot).sort()).toEqual(keys);
			const first = states[0];
			expect(first).not.toBe(states[1]);
			const before = JSON.stringify(states[1]);
			(states[0] as AiMemoryState).wiring.extension = !states[0]?.wiring.extension;
			expect(JSON.stringify(states[1])).toBe(before);
			// state() hands out a copy too.
			service.state().wiring.mcp = true;
			expect(service.state().wiring.mcp).toBe(false);
		});
	});

	describe("dispose", () => {
		it("cancels a running command and runs nothing after it", async () => {
			const { service, behavior, commands } = await make();
			behavior.gate = async args => (args.includes("--plan") ? HANG : undefined);
			const started = service.start();
			await vi.waitFor(() => expect(commands()).toEqual([PLAN]));
			service.dispose();
			await started;
			expect(commands()).toEqual([PLAN]);
			expect(service.state().phase).toBe("starting");
		});

		it("a switch after dispose runs nothing", async () => {
			const { service, commands } = await make();
			await service.start();
			service.dispose();
			await service.setEnabled(false);
			expect(commands()).toEqual([PLAN, INIT, SETUP]);
		});
	});

	describe("refresh", () => {
		it("re-reads stats at most every few seconds while ready", async () => {
			const { service, clock, health } = await make({ pollMs: 3_600_000 });
			await service.start();
			const calls = () => health.healthCalls;
			const before = calls();
			await service.refresh();
			const afterFirst = calls();
			await service.refresh();
			expect(calls()).toBe(afterFirst);
			expect(afterFirst).toBeGreaterThan(before);
			clock.now += 6_000;
			await service.refresh();
			expect(calls()).toBeGreaterThan(afterFirst);
		});
	});
});
