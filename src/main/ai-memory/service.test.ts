import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, type Mock, vi } from "vitest";
import { AI_MEMORY_VERSION, type AiMemoryState } from "../../shared/ai-memory";
import type { SpawnSpec } from "../setup/plans";
import { SetupRunner, type SupervisedChild } from "../setup/runner";
import { SUPERVISOR_STOPPED_CODE } from "../setup/supervisor";
import { RM_TEMP } from "../test-fake-omp";
import { AiMemoryClient } from "./client";
import { rootComplete } from "./root";
import { AiMemoryService, type AiMemoryServiceDeps, parsePlan, parseProblems } from "./service";
import { EXTENSION_FILE, GENERATED_HEADER, MCP_FILE } from "./terminal";
import type { ServiceControl } from "./unit";

const BIN = "/fake/bin/ai-memory";
const SERVER = "http://127.0.0.1:50123";
const HANG = Symbol("hang");
/** What ai-memory's `init` writes: its template, with the embedding opt-out as a comment. */
const INIT_CONFIG = 'bind = "127.0.0.1:50123"\n# embedding_provider = "none"   # template\n';
const SKILL_TEXT = "<!-- ai-memory-managed: routing-skill -->\n# skill\n";

interface Result {
	code: number;
	output?: string;
}
interface Call {
	file: string;
	args: string[];
	cwd: string | undefined;
	shell: boolean;
	env: NodeJS.ProcessEnv;
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
	/** Whether `setup --yes` really leaves its wiring behind (in the agent dir it was pointed at). */
	wire: boolean;
	/** Whether the generators (`install-hooks`, `install-mcp`, `install-skills`) write their files. */
	generate: boolean;
	setup: () => Result;
	init: () => Result;
	plan: () => Result;
	/** The lines `uninstall` (dry run) prints: other agents' wiring it would remove. */
	others: string[];
	/** The dry run itself fails. */
	listingFails: boolean;
	/** A command's own hook, run before it answers (a hang, a spawn error). */
	gate: ((args: string[]) => Promise<GateResult | undefined>) | undefined;
}

interface World {
	root: string;
	agentDir: string;
	rootDir: string;
	dataDir: string;
	home: string;
	toolsDir: string;
	calls: Call[];
	commands: () => string[];
	behavior: Behavior;
	health: { up: boolean; healthCalls: number };
	/** The OS service: what `setup` installs and `remove` takes away. */
	unit: { installed: boolean; ours: boolean; removed: number };
	prefs: { enabled: boolean; terminal: boolean | undefined; owned: boolean | undefined };
	states: AiMemoryState[];
	persistEnabled: Mock<(enabled: boolean) => void>;
	clock: { now: number };
	service: AiMemoryService;
}

async function world(overrides: Partial<AiMemoryServiceDeps> = {}): Promise<World> {
	const root = await mkdtemp(join(tmpdir(), "ai-memory-service-"));
	const agentDir = join(root, "agent");
	const rootDir = join(root, "userData", "ai-memory", "omp-ext");
	const dataDir = join(root, "data");
	const home = join(root, "home");
	const toolsDir = join(root, "tools");
	await Promise.all([agentDir, join(dataDir, "auth-tokens"), home].map(dir => mkdir(dir, { recursive: true })));
	await writeFile(join(dataDir, "auth-tokens", "default"), "tok\n");
	await writeFile(join(agentDir, "config.yml"), "theme: dark\n");

	const calls: Call[] = [];
	const behavior: Behavior = {
		wire: true,
		generate: true,
		setup: (): Result => ({ code: 0, output: "setup done\n" }),
		init: (): Result => ({ code: 0, output: "initialized\n" }),
		others: [],
		listingFails: false,
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
		gate: undefined,
	};
	const health = { up: true, healthCalls: 0 };
	const unit = { installed: false, ours: false, removed: 0 };
	const prefs: World["prefs"] = { enabled: true, terminal: undefined, owned: undefined };

	const argAfter = (args: string[], flag: string): string => args[args.indexOf(flag) + 1] ?? "";
	const writeFileDeep = async (file: string, text: string) => {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, text);
	};

	const spawner = (spec: SpawnSpec, env: NodeJS.ProcessEnv, cwd?: string): SupervisedChild => {
		const child = new FakeChild();
		calls.push({ file: spec.file, args: spec.args, cwd, shell: spec.shell, env });
		setImmediate(async () => {
			try {
				await respond();
			} catch {
				// The test's folder is gone (teardown while a background heal was still writing): the command fails.
				child.finish(1, "");
			}
		});
		const respond = async (): Promise<void> => {
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
			let result: Result = { code: 0, output: "ok\n" };
			if (verb === "init") {
				result = behavior.init();
				if (result.code === 0) await writeFile(join(dataDir, "config.toml"), INIT_CONFIG);
			} else if (verb === "setup" && spec.args.includes("--plan")) result = behavior.plan();
			else if (verb === "setup") {
				result = behavior.setup();
				if (!spec.args.includes("--no-service") && !unit.installed) {
					// A fresh install of the service starts the server; re-running over an installed one changes nothing.
					Object.assign(unit, { installed: true, ours: true });
					health.up = true;
				}
				if (behavior.wire) {
					// `setup --agent omp` writes into omp's agent dir (PI_CODING_AGENT_DIR), and the shared skills into $HOME.
					const dir = env.PI_CODING_AGENT_DIR ?? agentDir;
					await writeFileDeep(join(dir, EXTENSION_FILE), `${GENERATED_HEADER} --apply\`.\n`);
					await writeFileDeep(
						join(dir, MCP_FILE),
						JSON.stringify({ mcpServers: { "ai-memory": { command: spec.file, args: ["mcp-bridge"] } } }),
					);
					const skill = join(home, ".agents", "skills", "ai-memory-retrieval", "SKILL.md");
					if (!existsSync(skill)) await writeFileDeep(skill, SKILL_TEXT);
				}
				if (!existsSync(join(dataDir, "config.toml"))) {
					await writeFile(join(dataDir, "config.toml"), 'bind = "127.0.0.1:50123"\n');
				}
			} else if (verb === "install-hooks" || verb === "install-mcp" || verb === "install-skills") {
				if (behavior.generate) {
					if (verb === "install-hooks") {
						await writeFileDeep(
							argAfter(spec.args, "--config-file"),
							`${GENERATED_HEADER} --apply\`.\nexport default 1;\n`,
						);
					} else if (verb === "install-mcp") {
						await writeFileDeep(
							argAfter(spec.args, "--config-file"),
							JSON.stringify({ mcpServers: { "ai-memory": { command: spec.file, args: ["mcp-bridge"] } } }),
						);
					} else {
						await writeFileDeep(
							join(argAfter(spec.args, "--target-dir"), "ai-memory-handoff", "SKILL.md"),
							SKILL_TEXT,
						);
					}
				}
			} else if (verb === "uninstall") {
				result = behavior.listingFails
					? { code: 1, output: "cannot read\n" }
					: {
							code: 0,
							output: `${behavior.others.join("\n")}\nnote: other checkouts\n(dry-run; pass --apply to remove)\n`,
						};
			}
			child.finish(result.code, result.output ?? "");
		};
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

	const control: ServiceControl = {
		inspect: async () => ({ installed: unit.installed, ours: unit.ours }),
		remove: async () => {
			unit.removed += 1;
			Object.assign(unit, { installed: false, ours: false });
			health.up = false;
		},
	};
	const states: AiMemoryState[] = [];
	const persistEnabled = vi.fn((enabled: boolean) => {
		prefs.enabled = enabled;
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
		rootDir,
		enabled: () => prefs.enabled,
		persistEnabled,
		terminalPref: () => prefs.terminal,
		persistTerminal: value => {
			prefs.terminal = value;
		},
		serviceOwnedPref: () => prefs.owned,
		persistServiceOwned: value => {
			prefs.owned = value;
		},
		unit: control,
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
	return {
		root,
		agentDir,
		rootDir,
		dataDir,
		home,
		toolsDir,
		calls,
		commands,
		behavior,
		health,
		unit,
		prefs,
		states,
		persistEnabled,
		clock,
		service,
	};
}

type GateResult = Result | typeof HANG | "spawn-error";

const SETUP = "setup --yes --agent omp";
const PLAN = "setup --plan --json --agent omp";
const INIT = "init";
const LISTING = "uninstall";
/** The three generator commands, in order, for a root at `rootDir` (they write into `<root>.next`, swapped in after). */
const generators = (rootDir: string) => [
	`install-hooks --agent omp --apply --config-file ${join(`${rootDir}.next`, "index.ts")}`,
	`install-mcp --client omp --apply --config-file ${join(`${rootDir}.next`, ".mcp.json")}`,
	`install-skills --target-dir ${join(`${rootDir}.next`, "skills")}`,
];

const LEGACY_EXTENSION = `${GENERATED_HEADER} --apply\`.\n`;

describe("AiMemoryService", () => {
	let w: World | undefined;
	const make = async (overrides?: Partial<AiMemoryServiceDeps>) => (w = await world(overrides));

	afterEach(async () => {
		w?.service.dispose();
		if (w) await rm(w.root, RM_TEMP);
		w = undefined;
	});

	/** A mcp.json with another server beside ai-memory's entry, as a user's file would be. */
	async function plantTerminalWiring(agentDir: string, command: string, extension = true): Promise<void> {
		await mkdir(join(agentDir, "extensions"), { recursive: true });
		if (extension) await writeFile(join(agentDir, EXTENSION_FILE), LEGACY_EXTENSION);
		await writeFile(
			join(agentDir, MCP_FILE),
			JSON.stringify({
				mcpServers: { other: { command: "other-server" }, "ai-memory": { command, args: ["mcp-bridge"] } },
				theme: "kept",
			}),
		);
	}

	describe("pure parsers", () => {
		it("parseProblems reads only `problem:` lines", () => {
			expect(
				parseProblems("ok\n  problem: self-check: healthz did not answer\r\nINFO x\nproblem: config: bad\n"),
			).toEqual(["self-check: healthz did not answer", "config: bad"]);
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
		it("stages, sets up the server and the app-owned root with ai-memory's own commands, checks and becomes ready", async () => {
			const { service, commands, calls, states, home, dataDir, agentDir, rootDir } = await make();
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, SETUP, ...generators(rootDir)]);
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
				wiring: { app: true, terminal: false },
				stats: { pages: 4, sessions: 2, observations: 30, diskBytes: 2048 },
				detail: null,
				version: "3.1.1",
			});
			// The root holds ai-memory's own output: the extension, the MCP entry and the skills.
			expect(existsSync(join(rootDir, "index.ts"))).toBe(true);
			expect(JSON.parse(await readFile(join(rootDir, ".mcp.json"), "utf8")).mcpServers["ai-memory"].command).toBe(
				BIN,
			);
			expect(await readdir(join(rootDir, "skills"))).toEqual(["ai-memory-handoff"]);
			expect(await readdir(dirname(rootDir))).toEqual(["omp-ext"]);
			// Nothing lands in omp's own agent dir.
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(false);
			expect(existsSync(join(agentDir, MCP_FILE))).toBe(false);
		});

		it("runs setup against a scratch agent dir that is gone afterwards, and takes back the shared skills it created", async () => {
			const { service, calls, rootDir, home, agentDir } = await make();
			const kept = join(home, ".agents", "skills", "ai-memory-messaging", "SKILL.md");
			await mkdir(dirname(kept), { recursive: true });
			await writeFile(kept, SKILL_TEXT);
			const own = join(home, ".agents", "skills", "my-own-skill", "SKILL.md");
			await mkdir(dirname(own), { recursive: true });
			await writeFile(own, "mine");
			await service.start();
			const setup = calls.find(call => call.args.join(" ") === SETUP);
			expect(setup?.env.PI_CODING_AGENT_DIR).toBe(`${rootDir}.setup`);
			expect(setup?.env.PI_CODING_AGENT_DIR).not.toBe(agentDir);
			expect(existsSync(`${rootDir}.setup`)).toBe(false);
			// ai-memory-retrieval was created by this setup: gone. The others were there before: untouched.
			expect(existsSync(join(home, ".agents", "skills", "ai-memory-retrieval"))).toBe(false);
			expect(existsSync(kept)).toBe(true);
			expect(existsSync(own)).toBe(true);
		});

		it("waits for beforeStart before the first command", async () => {
			const gate = Promise.withResolvers<void>();
			const { service, commands, rootDir } = await make({ beforeStart: () => gate.promise });
			const started = service.start();
			await vi.waitFor(() => expect(service.state().phase).toBe("starting"));
			// The first command would be spawned on the next macrotask; none was.
			const { promise: turn, resolve: next } = Promise.withResolvers<void>();
			setImmediate(next);
			await turn;
			expect(commands()).toEqual([]);
			gate.resolve();
			await started;
			expect(commands()).toEqual([PLAN, INIT, SETUP, ...generators(rootDir)]);
		});

		it("passes --no-service to setup only", async () => {
			const { service, commands, rootDir } = await make({ noService: true });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, `${SETUP} --no-service`, ...generators(rootDir)]);
		});

		it("a fresh data dir runs ai-memory's own init and opts out of the local embedding model before setup", async () => {
			const { service, commands, dataDir } = await make();
			await service.start();
			expect(commands().slice(0, 3)).toEqual([PLAN, INIT, SETUP]);
			const config = await readFile(join(dataDir, "config.toml"), "utf8");
			expect(config).toMatch(/^embedding_provider = "none"/m);
			expect(config).not.toMatch(/^# embedding_provider/m);
		});

		it("an existing config is never touched: no init, no edit", async () => {
			const { service, commands, dataDir, health } = await make();
			await mkdir(dataDir, { recursive: true });
			const mine = 'bind = "127.0.0.1:50123"\n# embedding_provider = "none"  # the user left hybrid search on\n';
			await writeFile(join(dataDir, "config.toml"), mine);
			health.up = false;
			await service.start();
			expect(commands().slice(0, 2)).toEqual([PLAN, SETUP]);
			expect(await readFile(join(dataDir, "config.toml"), "utf8")).toBe(mine);
		});

		it("a failing init fails the step with its text and never runs setup", async () => {
			const { service, behavior, commands } = await make();
			behavior.init = () => ({ code: 1, output: "cannot create the data dir\n" });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT]);
			expect(service.state()).toMatchObject({ phase: "failed", detail: "init failed: cannot create the data dir" });
		});

		it("a server that never answers leaves memory set up but unreachable", async () => {
			const { service, health } = await make({ noService: true });
			health.up = false;
			await service.start();
			expect(service.state()).toMatchObject({
				phase: "unreachable",
				detail: "The server does not answer yet.",
				wiring: { app: true, terminal: false },
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

		it("generators that leave no root fail and name it, with nothing half-written in place", async () => {
			const { service, behavior, rootDir } = await make();
			behavior.generate = false;
			await service.start();
			expect(service.state()).toMatchObject({
				phase: "failed",
				detail: "ai-memory's generators left the extension root incomplete",
				wiring: { app: false },
			});
			expect(existsSync(rootDir)).toBe(false);
			expect(existsSync(`${rootDir}.next`)).toBe(false);
			expect(await service.extensionArgs()).toEqual([]);
		});

		it("a failing generator names the command and its output", async () => {
			const { service, behavior } = await make();
			behavior.gate = async args => (args[0] === "install-mcp" ? { code: 1, output: "cannot write\n" } : undefined);
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed", detail: "install-mcp failed: cannot write" });
		});

		it("a binary that cannot start is a failure with its own message", async () => {
			const { service, behavior } = await make();
			behavior.gate = async () => "spawn-error";
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed" });
			expect(service.state().detail).toContain("ai-memory could not start");
		});

		it("a failed state is retried by retry()", async () => {
			const { service, behavior, commands, rootDir } = await make();
			behavior.generate = false;
			await service.start();
			expect(service.state().phase).toBe("failed");
			behavior.generate = true;
			await service.retry();
			expect(service.state().phase).toBe("ready");
			expect(commands().slice(-5)).toEqual([PLAN, SETUP, ...generators(rootDir)]);
		});

		/** What ai-memory's `setup` reported on v0.41.0's update: the old server still drained when it bootstrapped. */
		const BOOTSTRAP_REFUSED = {
			code: 1,
			output:
				"problem: service: `launchctl bootstrap gui/501 /x.plist` failed: Bootstrap failed: 5: Input/output error\n",
		};

		it("a setup the service manager refused runs again by itself, logs it, and becomes ready", async () => {
			const lines: Array<[string, Record<string, unknown>]> = [];
			const { service, behavior, commands } = await make({
				retryDelaysMs: [0, 0, 0],
				log: (message, details) => lines.push([message, details]),
			});
			let refusals = 1;
			behavior.setup = () => (refusals-- > 0 ? BOOTSTRAP_REFUSED : { code: 0, output: "setup done\n" });
			await service.start();
			await vi.waitFor(() => expect(service.state().phase).toBe("ready"));
			expect(commands().filter(command => command === SETUP)).toHaveLength(2);
			expect(lines.filter(([message]) => message === "retry")).toEqual([
				["retry", expect.objectContaining({ attempt: 1, of: 3, inMs: 0 })],
			]);
		});

		it("the automatic re-runs are bounded: a refusal that never ends stays failed with its reason", async () => {
			const lines: string[] = [];
			const { service, behavior, commands } = await make({
				retryDelaysMs: [0, 0],
				log: message => lines.push(message),
			});
			behavior.setup = () => BOOTSTRAP_REFUSED;
			await service.start();
			// The third failure is logged before the (refused) schedule of a fourth pass, in the same turn.
			await vi.waitFor(() => expect(lines.filter(message => message === "failed")).toHaveLength(3));
			expect(lines.filter(message => message === "retry")).toHaveLength(2);
			expect(commands().filter(command => command === SETUP)).toHaveLength(3);
			expect(service.state()).toMatchObject({ phase: "failed" });
			expect(service.state().detail).toContain("Bootstrap failed: 5");
		});

		it("an update whose service step failed still rewrites a stale extension root", async () => {
			const { service, behavior, rootDir } = await make({ retryDelaysMs: [] });
			await mkdir(join(rootDir, "skills", "ai-memory-handoff"), { recursive: true });
			await writeFile(
				join(rootDir, "index.ts"),
				`${GENERATED_HEADER} --apply\`.\n// an earlier build's extension\n`,
			);
			await writeFile(
				join(rootDir, ".mcp.json"),
				JSON.stringify({ mcpServers: { "ai-memory": { command: "/old" } } }),
			);
			await writeFile(join(rootDir, "skills", "ai-memory-handoff", "SKILL.md"), SKILL_TEXT);
			behavior.setup = () => BOOTSTRAP_REFUSED;
			await service.start();
			expect(service.state().phase).toBe("failed");
			expect(await readFile(join(rootDir, "index.ts"), "utf8")).toBe(
				`${GENERATED_HEADER} --apply\`.\nexport default 1;\n`,
			);
			expect(JSON.parse(await readFile(join(rootDir, ".mcp.json"), "utf8"))).toMatchObject({
				mcpServers: { "ai-memory": { command: BIN } },
			});
		});
	});

	describe("the root is loaded only while memory is on", () => {
		it("-e <root> while on, nothing while off, and again after on", async () => {
			const { service, rootDir } = await make();
			expect(await service.extensionArgs()).toEqual([]);
			await service.start();
			expect(await service.extensionArgs()).toEqual(["-e", rootDir]);
			await service.setEnabled(false);
			expect(await service.extensionArgs()).toEqual([]);
			await service.setEnabled(true);
			expect(await service.extensionArgs()).toEqual(["-e", rootDir]);
		});

		it("the switch stops the loading at once: the stored value alone decides, before any command ends", async () => {
			const { service, behavior, prefs } = await make();
			await service.start();
			behavior.gate = async () => HANG;
			void service.setEnabled(false);
			expect(prefs.enabled).toBe(false);
			expect(await service.extensionArgs()).toEqual([]);
		});

		it("a terminal omp that already loads ai-memory's extension from its agent dir gets no second copy", async () => {
			const { service, agentDir } = await make();
			await service.start();
			await plantTerminalWiring(agentDir, "/users/own/ai-memory");
			expect(await service.extensionArgs()).toEqual([]);
			await rm(join(agentDir, EXTENSION_FILE));
			expect(await service.extensionArgs()).toEqual(["-e", w?.rootDir]);
		});

		it("a build that does not manage ai-memory loads nothing", async () => {
			const { service } = await make({ automatic: false });
			await service.start();
			expect(await service.extensionArgs()).toEqual([]);
		});
	});

	describe("off, on and purge", () => {
		it("off never runs `uninstall --apply`: it deletes the root, stops its own server and leaves everything else", async () => {
			const { service, commands, persistEnabled, agentDir, dataDir, prefs, unit, health, rootDir, home } =
				await make();
			// Another agent's ai-memory wiring and omp's own config, planted before.
			const claude = join(home, ".claude", "settings.json");
			await mkdir(dirname(claude), { recursive: true });
			await writeFile(claude, '{"hooks":{"ai-memory":1}}');
			await service.start();
			await service.setEnabled(false);
			expect(persistEnabled).toHaveBeenCalledWith(false);
			expect(prefs.enabled).toBe(false);
			// A dry run lists other clients; nothing ever applies an uninstall.
			expect(commands().at(-1)).toBe(LISTING);
			for (const command of commands()) expect(command).not.toContain("--apply --yes");
			expect(commands().some(command => command.startsWith("uninstall") && command.includes("--apply"))).toBe(false);
			expect(service.state()).toMatchObject({
				enabled: false,
				phase: "off",
				step: null,
				stats: null,
				wiring: { app: false, terminal: false },
			});
			expect(existsSync(rootDir)).toBe(false);
			expect(unit.removed).toBe(1);
			expect(health.up).toBe(false);
			// Not OMPdesk's to touch: other agents' configs, omp's own config and ai-memory's data.
			expect(await readFile(claude, "utf8")).toBe('{"hooks":{"ai-memory":1}}');
			expect(await readFile(join(agentDir, "config.yml"), "utf8")).toBe("theme: dark\n");
			expect(existsSync(join(dataDir, "auth-tokens", "default"))).toBe(true);
		});

		it("the server keeps running while another agent is wired to it", async () => {
			const { service, behavior, unit, health } = await make();
			behavior.others = ["would delete /home/u/.claude/settings.json (Claude Code hooks)"];
			await service.start();
			await service.setEnabled(false);
			expect(service.state().phase).toBe("off");
			expect(unit.removed).toBe(0);
			expect(health.up).toBe(true);
		});

		it("other agents' managed skills alone are not a client: the server still stops", async () => {
			const { service, behavior, unit } = await make();
			behavior.others = ["would delete /home/u/.agents/skills/ai-memory-handoff/SKILL.md (managed Agent Skill)"];
			await service.start();
			await service.setEnabled(false);
			expect(unit.removed).toBe(1);
		});

		it("ai-memory's own service in the dry run (a Windows logon entry, a launchd unit) is not another client", async () => {
			const { service, behavior, unit } = await make();
			behavior.others = [
				"would delete the Windows logon entry HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\ai-memory",
				"would remove the launchd service com.github.akitaonrails.ai-memory",
			];
			await service.start();
			await service.setEnabled(false);
			expect(unit.removed).toBe(1);
		});

		it("the server keeps running when the list of other clients cannot be read", async () => {
			const { service, behavior, unit } = await make();
			await service.start();
			behavior.listingFails = true;
			await service.setEnabled(false);
			expect(unit.removed).toBe(0);
		});

		it("a terminal omp connected to ai-memory keeps its wiring and the server", async () => {
			const { service, unit, agentDir } = await make();
			await service.start();
			await service.setTerminal(true);
			await service.setEnabled(false);
			expect(unit.removed).toBe(0);
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
			expect(service.state().wiring).toEqual({ app: false, terminal: true });
		});

		it("a service OMPdesk did not start is never stopped, and setup is told not to install one", async () => {
			const { service, commands, unit, prefs, rootDir } = await make();
			Object.assign(unit, { installed: true, ours: false });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, `${SETUP} --no-service`, ...generators(rootDir)]);
			expect(prefs.owned).toBe(false);
			await service.setEnabled(false);
			expect(unit.removed).toBe(0);
			// Still not ours after our own unit name shows up later: the stored answer stays false.
			Object.assign(unit, { installed: true, ours: true });
			await service.setEnabled(true);
			expect(commands().at(-4)).toBe(`${SETUP} --no-service`);
		});

		it("a server that answered before OMPdesk set anything up (no unit of ours) is someone else's", async () => {
			const { service, commands, dataDir, prefs, unit } = await make();
			await mkdir(dataDir, { recursive: true });
			await writeFile(join(dataDir, "config.toml"), 'bind = "127.0.0.1:50123"\n');
			await service.start();
			expect(commands()[1]).toBe(`${SETUP} --no-service`);
			expect(prefs.owned).toBe(false);
			await service.setEnabled(false);
			expect(unit.removed).toBe(0);
		});

		it("on again sets up the root again", async () => {
			const { service, commands, rootDir } = await make();
			await service.start();
			await service.setEnabled(false);
			await service.setEnabled(true);
			expect(commands().slice(-5)).toEqual([PLAN, SETUP, ...generators(rootDir)]);
			expect(service.state()).toMatchObject({
				enabled: true,
				phase: "ready",
				wiring: { app: true, terminal: false },
			});
		});

		it("a stored `false` at launch starts off and runs no command", async () => {
			const { service, commands, prefs } = await make();
			prefs.enabled = false;
			await service.start();
			expect(commands()).toEqual([]);
			expect(service.state()).toMatchObject({ enabled: false, phase: "off" });
		});

		async function seedData(dataDir: string): Promise<void> {
			for (const folder of ["wiki", "db", "raw"]) {
				await mkdir(join(dataDir, folder), { recursive: true });
				await writeFile(join(dataDir, folder, "x"), "data");
			}
		}

		it("purge stops its own server, deletes wiki/db/raw itself once it is gone, then sets up again", async () => {
			const { service, commands, dataDir, unit } = await make();
			await service.start();
			await seedData(dataDir);
			await service.purge();
			// Never `uninstall`: it would remove other agents' wiring; and never `--purge-data` (live omp sessions
			// run an mcp-bridge, which makes ai-memory refuse it).
			expect(commands().some(command => command.startsWith("uninstall"))).toBe(false);
			expect(unit.removed).toBe(1);
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(join(dataDir, folder))).toBe(false);
			// The config and the token are not memory.
			expect(existsSync(join(dataDir, "config.toml"))).toBe(true);
			expect(existsSync(join(dataDir, "auth-tokens", "default"))).toBe(true);
			expect(service.state()).toMatchObject({ enabled: true, phase: "ready" });
			expect(unit.installed).toBe(true);
		});

		it("a server that still answers (not ours to stop) deletes nothing and fails the purge; memory stays on", async () => {
			const { service, dataDir, unit } = await make();
			await service.start();
			await seedData(dataDir);
			Object.assign(unit, { installed: true, ours: false });
			await expect(service.purge()).rejects.toThrow("An ai-memory server still answers");
			for (const folder of ["wiki", "db", "raw"]) expect(existsSync(join(dataDir, folder))).toBe(true);
			expect(service.state()).toMatchObject({ enabled: true, phase: "ready", detail: null });
		});

		it("a purge before the data directory is known deletes nothing", async () => {
			const { service, commands, prefs } = await make();
			prefs.enabled = false;
			await service.start();
			await expect(service.purge()).rejects.toThrow("data folder is not known");
			expect(commands()).toEqual([]);
		});
	});

	describe("the terminal omp", () => {
		it("connecting runs ai-memory's own setup in omp's real agent dir and the root is no longer loaded", async () => {
			const { service, calls, agentDir, prefs, home } = await make();
			await service.start();
			await service.setTerminal(true);
			const setup = calls.filter(call => call.args.join(" ") === SETUP).at(-1);
			expect(setup?.env.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
			expect(prefs.terminal).toBe(true);
			expect(service.state()).toMatchObject({ phase: "ready", wiring: { app: true, terminal: true } });
			expect(await service.extensionArgs()).toEqual([]);
			// The shared skills `setup` wrote stay: they belong to every agent that reads them.
			expect(existsSync(join(home, ".agents", "skills", "ai-memory-retrieval"))).toBe(true);
		});

		it("disconnecting removes exactly ai-memory's extension and MCP entry, nothing else", async () => {
			const { service, agentDir, prefs, rootDir } = await make();
			await service.start();
			await plantTerminalWiring(agentDir, join("/users", "own", "ai-memory"));
			await service.setTerminal(false);
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(false);
			expect(JSON.parse(await readFile(join(agentDir, MCP_FILE), "utf8"))).toEqual({
				mcpServers: { other: { command: "other-server" } },
				theme: "kept",
			});
			expect(await readFile(join(agentDir, "config.yml"), "utf8")).toBe("theme: dark\n");
			expect(prefs.terminal).toBe(false);
			expect(await service.extensionArgs()).toEqual(["-e", rootDir]);
		});

		it("an mcp.json left with nothing goes away; an extension that is not ai-memory's generated one stays", async () => {
			const { service, agentDir } = await make();
			await service.start();
			await mkdir(join(agentDir, "extensions"), { recursive: true });
			await writeFile(join(agentDir, EXTENSION_FILE), "// my own file with the same name\n");
			await writeFile(
				join(agentDir, MCP_FILE),
				JSON.stringify({ mcpServers: { "ai-memory": { command: "/x/ai-memory", args: ["mcp-bridge"] } } }),
			);
			await service.setTerminal(false);
			expect(existsSync(join(agentDir, MCP_FILE))).toBe(false);
			expect(await readFile(join(agentDir, EXTENSION_FILE), "utf8")).toBe("// my own file with the same name\n");
		});

		it("an MCP entry named ai-memory that runs something else is not removed", async () => {
			const { service, agentDir } = await make();
			await service.start();
			await writeFile(
				join(agentDir, MCP_FILE),
				JSON.stringify({ mcpServers: { "ai-memory": { command: "node" } } }),
			);
			await service.setTerminal(false);
			expect(JSON.parse(await readFile(join(agentDir, MCP_FILE), "utf8")).mcpServers["ai-memory"].command).toBe(
				"node",
			);
		});

		it("connecting needs memory on", async () => {
			const { service, commands, prefs } = await make();
			prefs.enabled = false;
			await service.start();
			await expect(service.setTerminal(true)).rejects.toThrow("Turn memory on first.");
			expect(commands()).toEqual([]);
		});

		it("a failed connect throws, restores the phase and stores nothing", async () => {
			const { service, behavior, prefs } = await make();
			await service.start();
			behavior.setup = () => ({ code: 1, output: "problem: config: cannot write\n" });
			await expect(service.setTerminal(true)).rejects.toThrow("setup failed: config: cannot write");
			expect(prefs.terminal).toBe(false);
			expect(service.state().phase).toBe("ready");
		});

		it("a connected terminal omp is set up again by the next launch's setup (a new binary path), in its real agent dir", async () => {
			const { service, calls, prefs, agentDir } = await make();
			await service.start();
			await service.setTerminal(true);
			expect(prefs.terminal).toBe(true);
			const before = calls.length;
			await service.retry();
			const setup = calls.slice(before).find(call => call.args.join(" ") === SETUP);
			expect(setup?.env.PI_CODING_AGENT_DIR).toBeUndefined();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
		});
	});

	describe("migration of an earlier build's global wiring", () => {
		it("moves wiring that runs OMPdesk's staged binary to the app-owned root, once, and keeps everything else", async () => {
			const { service, agentDir, prefs, toolsDir, rootDir, unit } = await make();
			Object.assign(unit, { installed: true, ours: true });
			await plantTerminalWiring(agentDir, join(toolsDir, "ai-memory", "3.0.0", "ai-memory"));
			await service.start();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(false);
			expect(JSON.parse(await readFile(join(agentDir, MCP_FILE), "utf8"))).toEqual({
				mcpServers: { other: { command: "other-server" } },
				theme: "kept",
			});
			expect(prefs.terminal).toBe(false);
			expect(service.state().wiring).toEqual({ app: true, terminal: false });
			expect(await service.extensionArgs()).toEqual(["-e", rootDir]);
			// Once: after it the pref decided; a wiring planted later is the user's and stays.
			await plantTerminalWiring(agentDir, join(toolsDir, "ai-memory", "3.0.0", "ai-memory"));
			await service.retry();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
		});

		it("wiring that runs the binary in use (an override, a newer user install) counts as OMPdesk's too", async () => {
			const { service, agentDir } = await make();
			await plantTerminalWiring(agentDir, BIN);
			await service.start();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(false);
		});

		it("wiring the user made with their own ai-memory is left alone, and is then the terminal's", async () => {
			const { service, agentDir, prefs } = await make();
			await plantTerminalWiring(agentDir, join("/users", "own", "bin", "ai-memory"));
			await service.start();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
			expect(prefs.terminal).toBe(false);
			expect(service.state().wiring).toEqual({ app: true, terminal: true });
			expect(await service.extensionArgs()).toEqual([]);
		});

		it("a user who connected the terminal (stored true) is never migrated away", async () => {
			const { service, agentDir, prefs, toolsDir } = await make();
			prefs.terminal = true;
			await plantTerminalWiring(agentDir, join(toolsDir, "ai-memory", "3.0.0", "ai-memory"));
			await service.start();
			expect(existsSync(join(agentDir, EXTENSION_FILE))).toBe(true);
			expect(prefs.terminal).toBe(true);
		});
	});

	describe("builds without a managed binary", () => {
		it("a dev build never runs a command: unsupported while on, off while off", async () => {
			const { service, commands, prefs, persistEnabled } = await make({ automatic: false });
			await service.start();
			expect(service.state()).toMatchObject({ phase: "unsupported", enabled: true });
			expect(service.state().detail).toContain("OMP_GUI_AI_MEMORY_BIN");
			await service.setEnabled(false);
			await service.retry();
			await expect(service.purge()).rejects.toThrow("not managed by this build");
			await expect(service.setTerminal(true)).rejects.toThrow("not managed by this build");
			expect(persistEnabled).toHaveBeenCalledWith(false);
			expect(prefs.enabled).toBe(false);
			expect(commands()).toEqual([]);
			prefs.enabled = false;
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
				expect(service.state()).toMatchObject({
					phase: "unsupported",
					detail: "ai-memory has no build for this platform.",
				});
				expect(commands()).toEqual([]);
				service.dispose();
				await rm(w?.root ?? "", RM_TEMP);
			}
		});

		it("an override runs even on an architecture the pin has no build for", async () => {
			const { service, commands, rootDir } = await make({ platform: "darwin", arch: "x64" });
			await service.start();
			expect(commands()).toEqual([PLAN, INIT, SETUP, ...generators(rootDir)]);
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
			expect(w2.calls.length).toBeGreaterThan(3);
			for (const call of w2.calls) expect(call.file).toBe(bin);
			expect(w2.service.state()).toMatchObject({ source: "external", binary: bin, phase: "ready" });
		});

		it("an equal user install is left alone: the app's own copy is staged, and its absence fails clearly", async () => {
			const { w2 } = await externalWorld(AI_MEMORY_VERSION);
			await w2.service.start();
			expect(w2.calls).toEqual([]);
			expect(w2.service.state()).toMatchObject({ phase: "failed" });
			expect(w2.service.state().detail).toMatch(/Memory is not built/);
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

		it("Windows: a shipped binary that does not match its build record fails with that message and runs nothing", async () => {
			const shipped = await mkdtemp(join(tmpdir(), "ai-memory-shipped-"));
			try {
				await writeFile(join(shipped, "ai-memory.exe"), "not the pinned build");
				await writeFile(
					join(shipped, "ai-memory.build.json"),
					JSON.stringify({ binary: "ai-memory.exe", binarySha256: "0".repeat(64) }),
				);
				const { service, calls } = await make({
					platform: "win32",
					arch: "x64",
					binaryOverride: null,
					bundledDir: shipped,
					externalProbe: async () => "0.0.1",
				});
				await service.start();
				expect(service.state().phase).toBe("failed");
				expect(service.state().detail).toMatch(/does not match its build record/);
				expect(calls).toEqual([]);
			} finally {
				await rm(shipped, RM_TEMP);
			}
		});

		it("macOS: a shipped binary re-signed with OMPdesk's certificate stages although its bytes differ from the build record", async () => {
			// The 0.38.x macOS releases: mac-sign.cjs re-signs the nested binary after after-pack checked the build record, so its
			// SHA-256 never matched at run time, staging failed on every launch and memory never started.
			const shipped = await mkdtemp(join(tmpdir(), "ai-memory-shipped-"));
			try {
				await writeFile(join(shipped, "ai-memory"), "the release, re-signed by the packager");
				await writeFile(
					join(shipped, "ai-memory.build.json"),
					JSON.stringify({ binary: "ai-memory", binarySha256: "0".repeat(64) }),
				);
				const checked: string[] = [];
				const { service, calls, toolsDir, rootDir } = await make({
					binaryOverride: null,
					bundledDir: shipped,
					externalProbe: async () => "0.0.1",
					codeRequirement: async file => {
						checked.push(file);
						return null;
					},
				});
				await service.start();
				const staged = join(toolsDir, "ai-memory", `${AI_MEMORY_VERSION}-00000000`, "ai-memory");
				expect(checked).toEqual([join(shipped, "ai-memory")]);
				expect(service.state()).toMatchObject({ phase: "ready", source: "bundled", binary: staged });
				expect(calls.every(call => call.file === staged)).toBe(true);
				expect(await rootComplete(rootDir)).toBe(true);
			} finally {
				await rm(shipped, RM_TEMP);
			}
		});

		it("macOS: a shipped binary that fails OMPdesk's signing requirement fails with codesign's reason and runs nothing", async () => {
			const shipped = await mkdtemp(join(tmpdir(), "ai-memory-shipped-"));
			try {
				await writeFile(join(shipped, "ai-memory"), "signed by someone else");
				await writeFile(
					join(shipped, "ai-memory.build.json"),
					JSON.stringify({ binary: "ai-memory", binarySha256: "0".repeat(64) }),
				);
				const { service, calls } = await make({
					binaryOverride: null,
					bundledDir: shipped,
					externalProbe: async () => "0.0.1",
					codeRequirement: async () => "test-requirement: code failed to satisfy specified code requirement(s)",
				});
				await service.start();
				expect(service.state().phase).toBe("failed");
				expect(service.state().detail).toMatch(
					/is neither the built binary .* nor signed with OMPdesk's certificate \(test-requirement: code failed to satisfy specified code requirement\(s\)\)\. Reinstall OMPdesk\.$/,
				);
				expect(calls).toEqual([]);
			} finally {
				await rm(shipped, RM_TEMP);
			}
		});

		it.runIf(process.platform === "darwin")(
			"macOS: by default the requirement is checked with the real codesign, so an unsigned shipped file is refused",
			async () => {
				const shipped = await mkdtemp(join(tmpdir(), "ai-memory-shipped-"));
				try {
					await writeFile(join(shipped, "ai-memory"), "not signed at all");
					await writeFile(
						join(shipped, "ai-memory.build.json"),
						JSON.stringify({ binary: "ai-memory", binarySha256: "0".repeat(64) }),
					);
					const { service, calls } = await make({
						binaryOverride: null,
						bundledDir: shipped,
						externalProbe: async () => "0.0.1",
					});
					await service.start();
					expect(service.state().phase).toBe("failed");
					expect(service.state().detail).toMatch(/nor signed with OMPdesk's certificate \(.*not signed/s);
					expect(calls).toEqual([]);
				} finally {
					await rm(shipped, RM_TEMP);
				}
			},
		);
	});

	describe("the runtime log", () => {
		it("logs the launch, the binary, every phase change, and a failure with the step it failed in", async () => {
			const lines: { message: string; details: Record<string, unknown> }[] = [];
			const { service, behavior } = await make({ log: (message, details) => lines.push({ message, details }) });
			behavior.setup = () => ({ code: 1, output: "problem: launchd refused\n" });
			await service.start();
			expect(lines[0]).toEqual({
				message: "launch",
				details: {
					enabled: true,
					automatic: true,
					platform: "darwin",
					arch: "arm64",
					bundledDir: null,
					override: BIN,
				},
			});
			expect(lines.find(line => line.message === "binary")?.details).toMatchObject({ source: "bundled", bin: BIN });
			expect(lines.filter(line => line.message === "phase").map(line => line.details.phase)).toEqual([
				"starting",
				"starting",
				"failed",
			]);
			expect(lines.find(line => line.message === "failed")?.details).toEqual({
				step: "wire",
				detail: "setup failed: launchd refused",
				stack: null,
			});
			// The service does not log what did not change (stats, wiring): a retry that gets ready adds its own lines.
			behavior.setup = () => ({ code: 0, output: "setup done\n" });
			await service.retry();
			expect(lines.at(-1)).toMatchObject({ message: "phase", details: { phase: "ready", from: "starting" } });
		});

		it("start() never rejects: an unexpected error becomes the failed phase with Try again, and is logged with its stack", async () => {
			const lines: { message: string; details: Record<string, unknown> }[] = [];
			const { service } = await make({
				log: (message, details) => lines.push({ message, details }),
				agentDir: () => {
					throw new Error("agent dir unreadable");
				},
			});
			await expect(service.start()).resolves.toBeUndefined();
			expect(service.state()).toMatchObject({ enabled: true, phase: "failed", detail: "agent dir unreadable" });
			const failed = lines.find(line => line.message === "failed");
			expect(failed?.details.detail).toBe("agent dir unreadable");
			expect(String(failed?.details.stack)).toContain("agent dir unreadable");
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

		it("a missing root is healed by running setup and the generators again", async () => {
			// The state the service reports, not a clock: the root seen gone, then ready with it back.
			const healed = Promise.withResolvers<void>();
			let removed = false;
			let sawGone = false;
			const { service, rootDir, commands } = await make({
				onState: snapshot => {
					if (!removed) return;
					if (!snapshot.wiring.app) sawGone = true;
					else if (sawGone && snapshot.phase === "ready") healed.resolve();
				},
			});
			await service.start();
			removed = true;
			await rm(rootDir, { recursive: true });
			await healed.promise;
			expect(commands().filter(command => command === SETUP)).toHaveLength(2);
			expect(existsSync(join(rootDir, "index.ts"))).toBe(true);
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
			(states[0] as AiMemoryState).wiring.app = !states[0]?.wiring.app;
			expect(JSON.stringify(states[1])).toBe(before);
			// state() hands out a copy too.
			service.state().wiring.terminal = true;
			expect(service.state().wiring.terminal).toBe(false);
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
			const { service, commands, rootDir } = await make();
			await service.start();
			service.dispose();
			await service.setEnabled(false);
			expect(commands()).toEqual([PLAN, INIT, SETUP, ...generators(rootDir)]);
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

	describe("Bun (Windows starts setup through it)", () => {
		it("without Bun no command runs and the state says why; the setup reporting Bun wires it, once, without a Try again", async () => {
			const bun = { present: false };
			const phases: string[] = [];
			const ready = Promise.withResolvers<void>();
			const { service, commands } = await make({
				bunPresent: async () => bun.present,
				onState: snapshot => {
					phases.push(snapshot.phase);
					if (snapshot.phase === "ready") ready.resolve();
				},
			});
			await service.start();
			expect(service.state()).toMatchObject({ phase: "failed", detail: expect.stringMatching(/Waiting for Bun/) });
			expect(commands()).toEqual([]);
			bun.present = true;
			// Every setup state from now on reports Bun present: only the first one runs the wiring again.
			service.bunInstalled();
			service.bunInstalled();
			await ready.promise;
			service.bunInstalled();
			expect(service.state().phase).toBe("ready");
			expect(phases.indexOf("failed")).toBeLessThan(phases.indexOf("ready"));
			expect(commands().filter(command => command === PLAN)).toHaveLength(1);
			expect(commands().filter(command => command === SETUP)).toHaveLength(1);
		});

		it("Bun still missing when it runs again waits again, and the next report runs it", async () => {
			const bun = { present: false, asked: 0 };
			const ready = Promise.withResolvers<void>();
			const { service, commands } = await make({
				bunPresent: async () => {
					bun.asked++;
					return bun.present;
				},
				onState: snapshot => {
					if (snapshot.phase === "ready") ready.resolve();
				},
			});
			await service.start();
			// A user's Try again before the setup installed Bun: the same wait, nothing run.
			await service.retry();
			expect(bun.asked).toBe(2);
			expect(service.state().phase).toBe("failed");
			expect(commands()).toEqual([]);
			bun.present = true;
			service.bunInstalled();
			await ready.promise;
			expect(commands().filter(command => command === SETUP)).toHaveLength(1);
		});

		it("a report of Bun nobody waited for runs nothing", async () => {
			const { service, commands } = await make({ bunPresent: async () => true });
			await service.start();
			const before = commands();
			service.bunInstalled();
			expect(service.state().phase).toBe("ready");
			expect(commands()).toEqual(before);
		});
	});
});
